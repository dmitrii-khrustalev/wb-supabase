-- Weekly dashboard for Google Sheets «info weekly».
-- Same blocks as report_info_daily: last complete Mon–Sun vs previous week
-- vs 30-day daily average scaled to 7 days (stocks: plain 30-day average).

create or replace function public.report_info_weekly(
  p_seller_id uuid,
  p_week_end date default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '60s'
as $$
  with params as (
    select
      p_seller_id as seller_id,
      (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date as today,
      coalesce(
        p_week_end,
        (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date
          - extract(isodow from (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date)::int
      ) as raw_end
  ),
  bounds as (
    select
      p.seller_id,
      p.today,
      (date_trunc('week', p.raw_end)::date + 6) as week_end
    from params p
  ),
  meta as (
    select
      b.seller_id,
      b.today,
      b.week_end as day,
      (b.week_end - 6) as week_start,
      (b.week_end - 7) as prev_day,
      (b.week_end - 13) as prev_week_start,
      (b.week_end - 6 - 30) as avg_from,
      (b.week_end - 7) as avg_to,
      least(date '2026-03-16', b.week_end - 6 - 30) as journal_from,
      s.slug,
      s.name as seller_name
    from bounds b
    join public.sellers s on s.id = b.seller_id
  ),
  days as (
    select generate_series(m.journal_from, m.day, '1 day'::interval)::date as d
    from meta m
  ),
  fin_by_day as (
    select
      f.rr_dt as d,
      sum(
        case f.doc_type_name
          when 'Продажа' then coalesce(f.quantity, 0)
          when 'Возврат' then -coalesce(f.quantity, 0)
          else 0
        end
      ) as qty_net,
      sum(case when f.doc_type_name = 'Продажа' then coalesce(f.quantity, 0) else 0 end) as qty_sales,
      sum(case when f.doc_type_name = 'Возврат' then coalesce(f.quantity, 0) else 0 end) as qty_returns,
      sum(
        case f.doc_type_name
          when 'Продажа' then coalesce(f.retail_amount, 0)
          when 'Возврат' then -coalesce(f.retail_amount, 0)
          else 0
        end
      ) as retail_net,
      sum(private.num_text(f.extra->>'ppvz_for_pay')) as for_pay,
      sum(private.num_text(f.extra->>'ppvz_sales_commission')) as commission,
      sum(private.num_text(f.extra->>'delivery_rub')) as logistics,
      sum(private.num_text(f.extra->>'storage_fee')) as storage,
      sum(private.num_text(f.extra->>'acceptance')) as acceptance,
      sum(private.num_text(f.extra->>'acquiring_fee')) as acquiring,
      sum(private.num_text(f.extra->>'additional_payment')) as additional,
      sum(private.num_text(f.extra->>'deduction')) as deduction,
      sum(private.num_text(f.extra->>'penalty')) as penalty
    from public.finance_rows f
    join meta m on f.seller_id = m.seller_id
    where f.rr_dt >= m.journal_from
      and f.rr_dt <= m.day
    group by 1
  ),
  ads_by_day as (
    select
      a.stat_date as d,
      sum(coalesce(a.clicks, 0) * coalesce(a.cpc, 0)) as spend,
      sum(coalesce(a.views, 0)) as views,
      sum(coalesce(a.clicks, 0)) as clicks,
      sum(coalesce(a.orders, 0)) as adv_orders,
      sum(coalesce(a.atbs, 0)) as atbs
    from public.adv_stats a
    join meta m on a.seller_id = m.seller_id
    where a.stat_date >= m.journal_from
      and a.stat_date <= m.day
    group by 1
  ),
  fbo_by_day as (
    select
      (o.order_dt at time zone 'Europe/Moscow')::date as d,
      count(*) filter (where coalesce(o.is_cancel, false) = false) as orders,
      count(*) filter (where coalesce(o.is_cancel, false) = true) as cancels,
      sum(coalesce(o.finished_price, 0)) filter (where coalesce(o.is_cancel, false) = false) as order_sum
    from public.fbo_orders o
    join meta m on o.seller_id = m.seller_id
    where o.order_dt >= (m.journal_from::timestamp at time zone 'Europe/Moscow')
      and o.order_dt < ((m.day + 1)::timestamp at time zone 'Europe/Moscow')
    group by 1
  ),
  fbs_by_day as (
    select
      (o.created_at at time zone 'Europe/Moscow')::date as d,
      count(*) as orders,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) like '%cancel%'
           or lower(coalesce(o.wb_status, '')) like '%declined%'
           or lower(coalesce(o.wb_status, '')) like '%отмен%'
      ) as cancels,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) in ('sold', 'продано')
      ) as sold,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) in ('sorted', 'ready_for_pickup')
           or lower(coalesce(o.wb_status, '')) like '%отсортир%'
           or lower(coalesce(o.wb_status, '')) like '%пвз%'
      ) as sorted,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) = 'waiting'
      ) as waiting
    from public.fbs_orders o
    join meta m on o.seller_id = m.seller_id
    where o.created_at is not null
      and (o.created_at at time zone 'Europe/Moscow')::date >= m.journal_from
      and (o.created_at at time zone 'Europe/Moscow')::date <= m.day
    group by 1
  ),
  fbo_stock_by_day as (
    select
      s.snapshot_date as d,
      sum(coalesce(s.quantity, 0)) as qty,
      count(distinct s.nm_id) filter (where coalesce(s.quantity, 0) > 0) as arts,
      sum(private.num_text(s.extra->>'inWayToClient')) as in_way_to,
      sum(private.num_text(s.extra->>'inWayFromClient')) as in_way_from
    from public.fbo_stocks s
    join meta m on s.seller_id = m.seller_id
    where s.snapshot_date >= m.journal_from
      and s.snapshot_date <= m.today
    group by 1
  ),
  fbs_stock_by_day as (
    select
      s.snapshot_date as d,
      sum(coalesce(s.amount, 0)) as qty
    from public.fbs_stocks s
    join meta m on s.seller_id = m.seller_id
    where s.snapshot_date >= m.journal_from
      and s.snapshot_date <= m.today
    group by 1
  ),
  grid as (
    select
      d.d,
      coalesce(f.qty_net, 0) as qty_net,
      coalesce(f.qty_sales, 0) as qty_sales,
      coalesce(f.qty_returns, 0) as qty_returns,
      coalesce(f.retail_net, 0) as retail_net,
      coalesce(f.for_pay, 0) as for_pay,
      coalesce(f.commission, 0) as commission,
      coalesce(f.logistics, 0) as logistics,
      coalesce(f.storage, 0) as storage,
      coalesce(f.acceptance, 0) as acceptance,
      coalesce(f.acquiring, 0) as acquiring,
      coalesce(f.additional, 0) as additional,
      coalesce(f.deduction, 0) as deduction,
      coalesce(f.penalty, 0) as penalty,
      coalesce(a.spend, 0) as ads_spend,
      coalesce(a.views, 0) as ads_views,
      coalesce(a.clicks, 0) as ads_clicks,
      coalesce(a.adv_orders, 0) as ads_orders,
      coalesce(a.atbs, 0) as ads_atbs,
      coalesce(o.orders, 0) as fbo_orders,
      coalesce(o.cancels, 0) as fbo_cancels,
      coalesce(o.order_sum, 0) as fbo_sum,
      coalesce(b.orders, 0) as fbs_orders,
      coalesce(b.cancels, 0) as fbs_cancels,
      coalesce(b.sold, 0) as fbs_sold,
      coalesce(b.sorted, 0) as fbs_sorted,
      coalesce(b.waiting, 0) as fbs_waiting,
      stk.qty as fbo_stock,
      stk.arts as fbo_arts,
      stk.in_way_to,
      stk.in_way_from,
      fbsstk.qty as fbs_stock
    from days d
    left join fin_by_day f on f.d = d.d
    left join ads_by_day a on a.d = d.d
    left join fbo_by_day o on o.d = d.d
    left join fbs_by_day b on b.d = d.d
    left join fbo_stock_by_day stk on stk.d = d.d
    left join fbs_stock_by_day fbsstk on fbsstk.d = d.d
  ),
  cur as (
    select
      sum(g.qty_net) as qty_net,
      sum(g.qty_sales) as qty_sales,
      sum(g.qty_returns) as qty_returns,
      sum(g.retail_net) as retail_net,
      sum(g.for_pay) as for_pay,
      sum(g.commission) as commission,
      sum(g.logistics) as logistics,
      sum(g.storage) as storage,
      sum(g.acceptance) as acceptance,
      sum(g.acquiring) as acquiring,
      sum(g.additional) as additional,
      sum(g.deduction) as deduction,
      sum(g.penalty) as penalty,
      sum(g.ads_spend) as ads_spend,
      sum(g.ads_views) as ads_views,
      sum(g.ads_clicks) as ads_clicks,
      sum(g.ads_orders) as ads_orders,
      sum(g.ads_atbs) as ads_atbs,
      sum(g.fbo_orders) as fbo_orders,
      sum(g.fbo_cancels) as fbo_cancels,
      sum(g.fbo_sum) as fbo_sum,
      sum(g.fbs_orders) as fbs_orders,
      sum(g.fbs_cancels) as fbs_cancels,
      sum(g.fbs_sold) as fbs_sold,
      sum(g.fbs_sorted) as fbs_sorted,
      sum(g.fbs_waiting) as fbs_waiting,
      (array_agg(g.fbo_stock order by g.d desc) filter (where g.fbo_stock is not null))[1] as fbo_stock,
      (array_agg(g.fbo_arts order by g.d desc) filter (where g.fbo_arts is not null))[1] as fbo_arts,
      (array_agg(g.in_way_to order by g.d desc) filter (where g.in_way_to is not null))[1] as in_way_to,
      (array_agg(g.in_way_from order by g.d desc) filter (where g.in_way_from is not null))[1] as in_way_from,
      (array_agg(g.fbs_stock order by g.d desc) filter (where g.fbs_stock is not null))[1] as fbs_stock
    from grid g
    join meta m on g.d >= m.week_start and g.d <= m.day
  ),
  prev as (
    select
      sum(g.qty_net) as qty_net,
      sum(g.qty_returns) as qty_returns,
      sum(g.retail_net) as retail_net,
      sum(g.for_pay) as for_pay,
      sum(g.commission) as commission,
      sum(g.logistics) as logistics,
      sum(g.storage) as storage,
      sum(g.acceptance) as acceptance,
      sum(g.acquiring) as acquiring,
      sum(g.deduction) as deduction,
      sum(g.penalty) as penalty,
      sum(g.ads_spend) as ads_spend,
      sum(g.ads_views) as ads_views,
      sum(g.ads_clicks) as ads_clicks,
      sum(g.ads_orders) as ads_orders,
      sum(g.fbo_orders) as fbo_orders,
      sum(g.fbo_cancels) as fbo_cancels,
      sum(g.fbo_sum) as fbo_sum,
      sum(g.fbs_orders) as fbs_orders,
      sum(g.fbs_cancels) as fbs_cancels,
      sum(g.fbs_sorted) as fbs_sorted,
      sum(g.fbs_waiting) as fbs_waiting,
      (array_agg(g.fbo_stock order by g.d desc) filter (where g.fbo_stock is not null))[1] as fbo_stock,
      (array_agg(g.fbo_arts order by g.d desc) filter (where g.fbo_arts is not null))[1] as fbo_arts,
      (array_agg(g.in_way_to order by g.d desc) filter (where g.in_way_to is not null))[1] as in_way_to,
      (array_agg(g.in_way_from order by g.d desc) filter (where g.in_way_from is not null))[1] as in_way_from,
      (array_agg(g.fbs_stock order by g.d desc) filter (where g.fbs_stock is not null))[1] as fbs_stock
    from grid g
    join meta m on g.d >= m.prev_week_start and g.d <= m.prev_day
  ),
  avg30 as (
    select
      sum(g.qty_net) * 7.0 / 30.0 as qty_net,
      sum(g.qty_returns) * 7.0 / 30.0 as qty_returns,
      sum(g.retail_net) * 7.0 / 30.0 as retail_net,
      sum(g.for_pay) * 7.0 / 30.0 as for_pay,
      sum(g.ads_spend) * 7.0 / 30.0 as ads_spend,
      sum(g.fbo_orders) * 7.0 / 30.0 as fbo_orders,
      sum(g.fbs_orders) * 7.0 / 30.0 as fbs_orders,
      sum(g.commission) * 7.0 / 30.0 as commission,
      sum(g.logistics) * 7.0 / 30.0 as logistics,
      sum(g.storage) * 7.0 / 30.0 as storage,
      sum(g.acceptance) * 7.0 / 30.0 as acceptance,
      sum(g.acquiring) * 7.0 / 30.0 as acquiring,
      sum(g.deduction) * 7.0 / 30.0 as deduction,
      sum(g.penalty) * 7.0 / 30.0 as penalty,
      sum(g.ads_views) * 7.0 / 30.0 as ads_views,
      sum(g.ads_clicks) * 7.0 / 30.0 as ads_clicks,
      sum(g.ads_orders) * 7.0 / 30.0 as ads_orders,
      sum(g.fbo_cancels) * 7.0 / 30.0 as fbo_cancels,
      sum(g.fbo_sum) * 7.0 / 30.0 as fbo_sum,
      sum(g.fbs_cancels) * 7.0 / 30.0 as fbs_cancels,
      sum(g.fbs_sorted) * 7.0 / 30.0 as fbs_sorted,
      sum(g.fbs_waiting) * 7.0 / 30.0 as fbs_waiting,
      avg(g.fbo_stock) as fbo_stock,
      avg(g.fbo_arts) as fbo_arts,
      avg(g.in_way_to) as in_way_to,
      avg(g.in_way_from) as in_way_from,
      avg(g.fbs_stock) as fbs_stock
    from grid g
    join meta m on true
    where g.d >= m.avg_from
      and g.d <= m.avg_to
  ),
  stocks_now as (
    select
      (select qty from fbo_stock_by_day order by d desc limit 1) as fbo_qty,
      (select arts from fbo_stock_by_day order by d desc limit 1) as fbo_arts,
      (select in_way_to from fbo_stock_by_day order by d desc limit 1) as in_way_to,
      (select in_way_from from fbo_stock_by_day order by d desc limit 1) as in_way_from,
      (select d from fbo_stock_by_day order by d desc limit 1) as fbo_snap,
      (select qty from fbs_stock_by_day order by d desc limit 1) as fbs_qty,
      (select d from fbs_stock_by_day order by d desc limit 1) as fbs_snap
  ),
  supplies as (
    select
      coalesce(s.extra->>'statusID', s.extra->>'statusId', '') as status_id,
      case coalesce(s.extra->>'statusID', s.extra->>'statusId')
        when '1' then 'Не запланировано'
        when '2' then 'Запланировано'
        when '3' then 'Отгрузка разрешена'
        when '4' then 'Идёт приёмка'
        when '5' then 'Принято'
        when '6' then 'Отгружено на воротах'
        else coalesce(s.extra->>'statusID', s.extra->>'statusId', '')
      end as status_name,
      count(*)::integer as supplies,
      coalesce(sum(g.qty), 0) as qty
    from public.fbw_supplies s
    join meta m on s.seller_id = m.seller_id
    left join lateral (
      select sum(coalesce(gg.quantity, 0)) as qty
      from public.fbw_supply_goods gg
      where gg.seller_id = s.seller_id
        and gg.supply_id = s.supply_id
    ) g on true
    group by 1, 2
  ),
  fbs_week as (
    select
      case lower(coalesce(o.wb_status, ''))
        when 'sorted' then 'отсортировано'
        when 'waiting' then 'ожидает'
        when 'ready_for_pickup' then 'готово к выдаче'
        when 'declined_by_client' then 'отказ клиента'
        when 'canceled_by_client' then 'отмена клиента'
        when 'sold' then 'продано'
        else coalesce(nullif(btrim(lower(o.wb_status)), ''), 'без статуса')
      end as status,
      count(*)::integer as n
    from public.fbs_orders o
    join meta m on o.seller_id = m.seller_id
    where o.created_at is not null
      and (o.created_at at time zone 'Europe/Moscow')::date >= m.week_start
      and (o.created_at at time zone 'Europe/Moscow')::date <= m.day
    group by 1
  ),
  load_rows as (
    select
      d.ord,
      d.dataset,
      j.status as job_status,
      j.error as job_error,
      j.updated_at as job_updated_at,
      st.last_success_at,
      public.dataset_data_date(m.seller_id, d.dataset) as data_date
    from meta m
    cross join unnest(public.daily_datasets()) with ordinality as d(dataset, ord)
    left join lateral (
      select sj.status, sj.error, sj.updated_at
      from public.sync_jobs sj
      where sj.seller_id = m.seller_id
        and sj.dataset = d.dataset
        and sj.mode = 'daily'
      order by sj.updated_at desc
      limit 1
    ) j on true
    left join public.sync_state st
      on st.seller_id = m.seller_id
     and st.dataset = d.dataset
  ),
  load_ready as (
    select
      l.*,
      case
        when l.dataset in ('fbo_stocks', 'fbs_stocks', 'products', 'fbs_warehouses', 'fbs_offices')
          then m.today
        else m.today - 1
      end as expected_date,
      (l.last_success_at at time zone 'Europe/Moscow')::date as success_day
    from load_rows l
    cross join meta m
  ),
  load_final as (
    select
      l.ord,
      l.dataset,
      case l.dataset
        when 'finance' then 'Финансовые ежедневные'
        when 'adv_stats' then 'Рекламные расходы'
        when 'fbo_orders' then 'Заказы FBW'
        when 'fbo_stocks' then 'Остатки FBW'
        when 'fbw_supplies' then 'Поставки FBW'
        when 'fbs_stocks' then 'Остатки FBS'
        when 'fbs_orders' then 'Заказы FBS'
        when 'fbs_supplies' then 'Поставки FBS'
        when 'products' then 'Товары'
        when 'fbs_warehouses' then 'Склады FBS'
        when 'fbs_offices' then 'Офисы FBS'
        else l.dataset
      end as sheet_name,
      l.job_status,
      l.data_date,
      l.expected_date,
      case
        when l.job_status is null then false
        when l.job_status in ('queued', 'running') then true
        when l.job_status = 'error' then false
        when l.dataset in ('fbs_orders', 'fbs_supplies', 'fbw_supplies') then
          (l.success_day is not null and l.success_day >= (select today from meta))
          or (l.data_date is not null and l.data_date >= (select today from meta) - 1)
        when l.dataset in ('products', 'fbs_warehouses', 'fbs_offices') then
          l.success_day is not null and l.success_day >= (select today from meta)
        else
          l.data_date is not null and l.data_date >= l.expected_date
      end as fresh,
      case
        when l.job_status is null then 'задания ещё не было'
        when l.job_status in ('queued', 'running') then 'ещё идёт'
        when l.job_status = 'error' then coalesce(left(l.job_error, 80), 'ошибка без текста')
        else null
      end as note
    from load_ready l
  ),
  pack as (
    select
      m.day,
      m.prev_day,
      m.week_start,
      m.prev_week_start,
      m.today,
      m.slug,
      m.seller_name,
      c.qty_net,
      c.qty_sales,
      c.qty_returns,
      c.retail_net,
      c.for_pay,
      c.commission,
      c.logistics,
      c.storage,
      c.acceptance,
      c.acquiring,
      c.additional,
      c.deduction,
      c.penalty,
      c.ads_spend,
      c.ads_views,
      c.ads_clicks,
      c.ads_orders,
      c.ads_atbs,
      c.fbo_orders,
      c.fbo_cancels,
      c.fbo_sum,
      c.fbs_orders,
      c.fbs_cancels,
      c.fbs_sold,
      c.fbs_sorted,
      c.fbs_waiting,
      p.qty_net as qty_prev,
      p.qty_returns as qty_returns_prev,
      p.retail_net as retail_prev,
      p.for_pay as for_pay_prev,
      p.commission as commission_prev,
      p.logistics as logistics_prev,
      p.storage as storage_prev,
      p.acceptance as acceptance_prev,
      p.acquiring as acquiring_prev,
      p.deduction as deduction_prev,
      p.penalty as penalty_prev,
      p.ads_spend as ads_prev,
      p.ads_views as ads_views_prev,
      p.ads_clicks as ads_clicks_prev,
      p.ads_orders as ads_orders_prev,
      p.fbo_orders as fbo_prev,
      p.fbo_cancels as fbo_cancels_prev,
      p.fbo_sum as fbo_sum_prev,
      p.fbs_orders as fbs_prev,
      p.fbs_cancels as fbs_cancels_prev,
      p.fbs_sorted as fbs_sorted_prev,
      p.fbs_waiting as fbs_waiting_prev,
      a.qty_net as qty_avg7,
      a.qty_returns as qty_returns_avg7,
      a.retail_net as retail_avg7,
      a.for_pay as for_pay_avg7,
      a.ads_spend as ads_avg7,
      a.ads_views as ads_views_avg7,
      a.ads_clicks as ads_clicks_avg7,
      a.ads_orders as ads_orders_avg7,
      a.fbo_orders as fbo_avg7,
      a.fbs_orders as fbs_avg7,
      a.logistics as logistics_avg7,
      a.commission as commission_avg7,
      a.storage as storage_avg7,
      a.acceptance as acceptance_avg7,
      a.acquiring as acquiring_avg7,
      a.deduction as deduction_avg7,
      a.penalty as penalty_avg7,
      a.fbo_cancels as fbo_cancels_avg7,
      a.fbo_sum as fbo_sum_avg7,
      a.fbs_cancels as fbs_cancels_avg7,
      a.fbs_sorted as fbs_sorted_avg7,
      a.fbs_waiting as fbs_waiting_avg7,
      c.fbo_stock as fbo_stock_day,
      p.fbo_stock as fbo_stock_prev,
      a.fbo_stock as fbo_stock_avg7,
      c.fbo_arts as fbo_arts_day,
      p.fbo_arts as fbo_arts_prev,
      a.fbo_arts as fbo_arts_avg7,
      c.in_way_to as in_way_to_day,
      p.in_way_to as in_way_to_prev,
      a.in_way_to as in_way_to_avg7,
      c.in_way_from as in_way_from_day,
      p.in_way_from as in_way_from_prev,
      a.in_way_from as in_way_from_avg7,
      c.fbs_stock as fbs_stock_day,
      p.fbs_stock as fbs_stock_prev,
      a.fbs_stock as fbs_stock_avg7,
      sn.fbo_qty as stock_fbo,
      sn.fbo_arts as stock_fbo_arts,
      sn.in_way_to,
      sn.in_way_from,
      sn.fbo_snap,
      sn.fbs_qty as stock_fbs,
      sn.fbs_snap,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status_id', s.status_id,
          'status_name', s.status_name,
          'supplies', s.supplies,
          'qty', round(s.qty, 2)
        ) order by s.status_id), '[]'::jsonb)
        from supplies s
      ) as supplies,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'status', f.status,
          'n', f.n
        ) order by f.n desc), '[]'::jsonb)
        from fbs_week f
      ) as fbs_statuses,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'dataset', lf.dataset,
          'sheet', lf.sheet_name,
          'status', lf.job_status,
          'data_date', lf.data_date,
          'expected_date', lf.expected_date,
          'fresh', lf.fresh,
          'note', lf.note
        ) order by lf.ord), '[]'::jsonb)
        from load_final lf
      ) as loads,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'day', w.week_start,
          'week_end', w.week_start + 6,
          'qty', round(w.qty_net, 2),
          'retail', round(w.retail_net, 2),
          'for_pay', round(w.for_pay, 2),
          'ads', round(w.ads_spend, 2),
          'drr', case when w.retail_net <> 0 then round(w.ads_spend / w.retail_net, 4) else null end,
          'fbo', w.fbo_orders,
          'fbs', w.fbs_orders,
          'fbo_cancels', w.fbo_cancels,
          'fbs_cancels', w.fbs_cancels,
          'fbo_stock', w.fbo_stock,
          'fbs_stock', w.fbs_stock
        ) order by w.week_start desc), '[]'::jsonb)
        from (
          select
            date_trunc('week', g.d)::date as week_start,
            sum(g.qty_net) as qty_net,
            sum(g.retail_net) as retail_net,
            sum(g.for_pay) as for_pay,
            sum(g.ads_spend) as ads_spend,
            sum(g.fbo_orders) as fbo_orders,
            sum(g.fbs_orders) as fbs_orders,
            sum(g.fbo_cancels) as fbo_cancels,
            sum(g.fbs_cancels) as fbs_cancels,
            (array_agg(g.fbo_stock order by g.d desc) filter (where g.fbo_stock is not null))[1] as fbo_stock,
            (array_agg(g.fbs_stock order by g.d desc) filter (where g.fbs_stock is not null))[1] as fbs_stock
          from grid g
          group by 1
        ) w
      ) as journal
    from meta m
    cross join cur c
    left join prev p on true
    cross join avg30 a
    cross join stocks_now sn
  )
  select jsonb_build_object(
    'grain', 'week',
    'day', p.day,
    'prev_day', p.prev_day,
    'week_start', p.week_start,
    'prev_week_start', p.prev_week_start,
    'today', p.today,
    'slug', p.slug,
    'seller_name', p.seller_name,
    'updated_at', to_char(pg_catalog.timezone('Europe/Moscow', pg_catalog.now()), 'YYYY-MM-DD HH24:MI'),
    'kpi', jsonb_build_object(
      'qty', round(p.qty_net, 2),
      'qty_prev', round(coalesce(p.qty_prev, 0), 2),
      'qty_avg7', round(coalesce(p.qty_avg7, 0), 2),
      'retail', round(p.retail_net, 2),
      'retail_prev', round(coalesce(p.retail_prev, 0), 2),
      'retail_avg7', round(coalesce(p.retail_avg7, 0), 2),
      'for_pay', round(p.for_pay, 2),
      'for_pay_prev', round(coalesce(p.for_pay_prev, 0), 2),
      'for_pay_avg7', round(coalesce(p.for_pay_avg7, 0), 2),
      'ads', round(p.ads_spend, 2),
      'ads_prev', round(coalesce(p.ads_prev, 0), 2),
      'ads_avg7', round(coalesce(p.ads_avg7, 0), 2),
      'drr', case when p.retail_net <> 0 then round(p.ads_spend / p.retail_net, 4) else null end,
      'drr_prev', case when coalesce(p.retail_prev, 0) <> 0 then round(p.ads_prev / p.retail_prev, 4) else null end,
      'drr_avg7', case when coalesce(p.retail_avg7, 0) <> 0 then round(p.ads_avg7 / p.retail_avg7, 4) else null end,
      'orders', p.fbo_orders + p.fbs_orders,
      'orders_prev', coalesce(p.fbo_prev, 0) + coalesce(p.fbs_prev, 0),
      'orders_avg7', round(coalesce(p.fbo_avg7, 0) + coalesce(p.fbs_avg7, 0), 2)
    ),
    'finance', jsonb_build_object(
      'qty', round(p.qty_net, 2),
      'qty_sales', round(p.qty_sales, 2),
      'qty_returns', round(p.qty_returns, 2),
      'qty_returns_prev', round(coalesce(p.qty_returns_prev, 0), 2),
      'qty_returns_avg7', round(coalesce(p.qty_returns_avg7, 0), 2),
      'retail', round(p.retail_net, 2),
      'avg_check', case when p.qty_net <> 0 then round(p.retail_net / p.qty_net, 2) else null end,
      'avg_check_prev', case when coalesce(p.qty_prev, 0) <> 0 then round(p.retail_prev / p.qty_prev, 2) else null end,
      'avg_check_avg7', case when coalesce(p.qty_avg7, 0) <> 0 then round(p.retail_avg7 / p.qty_avg7, 2) else null end,
      'for_pay', round(p.for_pay, 2),
      'commission', round(p.commission, 2),
      'commission_prev', round(coalesce(p.commission_prev, 0), 2),
      'commission_avg7', round(coalesce(p.commission_avg7, 0), 2),
      'logistics', round(p.logistics, 2),
      'logistics_prev', round(coalesce(p.logistics_prev, 0), 2),
      'logistics_avg7', round(coalesce(p.logistics_avg7, 0), 2),
      'storage', round(p.storage, 2),
      'storage_prev', round(coalesce(p.storage_prev, 0), 2),
      'storage_avg7', round(coalesce(p.storage_avg7, 0), 2),
      'acceptance', round(p.acceptance, 2),
      'acceptance_prev', round(coalesce(p.acceptance_prev, 0), 2),
      'acceptance_avg7', round(coalesce(p.acceptance_avg7, 0), 2),
      'acquiring', round(p.acquiring, 2),
      'acquiring_prev', round(coalesce(p.acquiring_prev, 0), 2),
      'acquiring_avg7', round(coalesce(p.acquiring_avg7, 0), 2),
      'additional', round(p.additional, 2),
      'deduction', round(p.deduction, 2),
      'deduction_prev', round(coalesce(p.deduction_prev, 0), 2),
      'deduction_avg7', round(coalesce(p.deduction_avg7, 0), 2),
      'penalty', round(p.penalty, 2),
      'penalty_prev', round(coalesce(p.penalty_prev, 0), 2),
      'penalty_avg7', round(coalesce(p.penalty_avg7, 0), 2)
    ),
    'ads', jsonb_build_object(
      'spend', round(p.ads_spend, 2),
      'views', round(p.ads_views, 0),
      'views_prev', round(coalesce(p.ads_views_prev, 0), 0),
      'views_avg7', round(coalesce(p.ads_views_avg7, 0), 0),
      'clicks', round(p.ads_clicks, 0),
      'clicks_prev', round(coalesce(p.ads_clicks_prev, 0), 0),
      'clicks_avg7', round(coalesce(p.ads_clicks_avg7, 0), 0),
      'cpc', case when p.ads_clicks <> 0 then round(p.ads_spend / p.ads_clicks, 2) else null end,
      'cpc_prev', case when coalesce(p.ads_clicks_prev, 0) <> 0 then round(p.ads_prev / p.ads_clicks_prev, 2) else null end,
      'cpc_avg7', case when coalesce(p.ads_clicks_avg7, 0) <> 0 then round(p.ads_avg7 / p.ads_clicks_avg7, 2) else null end,
      'ctr', case when p.ads_views <> 0 then round(p.ads_clicks / p.ads_views, 4) else null end,
      'ctr_prev', case when coalesce(p.ads_views_prev, 0) <> 0 then round(p.ads_clicks_prev / p.ads_views_prev, 4) else null end,
      'ctr_avg7', case when coalesce(p.ads_views_avg7, 0) <> 0 then round(p.ads_clicks_avg7 / p.ads_views_avg7, 4) else null end,
      'orders', round(p.ads_orders, 0),
      'orders_prev', round(coalesce(p.ads_orders_prev, 0), 0),
      'orders_avg7', round(coalesce(p.ads_orders_avg7, 0), 0),
      'atbs', round(p.ads_atbs, 0),
      'drr', case when p.retail_net <> 0 then round(p.ads_spend / p.retail_net, 4) else null end,
      'after_ads', round(p.for_pay - p.ads_spend, 2),
      'after_ads_prev', round(coalesce(p.for_pay_prev, 0) - coalesce(p.ads_prev, 0), 2),
      'after_ads_avg7', round(coalesce(p.for_pay_avg7, 0) - coalesce(p.ads_avg7, 0), 2)
    ),
    'fbo', jsonb_build_object(
      'orders', p.fbo_orders,
      'orders_prev', coalesce(p.fbo_prev, 0),
      'orders_avg7', round(coalesce(p.fbo_avg7, 0), 1),
      'cancels', p.fbo_cancels,
      'cancels_prev', coalesce(p.fbo_cancels_prev, 0),
      'cancels_avg7', round(coalesce(p.fbo_cancels_avg7, 0), 1),
      'sum', round(p.fbo_sum, 2),
      'sum_prev', round(coalesce(p.fbo_sum_prev, 0), 2),
      'sum_avg7', round(coalesce(p.fbo_sum_avg7, 0), 2)
    ),
    'fbs', jsonb_build_object(
      'orders', p.fbs_orders,
      'orders_prev', coalesce(p.fbs_prev, 0),
      'orders_avg7', round(coalesce(p.fbs_avg7, 0), 1),
      'cancels', p.fbs_cancels,
      'cancels_prev', coalesce(p.fbs_cancels_prev, 0),
      'cancels_avg7', round(coalesce(p.fbs_cancels_avg7, 0), 1),
      'sold', p.fbs_sold,
      'sorted', p.fbs_sorted,
      'sorted_prev', coalesce(p.fbs_sorted_prev, 0),
      'sorted_avg7', round(coalesce(p.fbs_sorted_avg7, 0), 1),
      'waiting', p.fbs_waiting,
      'waiting_prev', coalesce(p.fbs_waiting_prev, 0),
      'waiting_avg7', round(coalesce(p.fbs_waiting_avg7, 0), 1),
      'statuses_7d', p.fbs_statuses
    ),
    'stocks', jsonb_build_object(
      'fbo_qty', round(coalesce(p.fbo_stock_day, p.stock_fbo, 0), 0),
      'fbo_qty_prev', round(coalesce(p.fbo_stock_prev, 0), 0),
      'fbo_qty_avg7', round(coalesce(p.fbo_stock_avg7, 0), 0),
      'fbo_arts', coalesce(p.fbo_arts_day, p.stock_fbo_arts, 0),
      'fbo_arts_prev', coalesce(p.fbo_arts_prev, 0),
      'fbo_arts_avg7', round(coalesce(p.fbo_arts_avg7, 0), 1),
      'in_way_to', round(coalesce(p.in_way_to_day, p.in_way_to, 0), 0),
      'in_way_to_prev', round(coalesce(p.in_way_to_prev, 0), 0),
      'in_way_to_avg7', round(coalesce(p.in_way_to_avg7, 0), 0),
      'in_way_from', round(coalesce(p.in_way_from_day, p.in_way_from, 0), 0),
      'in_way_from_prev', round(coalesce(p.in_way_from_prev, 0), 0),
      'in_way_from_avg7', round(coalesce(p.in_way_from_avg7, 0), 0),
      'fbo_snap', p.fbo_snap,
      'fbs_qty', round(coalesce(p.fbs_stock_day, p.stock_fbs, 0), 0),
      'fbs_qty_prev', round(coalesce(p.fbs_stock_prev, 0), 0),
      'fbs_qty_avg7', round(coalesce(p.fbs_stock_avg7, 0), 0),
      'fbs_snap', p.fbs_snap
    ),
    'supplies', p.supplies,
    'loads', p.loads,
    'journal', p.journal
  )
  from pack p;
$$;

comment on function public.report_info_weekly(uuid, date) is
  'Сводка для листа info weekly: последняя полная неделя пн–вс, сравнение с предыдущей и со средней неделей за 30 дней.';

revoke all on function public.report_info_weekly(uuid, date) from public;
grant execute on function public.report_info_weekly(uuid, date) to anon, authenticated;

notify pgrst, 'reload schema';
