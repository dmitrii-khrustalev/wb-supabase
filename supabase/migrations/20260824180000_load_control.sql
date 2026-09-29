-- Remote control: check freshness, enqueue one dataset, retry errors.

create or replace function public.daily_datasets()
returns text[]
language sql
immutable
as $$
  select array[
    'products',
    'finance',
    'adv_stats',
    'fbo_orders',
    'fbo_stocks',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies'
  ];
$$;

create or replace function public.enqueue_one_job(p_seller_id uuid, p_dataset text, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reused uuid;
  inserted integer;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;
  if not (p_dataset = any (public.wb_datasets())) then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  if exists (
    select 1
    from public.sync_jobs
    where seller_id = p_seller_id
      and dataset = p_dataset
      and mode = p_mode
      and status in ('queued', 'running')
  ) then
    return 0;
  end if;

  if p_mode = 'daily' then
    update public.sync_jobs j
    set
      status = 'queued',
      cursor = '{}'::jsonb,
      error = null,
      attempts = 0,
      started_at = null,
      finished_at = null
    where j.id = (
      select s.id
      from public.sync_jobs s
      where s.seller_id = p_seller_id
        and s.dataset = p_dataset
        and s.mode = 'daily'
        and s.status in ('done', 'error')
      order by s.created_at desc
      limit 1
    )
    returning j.id into reused;

    if reused is not null then
      return 1;
    end if;
  end if;

  insert into public.sync_jobs (seller_id, dataset, mode, status)
  values (p_seller_id, p_dataset, p_mode, 'queued')
  on conflict (seller_id, dataset, mode) where status in ('queued', 'running')
  do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

create or replace function public.enqueue_jobs(p_seller_id uuid, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ds text;
  n integer := 0;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;

  foreach ds in array public.wb_datasets() loop
    if p_mode = 'daily' and ds in ('wb_warehouses', 'transit_tariffs') then
      continue;
    end if;
    n := n + public.enqueue_one_job(p_seller_id, ds, p_mode);
  end loop;
  return n;
end;
$$;

create or replace function public.enqueue_dataset(p_dataset text, p_mode text default 'daily', p_slug text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  sid uuid;
  n integer := 0;
begin
  if p_slug is not null then
    select id into sid from public.sellers where slug = p_slug;
    if sid is null then
      raise exception 'seller not found: %', p_slug;
    end if;
    return public.enqueue_one_job(sid, p_dataset, p_mode);
  end if;

  for r in select id from public.sellers where is_active loop
    n := n + public.enqueue_one_job(r.id, p_dataset, p_mode);
  end loop;
  return n;
end;
$$;

create or replace function public.retry_failed_jobs(p_mode text default 'daily', p_slug text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;

  with latest as (
    select distinct on (j.seller_id, j.dataset, j.mode) j.id, j.seller_id, j.dataset, j.mode
    from public.sync_jobs j
    where j.status = 'error'
      and j.mode = p_mode
      and (p_slug is null or j.seller_id in (select s.id from public.sellers s where s.slug = p_slug))
    order by j.seller_id, j.dataset, j.mode, j.updated_at desc
  )
  update public.sync_jobs j
  set
    status = 'queued',
    cursor = '{}'::jsonb,
    error = null,
    attempts = 0,
    started_at = null,
    finished_at = null
  from latest
  where j.id = latest.id
    and not exists (
      select 1
      from public.sync_jobs a
      where a.seller_id = latest.seller_id
        and a.dataset = latest.dataset
        and a.mode = latest.mode
        and a.status in ('queued', 'running')
    );

  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.dataset_data_date(p_seller_id uuid, p_dataset text)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d date;
begin
  case p_dataset
    when 'finance' then
      select max(rr_dt) into d from public.finance_rows where seller_id = p_seller_id;
    when 'adv_stats' then
      select max(stat_date) into d from public.adv_stats where seller_id = p_seller_id;
    when 'fbo_orders' then
      select max((order_dt at time zone 'Europe/Moscow')::date)
      into d from public.fbo_orders where seller_id = p_seller_id;
    when 'fbo_stocks' then
      select max(snapshot_date) into d from public.fbo_stocks where seller_id = p_seller_id;
    when 'fbs_stocks' then
      select max(snapshot_date) into d from public.fbs_stocks where seller_id = p_seller_id;
    when 'fbs_orders' then
      select max((created_at at time zone 'Europe/Moscow')::date)
      into d from public.fbs_orders where seller_id = p_seller_id;
    else
      d := null;
  end case;
  return d;
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
  note text
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

      select j.status, j.error, j.updated_at
        into v_status, v_error, v_updated
      from public.sync_jobs j
      where j.seller_id = r.id
        and j.dataset = ds
        and j.mode = 'daily'
      order by j.updated_at desc
      limit 1;

      select st.last_success_at
        into v_success
      from public.sync_state st
      where st.seller_id = r.id
        and st.dataset = ds;

      v_data := public.dataset_data_date(r.id, ds);
      success_day := (v_success at time zone 'Europe/Moscow')::date;

      if ds in ('fbo_stocks', 'fbs_stocks', 'products', 'fbs_warehouses', 'fbs_offices') then
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
        v_fresh := true;
      elsif v_status = 'error' then
        v_note := coalesce(left(v_error, 80), 'ошибка без текста');
        v_fresh := false;
      elsif ds in ('fbs_orders', 'fbs_supplies', 'fbw_supplies') then
        v_fresh := (success_day is not null and success_day >= today)
          or (v_data is not null and v_data >= yesterday);
        if not v_fresh then
          v_note := 'нет свежих данных';
        end if;
      elsif ds in ('products', 'fbs_warehouses', 'fbs_offices') then
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
      return next;
    end loop;
  end loop;
end;
$$;

revoke all on function public.enqueue_one_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.enqueue_dataset(text, text, text) from public, anon, authenticated;
revoke all on function public.retry_failed_jobs(text, text) from public, anon, authenticated;
revoke all on function public.dataset_data_date(uuid, text) from public, anon, authenticated;
revoke all on function public.load_health() from public, anon, authenticated;
revoke all on function public.daily_datasets() from public, anon, authenticated;

grant execute on function public.enqueue_one_job(uuid, text, text) to service_role;
grant execute on function public.enqueue_dataset(text, text, text) to service_role;
grant execute on function public.retry_failed_jobs(text, text) to service_role;
grant execute on function public.dataset_data_date(uuid, text) to service_role;
grant execute on function public.load_health() to service_role;
grant execute on function public.daily_datasets() to service_role;
grant execute on function public.enqueue_jobs(uuid, text) to service_role;
