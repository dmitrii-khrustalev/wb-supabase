-- Lightweight load-status payload for the Sheets «info: загрузки» dialog.
-- Same freshness rules as report_info_daily, without KPI / journal.

create or replace function public.report_info_loads(p_seller_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set statement_timeout = '15s'
as $$
  with params as (
    select
      p_seller_id as seller_id,
      (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date as today
  ),
  meta as (
    select
      p.*,
      s.slug,
      s.name as seller_name
    from params p
    join public.sellers s on s.id = p.seller_id
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
      to_char(
        pg_catalog.timezone('Europe/Moscow', l.last_success_at),
        'YYYY-MM-DD HH24:MI'
      ) as loaded_at,
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
  )
  select jsonb_build_object(
    'slug', m.slug,
    'seller_name', m.seller_name,
    'updated_at', to_char(
      pg_catalog.timezone('Europe/Moscow', pg_catalog.now()),
      'YYYY-MM-DD HH24:MI'
    ),
    'loads', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'dataset', lf.dataset,
        'sheet', lf.sheet_name,
        'status', lf.job_status,
        'data_date', lf.data_date,
        'expected_date', lf.expected_date,
        'loaded_at', lf.loaded_at,
        'fresh', lf.fresh,
        'note', lf.note
      ) order by lf.ord), '[]'::jsonb)
      from load_final lf
    )
  )
  from meta m;
$$;

comment on function public.report_info_loads(uuid) is
  'Статус ежедневных загрузок кабинета для диалога info в Google Sheets.';

revoke all on function public.report_info_loads(uuid) from public;
grant execute on function public.report_info_loads(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
