-- Пакетная запись duration_ms из GAS _Лог (backfill).

create or replace function public.gas_sheet_sync_durations(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  item jsonb;
  ds text;
  n integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a json array';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    ds := lower(btrim(coalesce(item->>'dataset', '')));
    if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
      continue;
    end if;
    insert into public.gas_sheet_updates (dataset, sheet_name, rows_written, duration_ms, updated_at)
    values (
      ds,
      nullif(btrim(coalesce(item->>'sheet_name', '')), ''),
      nullif(item->>'rows', '')::integer,
      nullif(item->>'duration_ms', '')::integer,
      coalesce((item->>'updated_at')::timestamptz, now())
    )
    on conflict (dataset) do update
      set
        sheet_name = coalesce(excluded.sheet_name, gas_sheet_updates.sheet_name),
        rows_written = coalesce(excluded.rows_written, gas_sheet_updates.rows_written),
        duration_ms = excluded.duration_ms,
        updated_at = excluded.updated_at;
    n := n + 1;
  end loop;

  return jsonb_build_object('updated', n);
end;
$$;

revoke all on function public.gas_sheet_sync_durations(jsonb) from public;
grant execute on function public.gas_sheet_sync_durations(jsonb) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
