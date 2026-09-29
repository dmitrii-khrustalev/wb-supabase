-- Тарифы: SCD — в таблице только версии при изменении, на лист — актуальный снимок.

comment on table public.tariffs is
  'Тарифы WB (commission, box, pallet, return, acceptance). tariff_dt = дата начала действия версии; полный снимок только при изменении.';

-- Убрать дневные дубликаты: оставить строку, если содержимое отличается от предыдущей версии того же ключа.
with ranked as (
  select
    ctid,
    rate_value,
    subject_name,
    description,
    warehouse_name,
    box_type,
    extra,
    payload,
    lag(rate_value) over w as prev_rate_value,
    lag(subject_name) over w as prev_subject_name,
    lag(description) over w as prev_description,
    lag(warehouse_name) over w as prev_warehouse_name,
    lag(box_type) over w as prev_box_type,
    lag(extra) over w as prev_extra,
    lag(payload) over w as prev_payload
  from public.tariffs
  window w as (
    partition by seller_id, kind, row_key
    order by tariff_dt
  )
),
dupes as (
  select r.ctid
  from ranked r
  where r.prev_rate_value is not null
    and r.rate_value is not distinct from r.prev_rate_value
    and r.subject_name is not distinct from r.prev_subject_name
    and r.description is not distinct from r.prev_description
    and r.warehouse_name is not distinct from r.prev_warehouse_name
    and r.box_type is not distinct from r.prev_box_type
    and r.extra is not distinct from r.prev_extra
    and r.payload is not distinct from r.prev_payload
)
delete from public.tariffs t
using dupes d
where t.ctid = d.ctid;

-- Лист: последняя версия по каждому ключу (не история).
create or replace view public.sheet_tariffs
with (security_invoker = false) as
select distinct on (seller_id, kind, row_key)
  seller_id,
  tariff_dt,
  kind,
  warehouse_name,
  box_type,
  row_key,
  subject_name,
  description,
  rate_value,
  extra,
  loaded_at
from public.tariffs
order by seller_id, kind, row_key, tariff_dt desc;

revoke all on table public.sheet_tariffs from public, anon, authenticated;
grant select on table public.sheet_tariffs to anon, authenticated;

-- Справочник: свежесть = проверка сегодня, не max(tariff_dt).
create or replace function public.dataset_data_date(p_seller_id uuid, p_dataset text)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d date;
  success_day date;
begin
  select st.data_date, (st.last_success_at at time zone 'Europe/Moscow')::date
    into d, success_day
  from public.sync_state st
  where st.seller_id = p_seller_id
    and st.dataset = p_dataset;

  if d is not null then
    return d;
  end if;
  if success_day is null then
    return null;
  end if;

  if p_dataset in (
    'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products',
    'fbs_warehouses', 'fbs_offices', 'claims', 'promos', 'tariffs'
  ) then
    return success_day;
  end if;
  return least(success_day, (timezone('Europe/Moscow', now()))::date - 1);
end;
$$;

