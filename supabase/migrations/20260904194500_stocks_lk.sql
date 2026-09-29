-- Остатки ЛК (warehouse_remains): ежедневный снимок, отдельно от fbo_stocks (wb-warehouses).

create table public.fbo_stocks_lk (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  snapshot_date date not null,
  nm_id text not null,
  tech_size text not null default '',
  warehouse_name text not null,
  quantity numeric,
  vendor_code text,
  brand_name text,
  subject_name text,
  barcode text,
  volume numeric,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, snapshot_date, nm_id, tech_size, warehouse_name)
);

comment on table public.fbo_stocks_lk is
  'Остатки FBW как в ЛК (GET warehouse_remains). Ежедневный снимок, названия складов с городом.';

create index fbo_stocks_lk_seller_date_idx
  on public.fbo_stocks_lk (seller_id, snapshot_date desc);

create index fbo_stocks_lk_seller_nm_idx
  on public.fbo_stocks_lk (seller_id, nm_id, snapshot_date desc);

alter table public.fbo_stocks_lk enable row level security;
revoke all on table public.fbo_stocks_lk from anon, authenticated;
grant select, insert, update, delete on table public.fbo_stocks_lk to service_role;

create or replace view public.sheet_fbo_stocks_lk
with (security_invoker = false) as
select
  seller_id,
  snapshot_date,
  nm_id,
  tech_size,
  warehouse_name,
  quantity,
  vendor_code,
  brand_name,
  subject_name,
  barcode,
  volume,
  extra,
  loaded_at
from public.fbo_stocks_lk;

grant select on public.sheet_fbo_stocks_lk to anon, authenticated;

create or replace function public.wb_datasets()
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
    'stocks_lk',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

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
    'stocks_lk',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
  ];
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
    when 'stocks_lk' then
      select max(snapshot_date) into d from public.fbo_stocks_lk where seller_id = p_seller_id;
    when 'fbs_stocks' then
      select max(snapshot_date) into d from public.fbs_stocks where seller_id = p_seller_id;
    when 'fbs_orders' then
      select max((created_at at time zone 'Europe/Moscow')::date)
      into d from public.fbs_orders where seller_id = p_seller_id;
    when 'sales_funnel' then
      select max(stat_date) into d from public.sales_funnel_daily where seller_id = p_seller_id;
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

      if ds in ('fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products', 'fbs_warehouses', 'fbs_offices') then
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
