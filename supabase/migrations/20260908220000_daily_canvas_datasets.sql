-- Canvas-датасеты main: daily + подписи листов в report_info_loads.
-- search_queries по-прежнему не в daily (Jam 403).

create or replace function public.daily_datasets()
returns text[]
language sql
immutable
as $$
  select array[
    'products',
    'finance',
    'adv_stats',
    'fbo_orders',
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
    'fbo_stocks',
    'stocks_lk',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

-- Лист «Акции»: заголовки акций (nm_id='') + товары в акции.
create or replace view public.sheet_promos
with (security_invoker = false) as
select
  seller_id,
  promo_id,
  case when nm_id = '_' then '' else nm_id end as nm_id,
  promo_name,
  promo_type,
  start_dt,
  end_dt,
  description,
  in_action,
  price,
  plan_price,
  discount,
  plan_discount,
  extra,
  loaded_at
from public.promos;

revoke all on table public.sheet_promos from public, anon, authenticated;
grant select on table public.sheet_promos to anon, authenticated;

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
        when l.dataset in (
          'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products', 'fbs_warehouses', 'fbs_offices'
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
        when l.dataset in ('claims', 'promos') then
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

notify pgrst, 'reload schema';
