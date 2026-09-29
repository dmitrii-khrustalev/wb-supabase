-- Отчёты «К-во Заказов FBS» / «Вес заказов FBS» как в 02_reports:
-- матрица по дням + Итого / Остатки / Продано / В пути / Отменено.
-- Источник: fbs_orders + products + последний снимок fbs_stocks.
-- Вес в GAS: qty × вес из «Товар+Вес».

create or replace function public.report_fbs_orders_daily(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  title text,
  day date,
  qty numeric,
  sold numeric,
  transit numeric,
  cancel numeric,
  stocks numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with ord as (
    select
      btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.article), '')
      )) as sa_name,
      btrim(coalesce(
        nullif(btrim(p.title), ''),
        nullif(btrim(o.article), ''),
        '-'
      )) as title,
      (o.created_at at time zone 'Europe/Moscow')::date as day,
      lower(coalesce(o.wb_status, '')) as wb_status
    from public.fbs_orders o
    left join public.products p
      on p.seller_id = o.seller_id
     and p.nm_id = o.nm_id
    where o.seller_id = p_seller_id
      and o.created_at is not null
      and (o.created_at at time zone 'Europe/Moscow')::date >= p_from
      and (o.created_at at time zone 'Europe/Moscow')::date <= p_to
      and nullif(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(o.article), '')
      )), '') is not null
  ),
  agg as (
    select
      sa_name,
      max(title) as title,
      day,
      count(*)::numeric as qty,
      count(*) filter (
        where wb_status = 'sold'
           or wb_status = 'продано'
      )::numeric as sold,
      count(*) filter (
        where wb_status in ('sorted', 'ready_for_pickup')
           or wb_status like '%отсортир%'
           or wb_status like '%пвз%'
      )::numeric as transit,
      count(*) filter (
        -- WB API: английские коды. declined_* в русской подписи тоже «отменено».
        where wb_status like '%cancel%'
           or wb_status like '%declined%'
           or wb_status like '%отмен%'
      )::numeric as cancel
    from ord
    group by sa_name, day
  ),
  last_stock as (
    select max(s.snapshot_date) as d
    from public.fbs_stocks s
    where s.seller_id = p_seller_id
  ),
  stk as (
    select
      btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendorCode'), ''),
        nullif(btrim(s.sku), '')
      )) as sa_name,
      sum(coalesce(s.amount, 0)) as stocks
    from public.fbs_stocks s
    left join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where s.seller_id = p_seller_id
      and s.snapshot_date = (select d from last_stock)
      and nullif(btrim(coalesce(
        nullif(btrim(p.vendor_code), ''),
        nullif(btrim(s.extra->>'vendorCode'), ''),
        nullif(btrim(s.sku), '')
      )), '') is not null
    group by 1
  )
  select
    a.sa_name,
    a.title,
    a.day,
    a.qty,
    a.sold,
    a.transit,
    a.cancel,
    coalesce(s.stocks, 0) as stocks
  from agg a
  left join stk s on s.sa_name = a.sa_name
  order by 1, 3;
$$;

comment on function public.report_fbs_orders_daily(uuid, date, date) is
  'FBS заказы: артикул × день (qty/sold/transit/cancel) + остатки с последнего снимка.';

grant execute on function public.report_fbs_orders_daily(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
