-- Объём данных: row_bytes в sync_state (по кнопке), bytes_inserted в load_runs (оценка по среднему).

alter table public.sync_state
  add column if not exists row_bytes bigint;

alter table public.load_runs
  add column if not exists bytes_inserted bigint not null default 0;

comment on column public.sync_state.row_bytes is
  'SUM(pg_column_size(row)) по кабинету в основной таблице датасета.';
comment on column public.load_runs.bytes_inserted is
  'Оценка прироста байт за run: rows_inserted × (row_bytes / row_count).';

create or replace function public.dataset_row_bytes(p_seller_id uuid, p_dataset text)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  tbl text;
  n bigint;
begin
  tbl := public.dataset_primary_table(p_dataset);
  if tbl is null then
    return null;
  end if;

  execute format(
    'select coalesce(sum(pg_column_size(t)), 0)::bigint from %I t where seller_id = $1',
    tbl
  )
  into n
  using p_seller_id;

  return n;
end;
$$;

create or replace function public.refresh_dataset_row_count(p_slug text, p_dataset text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  ds text;
  n bigint;
  b bigint;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or public.dataset_primary_table(ds) is null then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  select id into sid from public.sellers where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;

  n := public.dataset_row_count(sid, ds);
  b := public.dataset_row_bytes(sid, ds);

  insert into public.sync_state (seller_id, dataset, cursor, row_count, row_bytes, row_count_at, updated_at)
  values (sid, ds, '{}'::jsonb, n, b, now(), now())
  on conflict (seller_id, dataset) do update
    set row_count = excluded.row_count,
        row_bytes = excluded.row_bytes,
        row_count_at = excluded.row_count_at,
        updated_at = now();

  return jsonb_build_object(
    'slug', p_slug,
    'dataset', ds,
    'row_count', n,
    'row_bytes', b,
    'row_count_at', now()
  );
end;
$$;

drop function if exists public.load_health();

create or replace function public.load_health()
returns table (
  slug text,
  dataset text,
  job_status text,
  job_error text,
  job_updated_at timestamptz,
  last_success_at timestamptz,
  data_date date,
  expected_date date,
  fresh boolean,
  note text,
  row_count bigint,
  row_count_at timestamptz,
  last_rows_inserted integer,
  row_bytes bigint,
  last_bytes_inserted bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  ds text;
  today date := (timezone('Europe/Moscow', now()))::date;
  yesterday date := (timezone('Europe/Moscow', now()))::date - 1;
  v_status text;
  v_error text;
  v_updated timestamptz;
  v_success timestamptz;
  v_data date;
  v_expected date;
  v_fresh boolean;
  v_note text;
  success_day date;
  v_row_count bigint;
  v_row_count_at timestamptz;
  v_last_inserted integer;
  v_row_bytes bigint;
  v_last_bytes bigint;
begin
  for r in select s.id, s.slug from public.sellers s where s.is_active order by s.slug loop
    foreach ds in array public.daily_datasets() loop
      v_status := null;
      v_error := null;
      v_updated := null;
      v_success := null;
      v_data := null;
      v_expected := yesterday;
      v_fresh := false;
      v_note := null;
      v_row_count := null;
      v_row_count_at := null;
      v_last_inserted := null;
      v_row_bytes := null;
      v_last_bytes := null;

      select j.status, j.error, j.updated_at
        into v_status, v_error, v_updated
      from public.sync_jobs j
      where j.seller_id = r.id
        and j.dataset = ds
        and j.mode = 'daily'
      order by j.updated_at desc
      limit 1;

      select st.last_success_at, st.row_count, st.row_count_at, st.row_bytes
        into v_success, v_row_count, v_row_count_at, v_row_bytes
      from public.sync_state st
      where st.seller_id = r.id
        and st.dataset = ds;

      select lr.rows_inserted, lr.bytes_inserted
        into v_last_inserted, v_last_bytes
      from public.load_runs lr
      where lr.seller_id = r.id
        and lr.dataset = ds
        and lr.error is null
      order by lr.finished_at desc nulls last, lr.started_at desc
      limit 1;

      v_data := public.dataset_data_date(r.id, ds);
      success_day := (v_success at time zone 'Europe/Moscow')::date;

      if ds in (
        'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products',
        'fbs_warehouses', 'fbs_offices', 'claims', 'promos'
      ) then
        v_expected := today;
      else
        v_expected := yesterday;
      end if;

      if ds in ('products', 'fbs_warehouses', 'fbs_offices', 'fbs_supplies', 'fbw_supplies')
         and v_data is null then
        v_data := success_day;
      end if;

      if v_status is null then
        v_note := 'задания ещё не было';
        v_fresh := false;
      elsif v_status in ('queued', 'running') then
        v_note := 'ещё идёт';
        v_fresh := false;
      elsif v_status = 'error' then
        v_note := coalesce(left(v_error, 80), 'ошибка без текста');
        v_fresh := false;
      elsif ds in ('fbs_orders', 'fbs_supplies', 'fbw_supplies') then
        v_fresh := (success_day is not null and success_day >= today)
          or (v_data is not null and v_data >= yesterday);
        if not v_fresh then
          v_note := 'нет свежих данных';
        end if;
      elsif ds in ('products', 'fbs_warehouses', 'fbs_offices', 'claims', 'promos') then
        v_fresh := success_day is not null and success_day >= today;
        if not v_fresh then
          v_note := 'справочник не обновлялся сегодня';
        end if;
      else
        v_fresh := v_data is not null and v_data >= v_expected;
        if not v_fresh then
          v_note := format(
            'данные до %s, ждали %s',
            coalesce(to_char(v_data, 'DD.MM'), 'пусто'),
            to_char(v_expected, 'DD.MM')
          );
        end if;
      end if;

      slug := r.slug;
      dataset := ds;
      job_status := v_status;
      job_error := v_error;
      job_updated_at := v_updated;
      last_success_at := v_success;
      data_date := v_data;
      expected_date := v_expected;
      fresh := v_fresh;
      note := v_note;
      row_count := v_row_count;
      row_count_at := v_row_count_at;
      last_rows_inserted := v_last_inserted;
      row_bytes := v_row_bytes;
      last_bytes_inserted := v_last_bytes;
      return next;
    end loop;
  end loop;
end;
$$;

revoke all on function public.dataset_row_bytes(uuid, text) from public, anon, authenticated;
grant execute on function public.dataset_row_bytes(uuid, text) to service_role;

notify pgrst, 'reload schema';
