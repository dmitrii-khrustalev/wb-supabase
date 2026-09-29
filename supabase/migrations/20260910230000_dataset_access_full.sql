-- Полная модель доступа: locked-by-default для новых кабинетов, grant + GAS.

alter table public.sellers
  add column if not exists datasets_locked_default boolean not null default false;

comment on column public.sellers.datasets_locked_default is
  'true: датасет выключен, пока нет строки enabled=true в sync_dataset_access. false (main): включён, пока нет enabled=false.';

create or replace function public.dataset_access_enabled(p_seller_id uuid, p_dataset text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select a.enabled
      from public.sync_dataset_access a
      where a.seller_id = p_seller_id
        and a.dataset = p_dataset
    ),
    not (
      select s.datasets_locked_default
      from public.sellers s
      where s.id = p_seller_id
    )
  );
$$;

create or replace function public.sync_dataset_set_access(
  p_slug text,
  p_dataset text,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  ds text;
  locked boolean;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  select id, datasets_locked_default into sid, locked
  from public.sellers
  where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;

  if p_enabled then
    if locked then
      insert into public.sync_dataset_access (seller_id, dataset, enabled, updated_at)
      values (sid, ds, true, now())
      on conflict (seller_id, dataset) do update
        set enabled = true, updated_at = now();
    else
      delete from public.sync_dataset_access
      where seller_id = sid and dataset = ds;
    end if;
    return;
  end if;

  if locked then
    delete from public.sync_dataset_access
    where seller_id = sid and dataset = ds;
  else
    insert into public.sync_dataset_access (seller_id, dataset, enabled, updated_at)
    values (sid, ds, false, now())
    on conflict (seller_id, dataset) do update
      set enabled = false, updated_at = now();
  end if;
end;
$$;

create or replace function public.grant_dataset_access(p_slug text, p_dataset text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  ds text;
  hist_done boolean;
  n_hist integer := 0;
  n_daily integer := 0;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;
  if not (ds = any (public.wb_datasets())) then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  select id into sid from public.sellers where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;

  perform public.sync_dataset_set_access(p_slug, ds, true);

  select exists (
    select 1
    from public.sync_jobs j
    where j.seller_id = sid
      and j.dataset = ds
      and j.mode = 'history'
      and j.status = 'done'
  ) into hist_done;

  if not hist_done then
    n_hist := public.enqueue_one_job(sid, ds, 'history');
  end if;

  n_daily := public.enqueue_one_job(sid, ds, 'daily');

  return jsonb_build_object(
    'slug', p_slug,
    'dataset', ds,
    'enabled', true,
    'history_done', hist_done,
    'history_enqueued', (not hist_done and n_hist > 0),
    'daily_enqueued', n_daily > 0
  );
end;
$$;

create or replace function public.list_dataset_access(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'slug', s.slug,
    'datasets_locked_default', s.datasets_locked_default,
    'datasets', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'dataset', d.dataset,
            'enabled', public.dataset_access_enabled(s.id, d.dataset)
          )
          order by d.ord
        )
        from unnest(public.wb_datasets()) with ordinality as d(dataset, ord)
      ),
      '[]'::jsonb
    )
  )
  from public.sellers s
  where s.slug = p_slug;
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
        when l.dataset in ('products', 'fbs_warehouses', 'fbs_offices') then
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

revoke all on function public.grant_dataset_access(text, text) from public, anon, authenticated;
revoke all on function public.list_dataset_access(text) from public;
grant execute on function public.grant_dataset_access(text, text) to service_role;
grant execute on function public.list_dataset_access(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
