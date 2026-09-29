-- Отчёт «Поставка_2»: факты WB по артикулам и складам.
-- Регион и вес добавляются в GAS из ручных справочников книги.

create or replace function public.report_postavka_2(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_supply_from date,
  p_supply_to date
)
returns table (
  sa_name text,
  title text,
  warehouse_name text,
  orders_qty numeric,
  stock_qty numeric,
  in_transit_qty numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with par as (
    select
      p_seller_id as seller_id,
      p_from as d_from,
      p_to as d_to,
      p_supply_from as s_from,
      p_supply_to as s_to
  ),
  last_stock as (
    select max(s.snapshot_date) as d
    from public.fbo_stocks s
    join par on s.seller_id = par.seller_id
  ),
  stock as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendor_code'), ''),
        nullif(btrim(s.extra->>'vendorCode'), '')
      ))), 'Х', 'X') as sa_name,
      coalesce(nullif(btrim(s.warehouse_name), ''), 'Не указан') as warehouse_name,
      max(nullif(btrim(p.title), '')) as title,
      sum(coalesce(s.quantity, 0))::numeric as qty
    from public.fbo_stocks s
    join par on s.seller_id = par.seller_id
    join last_stock l on s.snapshot_date = l.d
    left join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where nullif(replace(upper(btrim(coalesce(
      nullif(btrim(p.vendor_code), ''),
      nullif(btrim(s.extra->>'vendor_code'), ''),
      nullif(btrim(s.extra->>'vendorCode'), '')
    ))), 'Х', 'X'), '') is not null
    group by 1, 2
  ),
  orders as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.supplier_article), '')
      ))), 'Х', 'X') as sa_name,
      coalesce(nullif(btrim(o.warehouse_name), ''), 'Не указан') as warehouse_name,
      max(nullif(btrim(p.title), '')) as title,
      count(*)::numeric as qty
    from public.fbo_orders o
    join par on o.seller_id = par.seller_id
    left join public.products p
      on p.seller_id = o.seller_id
     and p.nm_id = o.nm_id
    where o.order_dt >= (par.d_from::timestamp at time zone 'Europe/Moscow')
      and o.order_dt < ((par.d_to + 1)::timestamp at time zone 'Europe/Moscow')
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.supplier_article), '')
      ))), 'Х', 'X'), '') is not null
    group by 1, 2
  ),
  transit as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(g.extra->>'vendorCode'), ''),
        nullif(btrim(g.extra->>'vendor_code'), '')
      ))), 'Х', 'X') as sa_name,
      coalesce(
        nullif(btrim(s.extra->>'warehouseName'), ''),
        nullif(btrim(s.extra->>'actualWarehouseName'), ''),
        'Не указан'
      ) as warehouse_name,
      max(nullif(btrim(p.title), '')) as title,
      sum(coalesce(g.quantity, 0))::numeric as qty
    from public.fbw_supplies s
    join par on s.seller_id = par.seller_id
    join public.fbw_supply_goods g
      on g.seller_id = s.seller_id
     and g.supply_id = s.supply_id
    left join public.products p
      on p.seller_id = g.seller_id
     and p.nm_id = g.nm_id
    where coalesce(s.extra->>'statusID', s.extra->>'statusId', '') is distinct from '5'
      and coalesce(s.extra->>'supplyDate', '') ~ '^\d{4}-\d{2}-\d{2}'
      and left(s.extra->>'supplyDate', 10)::date >= par.s_from
      and left(s.extra->>'supplyDate', 10)::date <= par.s_to
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(g.extra->>'vendorCode'), ''),
        nullif(btrim(g.extra->>'vendor_code'), '')
      ))), 'Х', 'X'), '') is not null
    group by 1, 2
  ),
  keys as (
    select sa_name, warehouse_name from stock
    union
    select sa_name, warehouse_name from orders
    union
    select sa_name, warehouse_name from transit
  )
  select
    k.sa_name,
    coalesce(st.title, od.title, tr.title, k.sa_name) as title,
    k.warehouse_name,
    coalesce(od.qty, 0) as orders_qty,
    coalesce(st.qty, 0) as stock_qty,
    coalesce(tr.qty, 0) as in_transit_qty
  from keys k
  left join stock st using (sa_name, warehouse_name)
  left join orders od using (sa_name, warehouse_name)
  left join transit tr using (sa_name, warehouse_name)
  order by k.sa_name, k.warehouse_name;
$$;

comment on function public.report_postavka_2(uuid, date, date, date, date) is
  'Поставка_2: заказы, последние остатки и FBW в пути по артикулам и складам.';

revoke all on function public.report_postavka_2(uuid, date, date, date, date)
  from public;
grant execute on function public.report_postavka_2(uuid, date, date, date, date)
  to anon, authenticated;

notify pgrst, 'reload schema';
