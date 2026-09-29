-- Утро без опроса: открытые поставки, сумма строк GAS по книге, телега после финиша.

create or replace function public.fbw_queue_open_supplies(p_seller_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
  cutoff date := (timezone('Europe/Moscow', now()))::date - 60;
begin
  update public.fbw_supplies s
  set details_loaded = false
  where s.seller_id = p_seller_id
    and coalesce(s.extra->>'statusID', s.extra->>'statusId', '') not in ('', '5')
    and coalesce(
      nullif(left(s.extra->>'supplyDate', 10), ''),
      nullif(left(s.extra->>'createDate', 10), ''),
      to_char((s.loaded_at at time zone 'Europe/Moscow')::date, 'YYYY-MM-DD')
    ) >= to_char(cutoff, 'YYYY-MM-DD');
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.fbw_queue_open_supplies(uuid) is
  'Daily: refetch details for FBW supplies not in terminal status 5, within 60 days.';

revoke all on function public.fbw_queue_open_supplies(uuid) from public, anon, authenticated;
grant execute on function public.fbw_queue_open_supplies(uuid) to service_role;

create or replace function public.fbs_queue_open_supplies(p_seller_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
begin
  update public.fbs_supplies
  set details_loaded = false
  where seller_id = p_seller_id
    and done is not true;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.fbs_queue_open_supplies(uuid) is
  'Daily: refetch details for FBS supplies that are not done.';

revoke all on function public.fbs_queue_open_supplies(uuid) from public, anon, authenticated;
grant execute on function public.fbs_queue_open_supplies(uuid) to service_role;

alter table public.gas_morning_status
  add column if not exists finished boolean not null default false;

comment on column public.gas_morning_status.finished is
  'GAS book chain finished (sheets + reports). sync-tick sends that book''s Telegram.';

create table if not exists public.gas_morning_sheet_rows (
  book_slug text not null,
  run_date date not null,
  sheet_name text not null,
  rows_written integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (book_slug, run_date, sheet_name)
);

comment on table public.gas_morning_sheet_rows is
  'Per-sheet rows written during morning GAS chain. Skip = 0.';

alter table public.gas_morning_sheet_rows enable row level security;
revoke all on table public.gas_morning_sheet_rows from public, anon, authenticated;
grant all on table public.gas_morning_sheet_rows to service_role;
grant select, insert, update on table public.gas_morning_sheet_rows to anon, authenticated;

create or replace function public.gas_morning_sheet_add(
  p_book_slug text,
  p_run_date date,
  p_sheet_name text,
  p_rows integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  book text := lower(btrim(coalesce(p_book_slug, '')));
  sheet text := btrim(coalesce(p_sheet_name, ''));
begin
  if book = '' or sheet = '' then
    return;
  end if;
  insert into public.gas_morning_sheet_rows (
    book_slug, run_date, sheet_name, rows_written, updated_at
  )
  values (
    book, p_run_date, sheet, greatest(0, coalesce(p_rows, 0)), now()
  )
  on conflict (book_slug, run_date, sheet_name) do update set
    rows_written = excluded.rows_written,
    updated_at = now();
end;
$$;

revoke all on function public.gas_morning_sheet_add(text, date, text, integer) from public;
grant execute on function public.gas_morning_sheet_add(text, date, text, integer)
  to anon, authenticated, service_role;

create or replace function public.morning_sheet_book_text(
  p_book_slug text,
  p_run_date date default (timezone('Europe/Moscow', now()))::date
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  book text := lower(btrim(coalesce(p_book_slug, '')));
  label text;
  lines text[] := array[]::text[];
  r record;
begin
  if book = '' then
    return null;
  end if;
  label := case when book = 'dmz' then 'DMZ' else book end;
  lines := array_append(lines, format('Утро %s %s', to_char(p_run_date, 'DD.MM'), label));
  for r in
    select sheet_name, rows_written
    from public.gas_morning_sheet_rows
    where book_slug = book
      and run_date = p_run_date
    order by sheet_name
  loop
    if r.rows_written <= 0 then
      lines := array_append(lines, r.sheet_name || ' +0 (пропуск)');
    else
      lines := array_append(lines, r.sheet_name || ' +' || r.rows_written::text);
    end if;
  end loop;
  if array_length(lines, 1) is null or array_length(lines, 1) < 2 then
    lines := array_append(lines, 'нет листов');
  end if;
  return left(array_to_string(lines, E'\n'), 4000);
end;
$$;

revoke all on function public.morning_sheet_book_text(text, date) from public, anon, authenticated;
grant execute on function public.morning_sheet_book_text(text, date) to service_role;

drop function if exists public.gas_morning_status_upsert(text, date, boolean, boolean, integer, integer, text[], text[], text);

create or replace function public.gas_morning_status_upsert(
  p_book_slug text,
  p_run_date date,
  p_base_ok boolean,
  p_gas_ok boolean,
  p_sheets_done integer,
  p_sheets_total integer,
  p_base_bad text[],
  p_gas_bad text[],
  p_summary text,
  p_finished boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.gas_morning_status (
    book_slug, run_date, base_ok, gas_ok, sheets_done, sheets_total,
    base_bad, gas_bad, summary, notified, finished, updated_at
  )
  values (
    p_book_slug, p_run_date, coalesce(p_base_ok, false), coalesce(p_gas_ok, false),
    coalesce(p_sheets_done, 0), coalesce(p_sheets_total, 0),
    coalesce(p_base_bad, '{}'), coalesce(p_gas_bad, '{}'),
    left(coalesce(p_summary, ''), 500), false, coalesce(p_finished, false), now()
  )
  on conflict (book_slug, run_date) do update set
    base_ok = excluded.base_ok,
    gas_ok = excluded.gas_ok,
    sheets_done = excluded.sheets_done,
    sheets_total = excluded.sheets_total,
    base_bad = excluded.base_bad,
    gas_bad = excluded.gas_bad,
    summary = excluded.summary,
    finished = public.gas_morning_status.finished or excluded.finished,
    updated_at = now();
end;
$$;

revoke all on function public.gas_morning_status_upsert(text, date, boolean, boolean, integer, integer, text[], text[], text, boolean) from public;
grant execute on function public.gas_morning_status_upsert(text, date, boolean, boolean, integer, integer, text[], text[], text, boolean)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
