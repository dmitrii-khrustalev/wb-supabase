-- История цен в утренней очереди листов. WB-job нет: готовность = daily products.
-- Галочка книги (main/dmz на сайте) решает, грузить ли лист. В DMZ по умолчанию выкл.

create or replace function public.morning_sync_dataset(p_dataset text)
returns text
language sql
immutable
as $$
  select case p_dataset
    when 'product_prices' then 'products'
    else p_dataset
  end;
$$;

comment on function public.morning_sync_dataset(text) is
  'Датасет sync_jobs/sync_state для утренней свежести. product_prices пишет products.';

create or replace function public.daily_datasets()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'finance',
    'adv_stats',
    'products',
    'product_prices',
    'fbo_stocks',
    'fbs_stocks',
    'stocks_lk',
    'fbo_orders',
    'fbs_orders',
    'fbw_supplies',
    'fbs_supplies',
    'sales_funnel',
    'fbo_sales',
    'region_sales',
    'goods_returns',
    'order_feed',
    'feedbacks',
    'questions',
    'tariffs',
    'wb_retentions',
    'warehouse_services',
    'claims',
    'promos',
    'fbs_warehouses',
    'fbs_offices'
  ];
$$;

create or replace function public.dmz_daily_datasets()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'finance',
    'adv_stats',
    'products',
    'product_prices',
    'fbo_stocks',
    'stocks_lk',
    'fbo_orders',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

comment on function public.daily_datasets() is
  'Daily queue order: finance, adv, products, price history, stocks, orders, supplies, then rest.';
comment on function public.dmz_daily_datasets() is
  'DMZ morning subset in the same priority order as daily_datasets().';

create or replace function private.sheet_daily_status_for(p_datasets text[])
returns table (
  run_date date,
  ready boolean,
  total_jobs integer,
  done_jobs integer,
  error_jobs integer,
  open_jobs integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with params as (
    select
      (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date as run_date,
      (
        (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date::timestamp
        at time zone 'Europe/Moscow'
      ) as day_start
  ),
  expected as (
    select s.id as seller_id, d.dataset
    from public.sellers s
    cross join lateral pg_catalog.unnest(p_datasets) as d(dataset)
    where s.is_active
  ),
  latest as (
    select
      e.seller_id,
      e.dataset,
      j.status,
      j.updated_at
    from expected e
    left join lateral (
      select sj.status, sj.updated_at
      from public.sync_jobs sj
      where sj.seller_id = e.seller_id
        and sj.dataset = public.morning_sync_dataset(e.dataset)
        and sj.mode = 'daily'
      order by sj.updated_at desc
      limit 1
    ) j on true
  ),
  metrics as (
    select
      pg_catalog.count(*)::integer as total_jobs,
      pg_catalog.count(*) filter (
        where l.status = 'done' and l.updated_at >= p.day_start
      )::integer as done_jobs,
      pg_catalog.count(*) filter (
        where l.status = 'error' and l.updated_at >= p.day_start
      )::integer as error_jobs,
      pg_catalog.count(*) filter (
        where l.status in ('queued', 'running')
      )::integer as open_jobs
    from latest l
    cross join params p
  )
  select
    p.run_date,
    (m.total_jobs > 0 and m.done_jobs = m.total_jobs) as ready,
    m.total_jobs,
    m.done_jobs,
    m.error_jobs,
    m.open_jobs
  from params p
  cross join metrics m;
$$;

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
      s.name as seller_name,
      s.datasets_locked_default
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
        and sj.dataset = public.morning_sync_dataset(d.dataset)
        and sj.mode = 'daily'
      order by sj.updated_at desc
      limit 1
    ) j on true
    left join public.sync_state st
      on st.seller_id = m.seller_id
     and st.dataset = public.morning_sync_dataset(d.dataset)
  ),
  load_ready as (
    select
      l.*,
      case
        when l.dataset in (
          'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products', 'product_prices',
          'fbs_warehouses', 'fbs_offices', 'tariffs'
        ) then m.today
        when l.dataset in ('claims', 'promos') then m.today
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
      public.dataset_access_enabled((select seller_id from meta), l.dataset) as access_enabled,
      case l.dataset
        when 'finance' then 'Финансовые ежедневные'
        when 'adv_stats' then 'Рекламные расходы'
        when 'sales_funnel' then 'Воронка продаж'
        when 'fbo_orders' then 'Заказы FBW'
        when 'fbo_sales' then 'Продажи FBW'
        when 'region_sales' then 'Продажи по регионам'
        when 'goods_returns' then 'Возвраты товаров'
        when 'order_feed' then 'Лента заказов'
        when 'feedbacks' then 'Отзывы'
        when 'questions' then 'Вопросы'
        when 'tariffs' then 'Тарифы'
        when 'wb_retentions' then 'Удержания WB'
        when 'warehouse_services' then 'Складские услуги'
        when 'claims' then 'Заявки на возврат'
        when 'promos' then 'Акции'
        when 'fbo_stocks' then 'Остатки FBW'
        when 'stocks_lk' then 'Остатки ЛК'
        when 'fbw_supplies' then 'Поставки FBW'
        when 'fbs_stocks' then 'Остатки FBS'
        when 'fbs_orders' then 'Заказы FBS'
        when 'fbs_supplies' then 'Поставки FBS'
        when 'products' then 'Товары'
        when 'product_prices' then 'История цен'
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
        when l.job_status in ('queued', 'running') then false
        when l.job_status = 'error' then false
        when l.dataset in ('fbs_orders', 'fbs_supplies', 'fbw_supplies') then
          (l.success_day is not null and l.success_day >= (select today from meta))
          or (l.data_date is not null and l.data_date >= (select today from meta) - 1)
        when l.dataset in ('products', 'product_prices', 'fbs_warehouses', 'fbs_offices', 'tariffs') then
          l.success_day is not null and l.success_day >= (select today from meta)
        when l.dataset in ('claims', 'promos') then
          l.success_day is not null and l.success_day >= (select today from meta)
        else
          l.data_date is not null and l.data_date >= l.expected_date
      end as fresh,
      case
        when not public.dataset_access_enabled((select seller_id from meta), l.dataset) then 'доступ закрыт'
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
    'datasets_locked_default', m.datasets_locked_default,
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
        'access_enabled', lf.access_enabled,
        'note', lf.note
      ) order by lf.ord), '[]'::jsonb)
      from load_final lf
    )
  )
  from meta m;
$$;

revoke all on function public.morning_sync_dataset(text) from public;
grant execute on function public.morning_sync_dataset(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
