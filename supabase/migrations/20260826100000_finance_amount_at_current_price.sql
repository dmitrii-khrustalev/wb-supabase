-- Штамп «Сумма по текущей цене» на строке finance_rows:
-- цена карточки на момент первой записи × qty (как в 01_downloads).
-- Отчёты заказов читают его из RPC — без getDataRange по финлисту в GAS.

alter table public.finance_rows
  add column if not exists amount_at_current_price numeric;

comment on column public.finance_rows.amount_at_current_price is
  'Сумма по текущей цене: discounted_price(карточка) × qty при первой вставке; не перезаписывать.';

create or replace function public.finance_rows_stamp_amount_at_current_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price numeric;
begin
  -- Уже проставленный штамп не трогаем при повторном upsert.
  if tg_op = 'UPDATE'
     and old.amount_at_current_price is not null then
    new.amount_at_current_price := old.amount_at_current_price;
    return new;
  end if;

  if new.amount_at_current_price is not null then
    return new;
  end if;

  if new.doc_type_name not in ('Продажа', 'Возврат') then
    return new;
  end if;

  select p.discounted_price
    into v_price
  from public.products p
  where p.seller_id = new.seller_id
    and p.nm_id = new.nm_id
  limit 1;

  if v_price is null or v_price <= 0 then
    return new;
  end if;

  if new.doc_type_name = 'Продажа' then
    new.amount_at_current_price := v_price * coalesce(new.quantity, 0);
  else
    new.amount_at_current_price := -(v_price * coalesce(new.quantity, 0));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_finance_rows_stamp_amount on public.finance_rows;
create trigger trg_finance_rows_stamp_amount
  before insert or update on public.finance_rows
  for each row
  execute function public.finance_rows_stamp_amount_at_current_price();

-- Ср. цена: штамп строки, иначе живая карточка (fallback).
create or replace function public.report_order_article_extras(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  returns numeric,
  stocks numeric,
  price_sum numeric,
  price_count numeric,
  current_price numeric,
  stock_date date
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with fin_raw as (
    select
      btrim(coalesce(nullif(btrim(p.vendor_code), ''), f.sa_name)) as sa_name,
      f.doc_type_name,
      coalesce(f.quantity, 0) as quantity,
      coalesce(
        f.amount_at_current_price,
        coalesce(p.discounted_price, 0) * coalesce(f.quantity, 0)
      ) as amount_at_price
    from public.finance_rows f
    left join public.products p
      on p.seller_id = f.seller_id
     and p.nm_id = f.nm_id
    where f.seller_id = p_seller_id
      and f.rr_dt >= p_from
      and f.rr_dt <= p_to
      and f.doc_type_name in ('Продажа', 'Возврат')
      and nullif(btrim(coalesce(nullif(btrim(p.vendor_code), ''), f.sa_name)), '') is not null
  ),
  fin as (
    select
      sa_name,
      sum(
        case
          when doc_type_name = 'Возврат' then abs(quantity)
          else 0
        end
      ) as returns,
      sum(
        case
          when doc_type_name = 'Продажа' and amount_at_price > 0
          then amount_at_price
          else 0
        end
      ) as price_sum,
      sum(
        case
          when doc_type_name = 'Продажа' and amount_at_price > 0
          then 1
          else 0
        end
      ) as price_count
    from fin_raw
    group by 1
  ),
  last_pos as (
    select
      btrim(p.vendor_code) as sa_name,
      max(s.snapshot_date) as d
    from public.fbo_stocks s
    join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where s.seller_id = p_seller_id
      and coalesce(s.quantity, 0) > 0
      and nullif(btrim(p.vendor_code), '') is not null
    group by 1
  ),
  stk as (
    select
      l.sa_name,
      sum(coalesce(s.quantity, 0)) as stocks,
      max(l.d) as stock_date
    from last_pos l
    join public.products p
      on p.seller_id = p_seller_id
     and btrim(p.vendor_code) = l.sa_name
    join public.fbo_stocks s
      on s.seller_id = p.seller_id
     and s.nm_id = p.nm_id
     and s.snapshot_date = l.d
    group by 1
  ),
  cur as (
    select
      btrim(p.vendor_code) as sa_name,
      max(p.discounted_price) as current_price
    from public.products p
    where p.seller_id = p_seller_id
      and nullif(btrim(p.vendor_code), '') is not null
    group by 1
  )
  select
    coalesce(fin.sa_name, stk.sa_name, cur.sa_name) as sa_name,
    coalesce(fin.returns, 0) as returns,
    coalesce(stk.stocks, 0) as stocks,
    fin.price_sum,
    fin.price_count,
    cur.current_price,
    stk.stock_date
  from fin
  full join stk on stk.sa_name = fin.sa_name
  full join cur on cur.sa_name = coalesce(fin.sa_name, stk.sa_name);
$$;

comment on function public.report_order_article_extras(uuid, date, date) is
  'Ср. цена: sum/count по amount_at_current_price (штамп), иначе живая карточка × qty.';

grant execute on function public.report_order_article_extras(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
