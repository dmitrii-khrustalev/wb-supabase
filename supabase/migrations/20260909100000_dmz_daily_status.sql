-- DMZ Google Sheets: 13 core daily. Main book: все daily_datasets() (24).

create or replace function public.dmz_daily_datasets()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'products',
    'finance',
    'adv_stats',
    'fbo_orders',
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

comment on function public.dmz_daily_datasets() is
  'Core daily для автозапуска DMZ (13). Main ждёт public.daily_datasets().';

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
        and sj.dataset = e.dataset
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

revoke all on function private.sheet_daily_status_for(text[]) from public;
grant execute on function private.sheet_daily_status_for(text[]) to anon, authenticated;

create or replace function private.sheet_daily_status_impl()
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
  select * from private.sheet_daily_status_for(public.daily_datasets());
$$;

create or replace function private.sheet_dmz_daily_status_impl()
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
  select * from private.sheet_daily_status_for(public.dmz_daily_datasets());
$$;

revoke all on function private.sheet_dmz_daily_status_impl() from public;
grant execute on function private.sheet_dmz_daily_status_impl() to anon, authenticated;

create or replace function public.sheet_daily_status()
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
security invoker
set search_path = pg_catalog, private
as $$
  select * from private.sheet_daily_status_impl();
$$;

comment on function public.sheet_daily_status() is
  'Готовность daily для main: все public.daily_datasets() (Moscow day).';

create or replace function public.sheet_dmz_daily_status()
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
security invoker
set search_path = pg_catalog, private
as $$
  select * from private.sheet_dmz_daily_status_impl();
$$;

comment on function public.sheet_dmz_daily_status() is
  'Готовность daily для DMZ: только public.dmz_daily_datasets() (13 core).';

revoke all on function public.sheet_dmz_daily_status() from public;
grant execute on function public.sheet_dmz_daily_status() to anon, authenticated;

revoke all on function public.dmz_daily_datasets() from public, anon, authenticated;
grant execute on function public.dmz_daily_datasets() to service_role;

notify pgrst, 'reload schema';
