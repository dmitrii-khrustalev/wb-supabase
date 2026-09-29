-- Ср. цена как в 02_reports: AVG(цена строки × qty) по Продажам.
-- Цена строки — retail_price_withdisc / retail_price из отчёта WB
-- (то же, что «Сумма по текущей цене» в момент продажи), не текущая карточка.

create or replace function public.report_order_article_extras(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  returns numeric,
  stocks numeric,
  avg_price numeric,
  current_price numeric
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
        nullif(f.extra->>'retail_price_withdisc_rub', '')::numeric,
        nullif(f.payload->>'retail_price_withdisc_rub', '')::numeric,
        nullif(f.extra->>'retailPriceWithDiscRub', '')::numeric,
        nullif(f.payload->>'retailPriceWithDiscRub', '')::numeric,
        nullif(f.extra->>'retail_price', '')::numeric,
        nullif(f.payload->>'retail_price', '')::numeric,
        nullif(f.extra->>'retailPrice', '')::numeric,
        nullif(f.payload->>'retailPrice', '')::numeric,
        p.discounted_price
      ) as hist_price
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
      round(
        avg(
          case
            when doc_type_name = 'Продажа'
             and coalesce(hist_price, 0) > 0
             and quantity > 0
            then hist_price * quantity
          end
        )::numeric,
        2
      ) as avg_price
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
      sum(coalesce(s.quantity, 0)) as stocks
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
    fin.avg_price,
    cur.current_price
  from fin
  full join stk on stk.sa_name = fin.sa_name
  full join cur on cur.sa_name = coalesce(fin.sa_name, stk.sa_name);
$$;

comment on function public.report_order_article_extras(uuid, date, date) is
  'Возвраты, остатки FBW, Ср. цена из цены строки WB (не текущая карточка), Текущ цена из Товары.';

grant execute on function public.report_order_article_extras(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
