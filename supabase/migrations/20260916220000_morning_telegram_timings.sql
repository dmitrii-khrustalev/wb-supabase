-- Утро в телеге: старт/финиш, минуты, вчера/прошлые, работа/оверлей/удаление/простой.

alter table public.load_runs
  add column if not exists rows_yesterday integer not null default 0,
  add column if not exists rows_old integer not null default 0;

comment on column public.load_runs.rows_yesterday is
  'Daily upserts with date >= yesterday (snapshots: today).';
comment on column public.load_runs.rows_old is
  'Daily upserts that overwrite dates older than yesterday, or catalog replace.';

alter table public.gas_morning_sheet_rows
  add column if not exists rows_yesterday integer not null default 0,
  add column if not exists rows_old integer not null default 0,
  add column if not exists skipped boolean not null default false,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists sort_order integer;

alter table public.gas_morning_status
  add column if not exists started_at timestamptz,
  add column if not exists work_ms integer not null default 0,
  add column if not exists overlay_ms integer not null default 0,
  add column if not exists trim_ms integer not null default 0;

create or replace function private.morning_mins(p_ms bigint)
returns integer
language sql
immutable
as $$
  select greatest(0, round(coalesce(p_ms, 0)::numeric / 60000.0)::int);
$$;

grant execute on function private.morning_mins(bigint) to postgres, service_role;

