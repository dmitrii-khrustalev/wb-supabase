-- Отчёт «Поставка_new»: Итого + склад WB (FBO) + склад продавца (FBS).
-- Как 03_postavka3: остатки с последнего снимка (все склады), заказы за A1–A2,
-- в пути = FBW-поставки не «Принято» за A3–A4. Вес в GAS из «Товар+Вес».

create index if not exists fbo_orders_wb_wh_dt_idx
  on public.fbo_orders (seller_id, order_dt)
  where extra->>'warehouseType' = 'Склад WB';

analyze public.fbo_orders;

create or replace function public.report_postavka_new(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_supply_from date,
  p_supply_to date,
  p_days numeric default 30
)
returns table (
  sa_name text,
  title text,
  wb_stock numeric,
  fbs_stock numeric,
  wb_orders numeric,
  fbs_orders numeric,
  in_transit numeric,
  wb_avg numeric,
  fbs_avg numeric,
  sum_avg numeric,
  wb_days numeric,
  fbs_days numeric,
  sum_days numeric,
  wb_vol numeric,
  fbs_vol numeric,
  sum_vol numeric
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
      p_supply_to as s_to,
      coalesce(nullif(p_days, 0), 30) as days_count,
      ((p_to - p_from) + 1)::numeric as date_diff
  ),
  wb_last as (
    select max(s.snapshot_date) as d
    from public.fbo_stocks s
    join par on s.seller_id = par.seller_id
  ),
  fbs_last as (
    select max(s.snapshot_date) as d
    from public.fbs_stocks s
    join par on s.seller_id = par.seller_id
  ),
  wb_stock as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendor_code'), ''),
        nullif(btrim(s.extra->>'vendorCode'), '')
      ))), 'Х', 'X') as sa_name,
      max(nullif(btrim(p.title), '')) as title,
      sum(coalesce(s.quantity, 0)) as qty
    from public.fbo_stocks s
    join par on s.seller_id = par.seller_id
    join wb_last l on s.snapshot_date = l.d
    left join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendor_code'), ''),
        nullif(btrim(s.extra->>'vendorCode'), '')
      ))), 'Х', 'X'), '') is not null
    group by 1
  ),
  fbs_stock as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendorCode'), ''),
        nullif(btrim(s.sku), '')
      ))), 'Х', 'X') as sa_name,
      max(nullif(btrim(coalesce(p.title, s.extra->>'title')), '')) as title,
      sum(coalesce(s.amount, 0)) as qty
    from public.fbs_stocks s
    join par on s.seller_id = par.seller_id
    join fbs_last l on s.snapshot_date = l.d
    left join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendorCode'), ''),
        nullif(btrim(s.sku), '')
      ))), 'Х', 'X'), '') is not null
    group by 1
  ),
  wb_ord as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.supplier_article), '')
      ))), 'Х', 'X') as sa_name,
      max(nullif(btrim(p.title), '')) as title,
      count(*)::numeric as qty
    from public.fbo_orders o
    join par on o.seller_id = par.seller_id
    left join public.products p
      on p.seller_id = o.seller_id
     and p.nm_id = o.nm_id
    where o.order_dt >= (par.d_from::timestamp at time zone 'Europe/Moscow')
      and o.order_dt < ((par.d_to + 1)::timestamp at time zone 'Europe/Moscow')
      and coalesce(o.extra->>'warehouseType', '') = 'Склад WB'
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.supplier_article), '')
      ))), 'Х', 'X'), '') is not null
    group by 1
  ),
  fbs_ord as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.article), '')
      ))), 'Х', 'X') as sa_name,
      max(nullif(btrim(coalesce(p.title, o.article)), '')) as title,
      count(*)::numeric as qty
    from public.fbs_orders o
    join par on o.seller_id = par.seller_id
    left join public.products p
      on p.seller_id = o.seller_id
     and p.nm_id = o.nm_id
    where o.created_at >= (par.d_from::timestamp at time zone 'Europe/Moscow')
      and o.created_at < ((par.d_to + 1)::timestamp at time zone 'Europe/Moscow')
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.article), '')
      ))), 'Х', 'X'), '') is not null
    group by 1
  ),
  transit as (
    select
      replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(g.extra->>'vendorCode'), ''),
        nullif(btrim(g.extra->>'vendor_code'), '')
      ))), 'Х', 'X') as sa_name,
      max(nullif(btrim(p.title), '')) as title,
      sum(coalesce(g.quantity, 0)) as qty
    from public.fbw_supplies s
    join par on s.seller_id = par.seller_id
    join public.fbw_supply_goods g
      on g.seller_id = s.seller_id
     and g.supply_id = s.supply_id
    left join public.products p
      on p.seller_id = g.seller_id
     and p.nm_id = g.nm_id
    where coalesce(s.extra->>'statusID', s.extra->>'statusId', '') is distinct from '5'
      and nullif(btrim(coalesce(
        nullif(s.extra->>'warehouseName', ''),
        nullif(s.extra->>'actualWarehouseName', '')
      )), '') is not null
      and coalesce(s.extra->>'supplyDate', '') ~ '^\d{4}-\d{2}-\d{2}'
      and left(s.extra->>'supplyDate', 10)::date >= par.s_from
      and left(s.extra->>'supplyDate', 10)::date <= par.s_to
      and nullif(replace(upper(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(g.extra->>'vendorCode'), ''),
        nullif(btrim(g.extra->>'vendor_code'), '')
      ))), 'Х', 'X'), '') is not null
    group by 1
  ),
  arts as (
    select
      u.sa_name,
      max(u.title) as title
    from (
      select sa_name, title from wb_stock
      union all select sa_name, title from fbs_stock
      union all select sa_name, title from wb_ord
      union all select sa_name, title from fbs_ord
      union all select sa_name, title from transit
    ) u
    where nullif(u.sa_name, '') is not null
    group by 1
  ),
  joined as (
    select
      a.sa_name,
      coalesce(a.title, a.sa_name) as title,
      coalesce(ws.qty, 0) as wb_stock,
      coalesce(fs.qty, 0) as fbs_stock,
      coalesce(wo.qty, 0) as wb_orders,
      coalesce(fo.qty, 0) as fbs_orders,
      coalesce(t.qty, 0) as in_transit,
      par.date_diff,
      par.days_count
    from arts a
    cross join par
    left join wb_stock ws on ws.sa_name = a.sa_name
    left join fbs_stock fs on fs.sa_name = a.sa_name
    left join wb_ord wo on wo.sa_name = a.sa_name
    left join fbs_ord fo on fo.sa_name = a.sa_name
    left join transit t on t.sa_name = a.sa_name
  )
  select
    j.sa_name,
    j.title,
    j.wb_stock,
    j.fbs_stock,
    j.wb_orders,
    j.fbs_orders,
    j.in_transit,
    case when j.date_diff > 0 then round(j.wb_orders / j.date_diff, 2) else 0 end as wb_avg,
    case when j.date_diff > 0 then round(j.fbs_orders / j.date_diff, 2) else 0 end as fbs_avg,
    case when j.date_diff > 0 then round((j.wb_orders + j.fbs_orders) / j.date_diff, 2) else 0 end as sum_avg,
    case
      when j.date_diff > 0 and round(j.wb_orders / j.date_diff, 2) > 0
      then round((j.wb_stock + j.in_transit) / round(j.wb_orders / j.date_diff, 2), 2)
      else 0
    end as wb_days,
    case
      when j.date_diff > 0 and round(j.fbs_orders / j.date_diff, 2) > 0
      then round(j.fbs_stock / round(j.fbs_orders / j.date_diff, 2), 2)
      else 0
    end as fbs_days,
    case
      when j.date_diff > 0 and round((j.wb_orders + j.fbs_orders) / j.date_diff, 2) > 0
      then round(
        (j.wb_stock + j.fbs_stock + j.in_transit)
        / round((j.wb_orders + j.fbs_orders) / j.date_diff, 2),
        2
      )
      else 0
    end as sum_days,
    case
      when j.date_diff > 0
       and round(
         round(j.wb_orders / j.date_diff, 2) * j.days_count
         - j.wb_stock - j.in_transit
       ) > 0
      then round(
        round(j.wb_orders / j.date_diff, 2) * j.days_count
        - j.wb_stock - j.in_transit
      )
      else null
    end as wb_vol,
    case
      when j.date_diff > 0
       and round(
         round(j.fbs_orders / j.date_diff, 2) * j.days_count
         - j.fbs_stock
       ) > 0
      then round(
        round(j.fbs_orders / j.date_diff, 2) * j.days_count
        - j.fbs_stock
      )
      else null
    end as fbs_vol,
    case
      when j.date_diff > 0
       and round(
         round((j.wb_orders + j.fbs_orders) / j.date_diff, 2) * j.days_count
         - j.wb_stock - j.fbs_stock - j.in_transit
       ) > 0
      then round(
        round((j.wb_orders + j.fbs_orders) / j.date_diff, 2) * j.days_count
        - j.wb_stock - j.fbs_stock - j.in_transit
      )
      else null
    end as sum_vol
  from joined j
  order by 1;
$$;

comment on function public.report_postavka_new(uuid, date, date, date, date, numeric) is
  'Поставка_new: остатки WB/FBS, заказы, FBW в пути, среднее/запас/к-во на поставку.';

revoke all on function public.report_postavka_new(uuid, date, date, date, date, numeric)
  from public;
grant execute on function public.report_postavka_new(uuid, date, date, date, date, numeric)
  to anon, authenticated;

notify pgrst, 'reload schema';
