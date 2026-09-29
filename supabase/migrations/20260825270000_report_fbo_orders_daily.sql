-- FBW orders report: qty by article × day. Weight is qty × sheet «Товар+Вес» in GAS.

create index if not exists fbo_orders_report_daily_idx
  on public.fbo_orders (seller_id, order_dt)
  include (nm_id, supplier_article, is_cancel)
  where coalesce(is_cancel, false) = false;

analyze public.fbo_orders;

create or replace function public.report_fbo_orders_daily(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  title text,
  day date,
  qty numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  select
    btrim(coalesce(nullif(btrim(p.vendor_code), ''), o.supplier_article)) as sa_name,
    max(btrim(coalesce(nullif(btrim(p.title), ''), o.supplier_article))) as title,
    (o.order_dt at time zone 'Europe/Moscow')::date as day,
    count(*)::numeric as qty
  from public.fbo_orders o
  left join public.products p
    on p.seller_id = o.seller_id
   and p.nm_id = o.nm_id
  where o.seller_id = p_seller_id
    and o.order_dt >= (p_from::timestamp at time zone 'Europe/Moscow')
    and o.order_dt < ((p_to + 1)::timestamp at time zone 'Europe/Moscow')
    and coalesce(o.is_cancel, false) = false
    and nullif(btrim(coalesce(nullif(btrim(p.vendor_code), ''), o.supplier_article)), '') is not null
    and btrim(coalesce(nullif(btrim(p.vendor_code), ''), o.supplier_article)) <> '-'
  group by 1, 3
  having nullif(max(btrim(coalesce(nullif(btrim(p.title), ''), o.supplier_article))), '') is not null
     and max(btrim(coalesce(nullif(btrim(p.title), ''), o.supplier_article))) <> '-'
  order by 1, 3;
$$;

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
  with fin as (
    select
      btrim(f.sa_name) as sa_name,
      sum(case when f.doc_type_name = 'Возврат' then coalesce(f.quantity, 0) else 0 end) as returns,
      avg(
        case
          when f.doc_type_name = 'Продажа' and coalesce(f.quantity, 0) <> 0
          then f.retail_amount / f.quantity
        end
      ) as avg_price
    from public.finance_rows f
    where f.seller_id = p_seller_id
      and f.rr_dt >= p_from
      and f.rr_dt <= p_to
      and f.doc_type_name in ('Продажа', 'Возврат')
      and nullif(btrim(f.sa_name), '') is not null
    group by 1
  ),
  last_snap as (
    select max(s.snapshot_date) as d
    from public.fbo_stocks s
    where s.seller_id = p_seller_id
  ),
  stk as (
    select
      btrim(p.vendor_code) as sa_name,
      sum(coalesce(s.quantity, 0)) as stocks
    from public.fbo_stocks s
    join last_snap l on s.snapshot_date = l.d
    join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where s.seller_id = p_seller_id
      and nullif(btrim(p.vendor_code), '') is not null
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

comment on function public.report_fbo_orders_daily(uuid, date, date) is
  'Свёртка FBW-заказов: штуки по артикулу × дню, без отмен.';
comment on function public.report_order_article_extras(uuid, date, date) is
  'Возвраты, остатки FBW и цены для отчётов заказов.';

revoke all on function public.report_fbo_orders_daily(uuid, date, date) from public;
revoke all on function public.report_order_article_extras(uuid, date, date) from public;
grant execute on function public.report_fbo_orders_daily(uuid, date, date) to anon, authenticated;
grant execute on function public.report_order_article_extras(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