create or replace function public.report_info_loads(p_seller_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set statement_timeout = '15s'
as $$
  with params as (
    select
      p_seller_id as seller_id,
      (pg_catalog.timezone('Europe/Moscow', pg_catalog.now()))::date as today
  ),
  meta as (
    select
      p.*,
      s.slug,
      s.name as seller_name,
      s.datasets_locked_default
    from params p
    join public.sellers s on s.id = p.seller_id
  ),
  load_rows as (
    select
      d.ord,
      d.dataset,
      j.status as job_status,
      j.error as job_error,
      j.updated_at as job_updated_at,
      st.last_success_at,
      public.dataset_data_date(m.seller_id, d.dataset) as data_date
    from meta m
    cross join unnest(public.daily_datasets()) with ordinality as d(dataset, ord)
    left join lateral (
      select sj.status, sj.error, sj.updated_at
      from public.sync_jobs sj
      where sj.seller_id = m.seller_id
        and sj.dataset = d.dataset
        and sj.mode = 'daily'
      order by sj.updated_at desc
      limit 1
    ) j on true
    left join public.sync_state st
      on st.seller_id = m.seller_id
     and st.dataset = d.dataset
  ),
  load_ready as (
    select
      l.*,
      case
        when l.dataset in (
          'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products', 'fbs_warehouses', 'fbs_offices',
          'tariffs'
        ) then m.today
        when l.dataset in ('claims', 'promos') then m.today
        else m.today - 1
      end as expected_date,
      (l.last_success_at at time zone 'Europe/Moscow')::date as success_day
    from load_rows l
    cross join meta m
  ),
  load_final as (
    select
      l.ord,
      l.dataset,
      public.dataset_access_enabled((select seller_id from meta), l.dataset) as access_enabled,
      case l.dataset
        when 'finance' then 'Финансовые ежедневные'
        when 'adv_stats' then 'Рекламные расходы'
        when 'sales_funnel' then 'Воронка продаж'
        when 'fbo_orders' then 'Заказы FBW'
        when 'fbo_sales' then 'Продажи FBW'
        when 'region_sales' then 'Продажи по регионам'
        when 'goods_returns' then 'Возвраты товаров'
        when 'order_feed' then 'Лента заказов'
        when 'feedbacks' then 'Отзывы'
        when 'questions' then 'Вопросы'
        when 'tariffs' then 'Тарифы'
        when 'wb_retentions' then 'Удержания WB'
        when 'warehouse_services' then 'Складские услуги'
        when 'claims' then 'Заявки на возврат'
        when 'promos' then 'Акции'
        when 'fbo_stocks' then 'Остатки FBW'
        when 'stocks_lk' then 'Остатки ЛК'
        when 'fbw_supplies' then 'Поставки FBW'
        when 'fbs_stocks' then 'Остатки FBS'
        when 'fbs_orders' then 'Заказы FBS'
        when 'fbs_supplies' then 'Поставки FBS'
        when 'products' then 'Товары'
        when 'fbs_warehouses' then 'Склады FBS'
        when 'fbs_offices' then 'Офисы FBS'
        else l.dataset
      end as sheet_name,
      l.job_status,
      l.data_date,
      l.expected_date,
      to_char(
        pg_catalog.timezone('Europe/Moscow', l.last_success_at),
        'YYYY-MM-DD HH24:MI'
      ) as loaded_at,
      case
        when l.job_status is null then false
        when l.job_status in ('queued', 'running') then false
        when l.job_status = 'error' then false
        when l.dataset in ('fbs_orders', 'fbs_supplies', 'fbw_supplies') then
          (l.success_day is not null and l.success_day >= (select today from meta))
          or (l.data_date is not null and l.data_date >= (select today from meta) - 1)
        when l.dataset in ('products', 'fbs_warehouses', 'fbs_offices', 'tariffs') then
          l.success_day is not null and l.success_day >= (select today from meta)
        when l.dataset in ('claims', 'promos') then
          l.success_day is not null and l.success_day >= (select today from meta)
        else
          l.data_date is not null and l.data_date >= l.expected_date
      end as fresh,
      case
        when not public.dataset_access_enabled((select seller_id from meta), l.dataset) then 'доступ закрыт'
        when l.job_status is null then 'задания ещё не было'
        when l.job_status in ('queued', 'running') then 'ещё идёт'
        when l.job_status = 'error' then coalesce(left(l.job_error, 80), 'ошибка без текста')
        else null
      end as note
    from load_ready l
  )
  select jsonb_build_object(
    'slug', m.slug,
    'seller_name', m.seller_name,
    'datasets_locked_default', m.datasets_locked_default,
    'updated_at', to_char(
      pg_catalog.timezone('Europe/Moscow', pg_catalog.now()),
      'YYYY-MM-DD HH24:MI'
    ),
    'loads', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'dataset', lf.dataset,
        'sheet', lf.sheet_name,
        'status', lf.job_status,
        'data_date', lf.data_date,
        'expected_date', lf.expected_date,
        'loaded_at', lf.loaded_at,
        'fresh', lf.fresh,
        'access_enabled', lf.access_enabled,
        'note', lf.note
      ) order by lf.ord), '[]'::jsonb)
      from load_final lf
    )
  )
  from meta m;
$$;

update public.sync_state st
set
  row_count = public.dataset_row_count(st.seller_id, st.dataset),
  row_count_at = now()
where st.dataset = 'tariffs';

-- load_health: тарифы — справочник, свежесть по success_day сегодня.
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
  end loop;
end;
$$;

notify pgrst, 'reload schema';
