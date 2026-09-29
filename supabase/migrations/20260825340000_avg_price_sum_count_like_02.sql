-- Ср. цена как в 02_reports: по артикулу
--   round( Σ(Сумма по текущей цене) / число продаж с ценой > 0, 2 )
-- Сумма по текущей цене = цена со скидкой из карточки × quantity в строке Продажа.
-- Округление до 2 знаков — в GAS, как Math.round(x*100)/100.

drop function if exists public.report_order_article_extras(uuid, date, date);

create function public.report_order_article_extras(
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
      coalesce(p.discounted_price, 0) * coalesce(f.quantity, 0) as amount_at_price
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
  'Как 02_reports: price_sum / price_count = среднее «Сумма по текущей цене» по продажам.';

grant execute on function public.report_order_article_extras(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
