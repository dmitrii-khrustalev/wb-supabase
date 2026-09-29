-- GAS main пишет время заливки листа; панель читает его в колонке GAS.

create table if not exists public.gas_sheet_updates (
  dataset text primary key,
  sheet_name text,
  rows_written integer,
  updated_at timestamptz not null default now()
);

comment on table public.gas_sheet_updates is
  'Последняя заливка листа GAS main. Пишет скрипт книги через gas_sheet_touch.';

alter table public.gas_sheet_updates enable row level security;
revoke all on table public.gas_sheet_updates from public, anon, authenticated;
grant select, insert, update on table public.gas_sheet_updates to service_role;

create or replace function private.gas_sheet_touch_impl(
  p_dataset text,
  p_sheet_name text default null,
  p_rows integer default null
)
returns timestamptz
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  ts timestamptz;
  ds text;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  insert into public.gas_sheet_updates (dataset, sheet_name, rows_written, updated_at)
  values (ds, nullif(btrim(coalesce(p_sheet_name, '')), ''), p_rows, now())
  on conflict (dataset) do update
    set
      sheet_name = excluded.sheet_name,
      rows_written = excluded.rows_written,
      updated_at = now()
  returning updated_at into ts;

  return ts;
end;
$$;

create or replace function public.gas_sheet_touch(
  p_dataset text,
  p_sheet_name text default null,
  p_rows integer default null
)
returns timestamptz
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.gas_sheet_touch_impl(p_dataset, p_sheet_name, p_rows);
$$;

revoke all on function private.gas_sheet_touch_impl(text, text, integer) from public;
revoke all on function public.gas_sheet_touch(text, text, integer) from public;

grant execute on function private.gas_sheet_touch_impl(text, text, integer)
  to anon, authenticated, service_role;
grant execute on function public.gas_sheet_touch(text, text, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
