-- Время заливки листа GAS main (из _Лог, фаза «готово» / «инкремент»).

alter table public.gas_sheet_updates
  add column if not exists duration_ms integer;

comment on column public.gas_sheet_updates.duration_ms is
  'Длительность последней заливки листа, мс (GAS main, Date.now()-started).';

create or replace function private.gas_sheet_touch_impl(
  p_dataset text,
  p_sheet_name text default null,
  p_rows integer default null,
  p_duration_ms integer default null
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

  insert into public.gas_sheet_updates (dataset, sheet_name, rows_written, duration_ms, updated_at)
  values (ds, nullif(btrim(coalesce(p_sheet_name, '')), ''), p_rows, p_duration_ms, now())
  on conflict (dataset) do update
    set
      sheet_name = excluded.sheet_name,
      rows_written = excluded.rows_written,
      duration_ms = excluded.duration_ms,
      updated_at = now()
  returning updated_at into ts;

  return ts;
end;
$$;

create or replace function public.gas_sheet_touch(
  p_dataset text,
  p_sheet_name text default null,
  p_rows integer default null,
  p_duration_ms integer default null
)
returns timestamptz
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.gas_sheet_touch_impl(p_dataset, p_sheet_name, p_rows, p_duration_ms);
$$;

revoke all on function private.gas_sheet_touch_impl(text, text, integer, integer) from public;
revoke all on function public.gas_sheet_touch(text, text, integer, integer) from public;

grant execute on function private.gas_sheet_touch_impl(text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.gas_sheet_touch(text, text, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
