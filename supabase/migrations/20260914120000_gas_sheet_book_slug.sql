-- gas_sheet_updates per book (main / dmz). sync_durations no longer bumps updated_at.

alter table public.gas_sheet_updates
  add column if not exists book_slug text not null default 'main';

update public.gas_sheet_updates
set book_slug = 'main'
where book_slug is null or btrim(book_slug) = '';

alter table public.gas_sheet_updates drop constraint if exists gas_sheet_updates_pkey;
alter table public.gas_sheet_updates add primary key (book_slug, dataset);

comment on column public.gas_sheet_updates.book_slug is
  'Книга GAS: main или dmz.';

create or replace function private.gas_sheet_touch_impl(
  p_book_slug text,
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
  book text;
begin
  book := lower(btrim(coalesce(p_book_slug, 'main')));
  if book = '' or book !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown book: %', p_book_slug;
  end if;
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  insert into public.gas_sheet_updates (book_slug, dataset, sheet_name, rows_written, duration_ms, updated_at)
  values (book, ds, nullif(btrim(coalesce(p_sheet_name, '')), ''), p_rows, p_duration_ms, now())
  on conflict (book_slug, dataset) do update
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
  p_duration_ms integer default null,
  p_book_slug text default 'main'
)
returns timestamptz
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.gas_sheet_touch_impl(p_book_slug, p_dataset, p_sheet_name, p_rows, p_duration_ms);
$$;

create or replace function public.gas_sheet_sync_durations(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  item jsonb;
  ds text;
  book text;
  n integer := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a json array';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    book := lower(btrim(coalesce(item->>'book_slug', 'main')));
    if book = '' or book !~ '^[a-z][a-z0-9_]*$' then
      continue;
    end if;
    ds := lower(btrim(coalesce(item->>'dataset', '')));
    if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
      continue;
    end if;
    update public.gas_sheet_updates g
    set
      duration_ms = nullif(item->>'duration_ms', '')::integer,
      rows_written = coalesce(nullif(item->>'rows', '')::integer, g.rows_written),
      sheet_name = coalesce(nullif(btrim(coalesce(item->>'sheet_name', '')), ''), g.sheet_name)
    where g.book_slug = book
      and g.dataset = ds
      and (g.updated_at at time zone 'Europe/Moscow')::date
        = (timezone('Europe/Moscow', now()))::date;
    if found then
      n := n + 1;
    end if;
  end loop;

  return jsonb_build_object('updated', n);
end;
$$;

revoke all on function private.gas_sheet_touch_impl(text, text, text, integer, integer) from public;
revoke all on function public.gas_sheet_touch(text, text, integer, integer, text) from public;
revoke all on function public.gas_sheet_sync_durations(jsonb) from public;

grant execute on function private.gas_sheet_touch_impl(text, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.gas_sheet_touch(text, text, integer, integer, text)
  to anon, authenticated, service_role;
grant execute on function public.gas_sheet_sync_durations(jsonb)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