create or replace function public.gas_morning_sheet_tick(
  p_book_slug text,
  p_run_date date,
  p_sheet_name text,
  p_rows_yesterday integer default 0,
  p_rows_old integer default 0,
  p_skipped boolean default false,
  p_started_at timestamptz default null,
  p_finished_at timestamptz default null,
  p_sort_order integer default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  book text := lower(btrim(coalesce(p_book_slug, '')));
  sheet text := btrim(coalesce(p_sheet_name, ''));
  y integer := greatest(0, coalesce(p_rows_yesterday, 0));
  o integer := greatest(0, coalesce(p_rows_old, 0));
begin
  if book = '' or sheet = '' then
    return;
  end if;
  insert into public.gas_morning_sheet_rows (
    book_slug, run_date, sheet_name, rows_written,
    rows_yesterday, rows_old, skipped, started_at, finished_at, sort_order, updated_at
  )
  values (
    book, p_run_date, sheet, y + o,
    y, o, coalesce(p_skipped, false), p_started_at, p_finished_at, p_sort_order, now()
  )
  on conflict (book_slug, run_date, sheet_name) do update set
    rows_yesterday = public.gas_morning_sheet_rows.rows_yesterday + excluded.rows_yesterday,
    rows_old = public.gas_morning_sheet_rows.rows_old + excluded.rows_old,
    rows_written = public.gas_morning_sheet_rows.rows_written
      + excluded.rows_yesterday + excluded.rows_old,
    skipped = public.gas_morning_sheet_rows.skipped and excluded.skipped,
    started_at = case
      when public.gas_morning_sheet_rows.started_at is null then excluded.started_at
      when excluded.started_at is null then public.gas_morning_sheet_rows.started_at
      else least(public.gas_morning_sheet_rows.started_at, excluded.started_at)
    end,
    finished_at = case
      when public.gas_morning_sheet_rows.finished_at is null then excluded.finished_at
      when excluded.finished_at is null then public.gas_morning_sheet_rows.finished_at
      else greatest(public.gas_morning_sheet_rows.finished_at, excluded.finished_at)
    end,
    sort_order = coalesce(public.gas_morning_sheet_rows.sort_order, excluded.sort_order),
    updated_at = now();
end;
$$;

revoke all on function public.gas_morning_sheet_tick(text, date, text, integer, integer, boolean, timestamptz, timestamptz, integer) from public;
grant execute on function public.gas_morning_sheet_tick(text, date, text, integer, integer, boolean, timestamptz, timestamptz, integer)
  to anon, authenticated, service_role;

create or replace function public.gas_morning_timing_set(
  p_book_slug text,
  p_run_date date,
  p_started_at timestamptz default null,
  p_work_ms integer default null,
  p_overlay_ms integer default null,
  p_trim_ms integer default null,
  p_add boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  book text := lower(btrim(coalesce(p_book_slug, '')));
begin
  if book = '' then
    return;
  end if;
  insert into public.gas_morning_status (
    book_slug, run_date, started_at, work_ms, overlay_ms, trim_ms, updated_at
  )
  values (
    book, p_run_date, p_started_at,
    greatest(0, coalesce(p_work_ms, 0)),
    greatest(0, coalesce(p_overlay_ms, 0)),
    greatest(0, coalesce(p_trim_ms, 0)),
    now()
  )
  on conflict (book_slug, run_date) do update set
    started_at = coalesce(public.gas_morning_status.started_at, excluded.started_at),
    work_ms = case
      when p_add then public.gas_morning_status.work_ms + excluded.work_ms
      when p_work_ms is null then public.gas_morning_status.work_ms
      else excluded.work_ms
    end,
    overlay_ms = case
      when p_add then public.gas_morning_status.overlay_ms + excluded.overlay_ms
      when p_overlay_ms is null then public.gas_morning_status.overlay_ms
      else excluded.overlay_ms
    end,
    trim_ms = case
      when p_add then public.gas_morning_status.trim_ms + excluded.trim_ms
      when p_trim_ms is null then public.gas_morning_status.trim_ms
      else excluded.trim_ms
    end,
    updated_at = now();
end;
$$;

revoke all on function public.gas_morning_timing_set(text, date, timestamptz, integer, integer, integer, boolean) from public;
grant execute on function public.gas_morning_timing_set(text, date, timestamptz, integer, integer, integer, boolean)
  to anon, authenticated, service_role;

create or replace function public.morning_sheet_book_text(
  p_book_slug text,
  p_run_date date default (timezone('Europe/Moscow', now()))::date
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  book text := lower(btrim(coalesce(p_book_slug, '')));
  label text;
  lines text[] := array[]::text[];
  st public.gas_morning_status%rowtype;
  has_st boolean := false;
  t0 timestamptz;
  t1 timestamptz;
  wall_ms bigint;
  idle_ms bigint;
  work_ms bigint := 0;
  overlay_ms bigint := 0;
  trim_ms bigint := 0;
  r record;
  hm0 text;
  hm1 text;
begin
  if book = '' then
    return null;
  end if;
  label := case when book = 'dmz' then 'DMZ' else book end;
  lines := array_append(lines, format('Утро %s %s', to_char(p_run_date, 'DD.MM'), label));

  select * into st
  from public.gas_morning_status
  where book_slug = book and run_date = p_run_date;
  has_st := found;
  if has_st then
    work_ms := coalesce(st.work_ms, 0);
    overlay_ms := coalesce(st.overlay_ms, 0);
    trim_ms := coalesce(st.trim_ms, 0);
  end if;

  select min(started_at), max(finished_at)
    into t0, t1
  from public.gas_morning_sheet_rows
  where book_slug = book and run_date = p_run_date;

  if has_st then
    t0 := coalesce(st.started_at, t0);
    t1 := coalesce(st.updated_at, t1);
  end if;
  if t0 is not null and t1 is not null then
    wall_ms := greatest(0, floor(extract(epoch from (t1 - t0)) * 1000)::bigint);
    idle_ms := greatest(0, wall_ms - work_ms - overlay_ms - trim_ms);
    lines := array_append(
      lines,
      format(
        '%s → %s · %s мин',
        to_char(t0 at time zone 'Europe/Moscow', 'HH24:MI'),
        to_char(t1 at time zone 'Europe/Moscow', 'HH24:MI'),
        private.morning_mins(wall_ms)
      )
    );
    lines := array_append(lines, 'работа ' || private.morning_mins(work_ms)::text);
    if overlay_ms >= 30000 then
      lines := array_append(lines, 'оверлей ' || private.morning_mins(overlay_ms)::text);
    end if;
    if trim_ms >= 30000 then
      lines := array_append(lines, 'удаление ' || private.morning_mins(trim_ms)::text);
    end if;
    if idle_ms >= 30000 then
      lines := array_append(lines, 'простой ' || private.morning_mins(idle_ms)::text);
    end if;
  end if;

  lines := array_append(lines, '');

  for r in
    select
      sheet_name,
      rows_yesterday,
      rows_old,
      skipped,
      started_at,
      finished_at
    from public.gas_morning_sheet_rows
    where book_slug = book
      and run_date = p_run_date
    order by coalesce(sort_order, 1000), started_at nulls last, sheet_name
  loop
    if r.skipped and r.rows_yesterday = 0 and r.rows_old = 0 then
      lines := array_append(lines, r.sheet_name || ' — (пропуск)');
    else
      hm0 := case when r.started_at is null then ''
        else to_char(r.started_at at time zone 'Europe/Moscow', 'HH24:MI') end;
      hm1 := case when r.finished_at is null then ''
        else to_char(r.finished_at at time zone 'Europe/Moscow', 'HH24:MI') end;
      if hm0 <> '' and hm1 <> '' then
        lines := array_append(
          lines,
          format('%s %s–%s · %s/%s', r.sheet_name, hm0, hm1, r.rows_yesterday, r.rows_old)
        );
      else
        lines := array_append(
          lines,
          format('%s · %s/%s', r.sheet_name, r.rows_yesterday, r.rows_old)
        );
      end if;
    end if;
  end loop;

  if array_length(lines, 1) is null or array_length(lines, 1) < 3 then
    lines := array_append(lines, 'нет листов');
  end if;
  return left(array_to_string(lines, E'\n'), 4000);
end;
$$;

revoke all on function public.morning_sheet_book_text(text, date) from public, anon, authenticated;
grant execute on function public.morning_sheet_book_text(text, date) to service_role;

notify pgrst, 'reload schema';
