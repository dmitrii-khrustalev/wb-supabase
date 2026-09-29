-- Bot/site load only into DB; Google Sheets are loaded manually in GAS.
-- Disable the old sheet_load_requests queue and GAS minute-poll path.

create or replace function private.request_sheet_load_impl(p_scope text)
returns bigint
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
begin
  raise exception 'sheet load queue disabled: load in Google manually';
end;
$$;

create or replace function private.sheet_load_claim_impl()
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
begin
  return '{}'::jsonb;
end;
$$;

comment on function public.request_sheet_load(text) is
  'Отключено: бот/сайт грузят только в базу, листы — вручную в Google.';
comment on function public.sheet_load_claim() is
  'Отключено: GAS не забирает заявки из очереди.';

update public.sheet_load_requests
set
  status = 'error',
  error = 'отключено',
  finished_at = coalesce(finished_at, now()),
  notified = true
where status in ('pending', 'running');

notify pgrst, 'reload schema';
