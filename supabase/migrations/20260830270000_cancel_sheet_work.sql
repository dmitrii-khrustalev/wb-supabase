-- Cancel open sheet/WB work without Telegram pings.
-- New bot request replaces previous pending/running rows.

create or replace function private.request_sheet_load_impl(p_scope text)
returns bigint
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  new_id bigint;
begin
  if p_scope is null or (
    p_scope <> 'all' and not (p_scope = any (public.daily_datasets()))
  ) then
    raise exception 'unknown scope: %', p_scope;
  end if;

  update public.sheet_load_requests
  set
    status = 'error',
    error = 'заменено',
    finished_at = coalesce(finished_at, now()),
    notified = true
  where status in ('pending', 'running');

  insert into public.sheet_load_requests (scope)
  values (p_scope)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function private.cancel_sheet_work_impl()
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  req_n integer := 0;
  job_n integer := 0;
  hush_n integer := 0;
begin
  update public.sheet_load_requests
  set
    status = 'error',
    error = 'отменено',
    finished_at = coalesce(finished_at, now()),
    notified = true
  where status in ('pending', 'running');
  get diagnostics req_n = row_count;

  update public.sheet_load_requests
  set notified = true
  where notified = false
    and status in ('done', 'error');
  get diagnostics hush_n = row_count;

  update public.sync_jobs
  set
    status = 'error',
    error = 'отменено',
    finished_at = now()
  where mode = 'daily'
    and status = 'queued';
  get diagnostics job_n = row_count;

  return jsonb_build_object(
    'requests', req_n,
    'jobs', job_n,
    'silenced', hush_n
  );
end;
$$;

create or replace function public.cancel_sheet_work()
returns jsonb
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.cancel_sheet_work_impl();
$$;

revoke all on function private.cancel_sheet_work_impl() from public;
revoke all on function public.cancel_sheet_work() from public, anon, authenticated;
grant execute on function private.cancel_sheet_work_impl() to service_role;
grant execute on function public.cancel_sheet_work() to service_role;

comment on function public.cancel_sheet_work() is
  'Бот: снять заявки на книгу и queued daily-джобы, без Telegram-пина.';

select private.cancel_sheet_work_impl();

notify pgrst, 'reload schema';
