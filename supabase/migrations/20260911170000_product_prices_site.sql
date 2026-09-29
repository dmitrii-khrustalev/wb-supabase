-- product_prices на сайте: load_health + grant без WB-очереди.

create or replace function public.grant_dataset_access(p_slug text, p_dataset text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  ds text;
  hist_done boolean;
  n_hist integer := 0;
  n_daily integer := 0;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;
  if not (ds = any (public.wb_datasets())) then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  select id into sid from public.sellers where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;

  perform public.sync_dataset_set_access(p_slug, ds, true);

  if ds = 'product_prices' then
    return jsonb_build_object(
      'slug', p_slug,
      'dataset', ds,
      'enabled', true,
      'history_done', true,
      'history_enqueued', false,
      'daily_enqueued', false,
      'note', 'лист GAS main; снимок пишет products'
    );
  end if;

  select exists (
    select 1
    from public.sync_jobs j
    where j.seller_id = sid
      and j.dataset = ds
      and j.mode = 'history'
      and j.status = 'done'
  ) into hist_done;

  if not hist_done then
    n_hist := public.enqueue_one_job(sid, ds, 'history');
  end if;

  n_daily := public.enqueue_one_job(sid, ds, 'daily');

  return jsonb_build_object(
    'slug', p_slug,
    'dataset', ds,
    'enabled', true,
    'history_done', hist_done,
    'history_enqueued', (not hist_done and n_hist > 0),
    'daily_enqueued', n_daily > 0
  );
end;
$$;

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
  products_success date;
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
        'fbs_warehouses', 'fbs_offices', 'claims', 'promos', 'tariffs'
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
      elsif ds in ('products', 'fbs_warehouses', 'fbs_offices', 'claims', 'promos', 'tariffs') then
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

    ds := 'product_prices';
    v_status := null;
    v_error := null;
    v_updated := null;
    v_success := null;
    v_data := public.dataset_data_date(r.id, ds);
    v_expected := today;
    v_row_count := null;
    v_row_count_at := null;
    v_last_inserted := null;
    v_row_bytes := null;
    v_last_bytes := null;

    select (st.last_success_at at time zone 'Europe/Moscow')::date
      into products_success
    from public.sync_state st
    where st.seller_id = r.id
      and st.dataset = 'products';

    select count(*)::bigint into v_row_count
    from public.product_prices_daily pp
    where pp.seller_id = r.id;

    v_fresh := v_data is not null
      and v_data >= today
      and products_success is not null
      and products_success >= today;
    v_note := 'лист GAS main; снимок пишет products';

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
end;
$$;

notify pgrst, 'reload schema';
