-- GAS (anon JWT) не может вызывать daily_datasets() напрямую.
-- Обёртки sheet_*_status снова идут через security definer impl.

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

notify pgrst, 'reload schema';
