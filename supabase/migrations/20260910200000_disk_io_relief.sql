-- Disk IO: статус загрузок без max() по сырью, словарь складов за N дней,
-- обрезка снимков остатков, дневные факты для info/sku вместо jsonb-сканов.

-- ---------------------------------------------------------------------------
-- 1) data_date в sync_state — больше не читаем живые таблицы ради «свежести»
-- ---------------------------------------------------------------------------

alter table public.sync_state
  add column if not exists data_date date;

update public.sync_state st
set data_date = case
  when st.dataset in (
    'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products',
    'fbs_warehouses', 'fbs_offices', 'claims', 'promos'
  ) then (st.last_success_at at time zone 'Europe/Moscow')::date
  else least(
    (st.last_success_at at time zone 'Europe/Moscow')::date,
    (timezone('Europe/Moscow', now()))::date - 1
  )
end
where st.last_success_at is not null
  and st.data_date is null;

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
    'fbs_warehouses', 'fbs_offices', 'claims', 'promos'
  ) then
    return success_day;
  end if;
  return least(success_day, (timezone('Europe/Moscow', now()))::date - 1);
end;
$$;

comment on function public.dataset_data_date(uuid, text) is
  'Дата данных из sync_state.data_date. Живые таблицы не сканирует.';

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
      return next;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Словарь складов: только последние N дней сырья (утро = 7)
-- ---------------------------------------------------------------------------

create or replace function public.warehouse_dict_refresh_days(
  p_seller_id uuid,
  p_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_ins int := 0;
  n_seen int := 0;
  n_merged int := 0;
  new_names text[] := '{}';
  since_d date;
  since_ts timestamptz;
begin
  since_d := case
    when p_days is null then null
    else (timezone('Europe/Moscow', now()))::date - p_days
  end;
  since_ts := case
    when since_d is null then null
    else since_d::timestamp at time zone 'Europe/Moscow'
  end;

  create temp table if not exists _wh_obs (
    alias text primary key,
    warehouse_id text,
    src text
  ) on commit drop;
  truncate _wh_obs;

  insert into _wh_obs (alias, warehouse_id, src)
  select btrim(office_name), null, 'finance'
  from public.finance_rows
  where seller_id = p_seller_id
    and doc_type_name = 'Продажа'
    and nullif(btrim(office_name), '') is not null
    and (since_d is null or rr_dt >= since_d)
  on conflict (alias) do nothing;

  insert into _wh_obs (alias, warehouse_id, src)
  select btrim(warehouse_name), null, 'orders'
  from public.fbo_orders
  where seller_id = p_seller_id
    and nullif(btrim(warehouse_name), '') is not null
    and (since_ts is null or order_dt >= since_ts)
  on conflict (alias) do nothing;

  insert into _wh_obs (alias, warehouse_id, src)
  select
    btrim(coalesce(extra->>'warehouseName', extra->>'actualWarehouseName')),
    min(nullif(btrim(coalesce(extra->>'warehouseID', extra->>'warehouseId', extra->>'actualWarehouseID')), '')),
    'fbw'
  from public.fbw_supplies
  where seller_id = p_seller_id
    and nullif(btrim(coalesce(extra->>'warehouseName', extra->>'actualWarehouseName')), '') is not null
    and (since_ts is null or loaded_at >= since_ts)
  group by 1
  on conflict (alias) do update
    set warehouse_id = coalesce(excluded.warehouse_id, _wh_obs.warehouse_id);

  insert into _wh_obs (alias, warehouse_id, src)
  select btrim(name), warehouse_id, 'fbs'
  from public.fbs_warehouses
  where seller_id = p_seller_id
    and nullif(btrim(name), '') is not null
  on conflict (alias) do nothing;

  update public.warehouse_dict d
  set
    last_seen = (timezone('Europe/Moscow', now()))::date,
    warehouse_id = coalesce(d.warehouse_id, o.warehouse_id),
    updated_at = now()
  from _wh_obs o
  where d.seller_id = p_seller_id
    and d.alias = o.alias;
  get diagnostics n_seen = row_count;

  insert into public.warehouse_dict (
    seller_id, alias, canonical, warehouse_id, region, kind, locked, how
  )
  select
    p_seller_id,
    o.alias,
    r.canonical,
    coalesce(o.warehouse_id, sib.warehouse_id),
    sib.region,
    public.warehouse_dict_kind(o.alias, o.src),
    true,
    'rule'
  from _wh_obs o
  left join public.warehouse_dict d
    on d.seller_id = p_seller_id and d.alias = o.alias
  join lateral (
    select r.canonical
    from public.warehouse_merge_rule r
    where r.alias_norm in (public.warehouse_norm(o.alias), lower(btrim(o.alias)))
    order by length(r.alias_norm) desc
    limit 1
  ) r on true
  left join lateral (
    select x.warehouse_id, x.region
    from public.warehouse_dict x
    where x.seller_id = p_seller_id
      and x.canonical = r.canonical
      and (x.warehouse_id is not null or x.region is not null)
    order by x.warehouse_id nulls last, x.region nulls last
    limit 1
  ) sib on true
  where d.alias is null
  on conflict (seller_id, alias) do nothing;
  get diagnostics n_ins = row_count;
  n_merged := n_ins;

  insert into public.warehouse_dict (
    seller_id, alias, canonical, warehouse_id, region, kind, locked, how
  )
  select
    p_seller_id,
    o.alias,
    sib.canonical,
    coalesce(o.warehouse_id, sib.warehouse_id),
    sib.region,
    public.warehouse_dict_kind(o.alias, o.src),
    false,
    'id'
  from _wh_obs o
  left join public.warehouse_dict d
    on d.seller_id = p_seller_id and d.alias = o.alias
  join lateral (
    select x.canonical, x.warehouse_id, x.region
    from public.warehouse_dict x
    where x.seller_id = p_seller_id
      and o.warehouse_id is not null
      and x.warehouse_id = o.warehouse_id
    limit 1
  ) sib on true
  where d.alias is null
  on conflict (seller_id, alias) do nothing;
  get diagnostics n_ins = row_count;
  n_merged := n_merged + n_ins;

  insert into public.warehouse_dict (
    seller_id, alias, canonical, warehouse_id, region, kind, locked, how
  )
  select
    p_seller_id,
    o.alias,
    o.alias,
    o.warehouse_id,
    null,
    public.warehouse_dict_kind(o.alias, o.src),
    false,
    'auto'
  from _wh_obs o
  left join public.warehouse_dict d
    on d.seller_id = p_seller_id and d.alias = o.alias
  where d.alias is null
  on conflict (seller_id, alias) do nothing;
  get diagnostics n_ins = row_count;

  update public.warehouse_dict d
  set
    canonical = g.canonical,
    warehouse_id = coalesce(d.warehouse_id, g.warehouse_id),
    region = coalesce(d.region, g.region),
    how = case when d.how = 'auto' then 'name' else d.how end,
    updated_at = now()
  from (
    select
      canonical,
      public.warehouse_norm(canonical) as nrm,
      min(warehouse_id) as warehouse_id,
      min(region) as region,
      count(*) over (partition by public.warehouse_norm(canonical)) as n_groups
    from public.warehouse_dict
    where seller_id = p_seller_id
      and kind = 'wb'
      and canonical !~* '^виртуальный'
    group by canonical
  ) g
  where d.seller_id = p_seller_id
    and not d.locked
    and g.n_groups = 1
    and public.warehouse_norm(d.alias) = g.nrm
    and d.canonical is distinct from g.canonical;

  select coalesce(array_agg(d.alias order by d.alias), '{}')
  into new_names
  from public.warehouse_dict d
  where d.seller_id = p_seller_id
    and d.how = 'auto'
    and d.first_seen = (timezone('Europe/Moscow', now()))::date
    and d.canonical = d.alias;

  update public.warehouse_dict d
  set warehouse_id = s.wid, updated_at = now()
  from (
    select seller_id, canonical, min(warehouse_id) as wid
    from public.warehouse_dict
    where seller_id = p_seller_id and warehouse_id is not null
    group by 1, 2
  ) s
  where d.seller_id = s.seller_id
    and d.canonical = s.canonical
    and d.warehouse_id is null;

  update public.warehouse_dict d
  set region = public.warehouse_region_guess(d.alias, d.canonical),
      updated_at = now()
  where d.seller_id = p_seller_id
    and d.region is null
    and public.warehouse_region_guess(d.alias, d.canonical) is not null;

  update public.warehouse_dict d
  set region = s.region, updated_at = now()
  from (
    select seller_id, canonical, min(region) as region
    from public.warehouse_dict
    where seller_id = p_seller_id and region is not null
    group by 1, 2
  ) s
  where d.seller_id = s.seller_id
    and d.canonical = s.canonical
    and d.region is null;

  return jsonb_build_object(
    'seller_id', p_seller_id,
    'days', p_days,
    'seen', n_seen,
    'merged', n_merged,
    'inserted_new', n_ins,
    'new_unmatched', new_names
  );
end;
$$;

create or replace function public.warehouse_dict_refresh(p_seller_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.warehouse_dict_refresh_days(p_seller_id, 7);
end;
$$;

comment on function public.warehouse_dict_refresh(uuid) is
  'Утро: склады из сырья за 7 дней. Полный проход: warehouse_dict_refresh_days(id, null).';

revoke all on function public.warehouse_dict_refresh_days(uuid, integer) from public, anon, authenticated;
grant execute on function public.warehouse_dict_refresh_days(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Дневные факты SKU (отчёты читают это, не jsonb сырья)
-- ---------------------------------------------------------------------------

create table if not exists public.info_facts_daily (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  nm_id text not null,
  d date not null,
  qty_net numeric not null default 0,
  qty_sales numeric not null default 0,
  qty_returns numeric not null default 0,
  retail_net numeric not null default 0,
  for_pay numeric not null default 0,
  commission numeric not null default 0,
  logistics numeric not null default 0,
  storage numeric not null default 0,
  acceptance numeric not null default 0,
  acquiring numeric not null default 0,
  additional numeric not null default 0,
  deduction numeric not null default 0,
  penalty numeric not null default 0,
  ads_spend numeric not null default 0,
  ads_views numeric not null default 0,
  ads_clicks numeric not null default 0,
  ads_orders numeric not null default 0,
  ads_atbs numeric not null default 0,
  fbo_orders bigint not null default 0,
  fbo_cancels bigint not null default 0,
  fbo_sum numeric not null default 0,
  fbs_orders bigint not null default 0,
  fbs_cancels bigint not null default 0,
  fbs_sum numeric not null default 0,
  fbs_sorted bigint not null default 0,
  fbs_waiting bigint not null default 0,
  fbs_sold bigint not null default 0,
  fbo_stock numeric,
  fbs_stock numeric,
  in_way_to numeric,
  in_way_from numeric,
  updated_at timestamptz not null default now(),
  primary key (seller_id, nm_id, d)
);

create index if not exists info_facts_daily_seller_d_idx
  on public.info_facts_daily (seller_id, d);

alter table public.info_facts_daily enable row level security;
revoke all on table public.info_facts_daily from public, anon, authenticated;
grant select on table public.info_facts_daily to service_role;
grant all on table public.info_facts_daily to service_role;

comment on table public.info_facts_daily is
  'Дневные KPI по nm_id. refresh_info_facts после загрузок; info/sku читают отсюда.';

-- ---------------------------------------------------------------------------
-- 4) Снимки остатков: держим 45 дней (GAS 7, weekly ~36)
-- ---------------------------------------------------------------------------

create or replace function public.trim_stock_snapshots(p_keep_days integer default 45)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cut date;
  n_fbo int := 0;
  n_fbs int := 0;
  n_lk int := 0;
  n_facts int := 0;
begin
  if p_keep_days is null or p_keep_days < 7 then
    p_keep_days := 7;
  end if;
  cut := (timezone('Europe/Moscow', now()))::date - p_keep_days;

  delete from public.fbo_stocks where snapshot_date < cut;
  get diagnostics n_fbo = row_count;
  delete from public.fbs_stocks where snapshot_date < cut;
  get diagnostics n_fbs = row_count;
  delete from public.fbo_stocks_lk where snapshot_date < cut;
  get diagnostics n_lk = row_count;
  delete from public.info_facts_daily where d < (timezone('Europe/Moscow', now()))::date - 200;
  get diagnostics n_facts = row_count;

  return jsonb_build_object(
    'cut', cut,
    'fbo_stocks', n_fbo,
    'fbs_stocks', n_fbs,
    'fbo_stocks_lk', n_lk,
    'info_facts_daily', n_facts
  );
end;
$$;

revoke all on function public.trim_stock_snapshots(integer) from public, anon, authenticated;
grant execute on function public.trim_stock_snapshots(integer) to service_role;

create or replace function private.info_sku_daily_compute(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_nm_id text default null
)
returns table (
  nm_id text,
  d date,
  qty_net numeric,
  qty_sales numeric,
  qty_returns numeric,
  retail_net numeric,
  for_pay numeric,
  commission numeric,
  logistics numeric,
  storage numeric,
  acceptance numeric,
  acquiring numeric,
  additional numeric,
  deduction numeric,
  penalty numeric,
  ads_spend numeric,
  ads_views numeric,
  ads_clicks numeric,
  ads_orders numeric,
  ads_atbs numeric,
  fbo_orders bigint,
  fbo_cancels bigint,
  fbo_sum numeric,
  fbs_orders bigint,
  fbs_cancels bigint,
  fbs_sum numeric,
  fbs_sorted bigint,
  fbs_waiting bigint,
  fbs_sold bigint,
  fbo_stock numeric,
  fbs_stock numeric,
  in_way_to numeric,
  in_way_from numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '120s'
as $$
  with fin as (
    select
      f.nm_id,
      f.rr_dt as d,
      sum(
        case f.doc_type_name
          when 'Продажа' then coalesce(f.quantity, 0)
          when 'Возврат' then -coalesce(f.quantity, 0)
          else 0
        end
      ) as qty_net,
      sum(case when f.doc_type_name = 'Продажа' then coalesce(f.quantity, 0) else 0 end) as qty_sales,
      sum(case when f.doc_type_name = 'Возврат' then coalesce(f.quantity, 0) else 0 end) as qty_returns,
      sum(
        case f.doc_type_name
          when 'Продажа' then coalesce(f.retail_amount, 0)
          when 'Возврат' then -coalesce(f.retail_amount, 0)
          else 0
        end
      ) as retail_net,
      sum(private.num_text(f.extra->>'ppvz_for_pay')) as for_pay,
      sum(private.num_text(f.extra->>'ppvz_sales_commission')) as commission,
      sum(private.num_text(f.extra->>'delivery_rub')) as logistics,
      sum(private.num_text(f.extra->>'storage_fee')) as storage,
      sum(private.num_text(f.extra->>'acceptance')) as acceptance,
      sum(private.num_text(f.extra->>'acquiring_fee')) as acquiring,
      sum(private.num_text(f.extra->>'additional_payment')) as additional,
      sum(private.num_text(f.extra->>'deduction')) as deduction,
      sum(private.num_text(f.extra->>'penalty')) as penalty
    from public.finance_rows f
    where f.seller_id = p_seller_id
      and f.rr_dt >= p_from
      and f.rr_dt <= p_to
      and nullif(btrim(f.nm_id), '') is not null
      and (p_nm_id is null or f.nm_id = p_nm_id)
    group by 1, 2
  ),
  ads as (
    select
      a.nm_id,
      a.stat_date as d,
      sum(coalesce(a.clicks, 0) * coalesce(a.cpc, 0)) as ads_spend,
      sum(coalesce(a.views, 0)) as ads_views,
      sum(coalesce(a.clicks, 0)) as ads_clicks,
      sum(coalesce(a.orders, 0)) as ads_orders,
      sum(coalesce(a.atbs, 0)) as ads_atbs
    from public.adv_stats a
    where a.seller_id = p_seller_id
      and a.stat_date >= p_from
      and a.stat_date <= p_to
      and nullif(btrim(a.nm_id), '') is not null
      and (p_nm_id is null or a.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbo as (
    select
      o.nm_id,
      (o.order_dt at time zone 'Europe/Moscow')::date as d,
      count(*) filter (where coalesce(o.is_cancel, false) = false) as fbo_orders,
      count(*) filter (where coalesce(o.is_cancel, false) = true) as fbo_cancels,
      sum(coalesce(o.finished_price, 0)) filter (where coalesce(o.is_cancel, false) = false) as fbo_sum
    from public.fbo_orders o
    where o.seller_id = p_seller_id
      and o.order_dt >= (p_from::timestamp at time zone 'Europe/Moscow')
      and o.order_dt < ((p_to + 1)::timestamp at time zone 'Europe/Moscow')
      and nullif(btrim(o.nm_id), '') is not null
      and (p_nm_id is null or o.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbs as (
    select
      o.nm_id,
      (o.created_at at time zone 'Europe/Moscow')::date as d,
      count(*) as fbs_orders,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) like '%cancel%'
           or lower(coalesce(o.wb_status, '')) like '%declined%'
           or lower(coalesce(o.wb_status, '')) like '%отмен%'
      ) as fbs_cancels,
      coalesce(sum(private.wb_kop_rub(o.extra->>'price')), 0) as fbs_sum,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) in ('sorted', 'ready_for_pickup')
           or lower(coalesce(o.wb_status, '')) like '%отсортир%'
           or lower(coalesce(o.wb_status, '')) like '%пвз%'
      ) as fbs_sorted,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) = 'waiting'
      ) as fbs_waiting,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) in ('sold', 'продано')
      ) as fbs_sold
    from public.fbs_orders o
    where o.seller_id = p_seller_id
      and o.created_at >= (p_from::timestamp at time zone 'Europe/Moscow')
      and o.created_at < ((p_to + 1)::timestamp at time zone 'Europe/Moscow')
      and nullif(btrim(o.nm_id), '') is not null
      and (p_nm_id is null or o.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbo_stk as (
    select
      s.nm_id,
      s.snapshot_date as d,
      sum(coalesce(s.quantity, 0)) as fbo_stock,
      sum(private.num_text(s.extra->>'inWayToClient')) as in_way_to,
      sum(private.num_text(s.extra->>'inWayFromClient')) as in_way_from
    from public.fbo_stocks s
    where s.seller_id = p_seller_id
      and s.snapshot_date >= p_from
      and s.snapshot_date <= p_to
      and nullif(btrim(s.nm_id), '') is not null
      and (p_nm_id is null or s.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbs_stk as (
    select
      coalesce(nullif(btrim(s.nm_id), ''), nullif(btrim(z.nm_id), '')) as nm_id,
      s.snapshot_date as d,
      sum(coalesce(s.amount, 0)) as fbs_stock
    from public.fbs_stocks s
    left join public.product_sizes z
      on z.seller_id = s.seller_id
     and z.chrt_id = s.chrt_id
    where s.seller_id = p_seller_id
      and s.snapshot_date >= p_from
      and s.snapshot_date <= p_to
      and coalesce(nullif(btrim(s.nm_id), ''), nullif(btrim(z.nm_id), '')) is not null
      and (
        p_nm_id is null
        or coalesce(nullif(btrim(s.nm_id), ''), nullif(btrim(z.nm_id), '')) = p_nm_id
      )
    group by 1, 2
  ),
  keys as (
    select nm_id, d from fin
    union
    select nm_id, d from ads
    union
    select nm_id, d from fbo
    union
    select nm_id, d from fbs
    union
    select nm_id, d from fbo_stk
    union
    select nm_id, d from fbs_stk
  )
  select
    k.nm_id,
    k.d,
    coalesce(f.qty_net, 0),
    coalesce(f.qty_sales, 0),
    coalesce(f.qty_returns, 0),
    coalesce(f.retail_net, 0),
    coalesce(f.for_pay, 0),
    coalesce(f.commission, 0),
    coalesce(f.logistics, 0),
    coalesce(f.storage, 0),
    coalesce(f.acceptance, 0),
    coalesce(f.acquiring, 0),
    coalesce(f.additional, 0),
    coalesce(f.deduction, 0),
    coalesce(f.penalty, 0),
    coalesce(a.ads_spend, 0),
    coalesce(a.ads_views, 0),
    coalesce(a.ads_clicks, 0),
    coalesce(a.ads_orders, 0),
    coalesce(a.ads_atbs, 0),
    coalesce(o.fbo_orders, 0),
    coalesce(o.fbo_cancels, 0),
    coalesce(o.fbo_sum, 0),
    coalesce(b.fbs_orders, 0),
    coalesce(b.fbs_cancels, 0),
    coalesce(b.fbs_sum, 0),
    coalesce(b.fbs_sorted, 0),
    coalesce(b.fbs_waiting, 0),
    coalesce(b.fbs_sold, 0),
    s.fbo_stock,
    fs.fbs_stock,
    s.in_way_to,
    s.in_way_from
  from keys k
  left join fin f on f.nm_id = k.nm_id and f.d = k.d
  left join ads a on a.nm_id = k.nm_id and a.d = k.d
  left join fbo o on o.nm_id = k.nm_id and o.d = k.d
  left join fbs b on b.nm_id = k.nm_id and b.d = k.d
  left join fbo_stk s on s.nm_id = k.nm_id and s.d = k.d
  left join fbs_stk fs on fs.nm_id = k.nm_id and fs.d = k.d;
$$;

revoke all on function private.info_sku_daily_compute(uuid, date, date, text) from public;

create or replace function public.refresh_info_facts(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '180s'
as $$
declare
  n integer := 0;
begin
  if p_from is null or p_to is null or p_from > p_to then
    return 0;
  end if;

  delete from public.info_facts_daily
  where seller_id = p_seller_id
    and d >= p_from
    and d <= p_to;

  insert into public.info_facts_daily (
    seller_id, nm_id, d,
    qty_net, qty_sales, qty_returns, retail_net, for_pay, commission, logistics,
    storage, acceptance, acquiring, additional, deduction, penalty,
    ads_spend, ads_views, ads_clicks, ads_orders, ads_atbs,
    fbo_orders, fbo_cancels, fbo_sum,
    fbs_orders, fbs_cancels, fbs_sum, fbs_sorted, fbs_waiting, fbs_sold,
    fbo_stock, fbs_stock, in_way_to, in_way_from, updated_at
  )
  select
    p_seller_id, x.nm_id, x.d,
    x.qty_net, x.qty_sales, x.qty_returns, x.retail_net, x.for_pay, x.commission, x.logistics,
    x.storage, x.acceptance, x.acquiring, x.additional, x.deduction, x.penalty,
    x.ads_spend, x.ads_views, x.ads_clicks, x.ads_orders, x.ads_atbs,
    x.fbo_orders, x.fbo_cancels, x.fbo_sum,
    x.fbs_orders, x.fbs_cancels, x.fbs_sum, x.fbs_sorted, x.fbs_waiting, x.fbs_sold,
    x.fbo_stock, x.fbs_stock, x.in_way_to, x.in_way_from, now()
  from private.info_sku_daily_compute(p_seller_id, p_from, p_to, null) x;

  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.refresh_info_facts_all(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id from public.sellers where is_active loop
    n := n + public.refresh_info_facts(r.id, p_from, p_to);
  end loop;
  return n;
end;
$$;

revoke all on function public.refresh_info_facts(uuid, date, date) from public, anon, authenticated;
revoke all on function public.refresh_info_facts_all(date, date) from public, anon, authenticated;
grant execute on function public.refresh_info_facts(uuid, date, date) to service_role;
grant execute on function public.refresh_info_facts_all(date, date) to service_role;

create or replace function private.info_sku_daily(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_nm_id text default null
)
returns table (
  nm_id text,
  d date,
  qty_net numeric,
  qty_sales numeric,
  qty_returns numeric,
  retail_net numeric,
  for_pay numeric,
  commission numeric,
  logistics numeric,
  storage numeric,
  acceptance numeric,
  acquiring numeric,
  additional numeric,
  deduction numeric,
  penalty numeric,
  ads_spend numeric,
  ads_views numeric,
  ads_clicks numeric,
  ads_orders numeric,
  ads_atbs numeric,
  fbo_orders bigint,
  fbo_cancels bigint,
  fbo_sum numeric,
  fbs_orders bigint,
  fbs_cancels bigint,
  fbs_sum numeric,
  fbs_sorted bigint,
  fbs_waiting bigint,
  fbo_stock numeric,
  fbs_stock numeric,
  in_way_to numeric,
  in_way_from numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '90s'
as $$
begin
  return query
  select
    f.nm_id,
    f.d,
    f.qty_net,
    f.qty_sales,
    f.qty_returns,
    f.retail_net,
    f.for_pay,
    f.commission,
    f.logistics,
    f.storage,
    f.acceptance,
    f.acquiring,
    f.additional,
    f.deduction,
    f.penalty,
    f.ads_spend,
    f.ads_views,
    f.ads_clicks,
    f.ads_orders,
    f.ads_atbs,
    f.fbo_orders,
    f.fbo_cancels,
    f.fbo_sum,
    f.fbs_orders,
    f.fbs_cancels,
    f.fbs_sum,
    f.fbs_sorted,
    f.fbs_waiting,
    f.fbo_stock,
    f.fbs_stock,
    f.in_way_to,
    f.in_way_from
  from public.info_facts_daily f
  where f.seller_id = p_seller_id
    and f.d >= p_from
    and f.d <= p_to
    and (p_nm_id is null or f.nm_id = p_nm_id);

  if found then
    return;
  end if;

  return query
  select
    x.nm_id,
    x.d,
    x.qty_net,
    x.qty_sales,
    x.qty_returns,
    x.retail_net,
    x.for_pay,
    x.commission,
    x.logistics,
    x.storage,
    x.acceptance,
    x.acquiring,
    x.additional,
    x.deduction,
    x.penalty,
    x.ads_spend,
    x.ads_views,
    x.ads_clicks,
    x.ads_orders,
    x.ads_atbs,
    x.fbo_orders,
    x.fbo_cancels,
    x.fbo_sum,
    x.fbs_orders,
    x.fbs_cancels,
    x.fbs_sum,
    x.fbs_sorted,
    x.fbs_waiting,
    x.fbo_stock,
    x.fbs_stock,
    x.in_way_to,
    x.in_way_from
  from private.info_sku_daily_compute(p_seller_id, p_from, p_to, p_nm_id) x;
end;
$$;

revoke all on function private.info_sku_daily(uuid, date, date, text) from public;

create or replace function private.info_dashboard_grid(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  d date,
  qty_net numeric,
  qty_sales numeric,
  qty_returns numeric,
  retail_net numeric,
  for_pay numeric,
  commission numeric,
  logistics numeric,
  storage numeric,
  acceptance numeric,
  acquiring numeric,
  additional numeric,
  deduction numeric,
  penalty numeric,
  ads_spend numeric,
  ads_views numeric,
  ads_clicks numeric,
  ads_orders numeric,
  ads_atbs numeric,
  fbo_orders bigint,
  fbo_cancels bigint,
  fbo_sum numeric,
  fbs_orders bigint,
  fbs_cancels bigint,
  fbs_sold bigint,
  fbs_sorted bigint,
  fbs_waiting bigint,
  fbs_sum numeric,
  fbo_stock numeric,
  fbo_arts bigint,
  in_way_to numeric,
  in_way_from numeric,
  fbs_stock numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    f.d,
    coalesce(sum(f.qty_net), 0),
    coalesce(sum(f.qty_sales), 0),
    coalesce(sum(f.qty_returns), 0),
    coalesce(sum(f.retail_net), 0),
    coalesce(sum(f.for_pay), 0),
    coalesce(sum(f.commission), 0),
    coalesce(sum(f.logistics), 0),
    coalesce(sum(f.storage), 0),
    coalesce(sum(f.acceptance), 0),
    coalesce(sum(f.acquiring), 0),
    coalesce(sum(f.additional), 0),
    coalesce(sum(f.deduction), 0),
    coalesce(sum(f.penalty), 0),
    coalesce(sum(f.ads_spend), 0),
    coalesce(sum(f.ads_views), 0),
    coalesce(sum(f.ads_clicks), 0),
    coalesce(sum(f.ads_orders), 0),
    coalesce(sum(f.ads_atbs), 0),
    coalesce(sum(f.fbo_orders), 0),
    coalesce(sum(f.fbo_cancels), 0),
    coalesce(sum(f.fbo_sum), 0),
    coalesce(sum(f.fbs_orders), 0),
    coalesce(sum(f.fbs_cancels), 0),
    coalesce(sum(f.fbs_sold), 0),
    coalesce(sum(f.fbs_sorted), 0),
    coalesce(sum(f.fbs_waiting), 0),
    coalesce(sum(f.fbs_sum), 0),
    sum(f.fbo_stock),
    count(*) filter (where coalesce(f.fbo_stock, 0) > 0),
    sum(f.in_way_to),
    sum(f.in_way_from),
    sum(f.fbs_stock)
  from public.info_facts_daily f
  where f.seller_id = p_seller_id
    and f.d >= p_from
    and f.d <= p_to
  group by 1;
$$;

revoke all on function private.info_dashboard_grid(uuid, date, date) from public;

-- info daily/weekly/monthly: сетка KPI из info_facts_daily, не из jsonb сырья.
create or replace function private.patch_info_report_grid(p_fn regprocedure)
returns void
language plpgsql
set search_path = pg_catalog, public, private
as $$
declare
  src text;
  pos1 int;
  pos2 int;
  chunk text := $ctes$
  facts_grid as (
    select *
    from private.info_dashboard_grid(
      (select seller_id from meta limit 1),
      (select scan_from from meta limit 1),
      (select day from meta limit 1)
    )
  ),
  fin_by_day as (
    select
      g.d,
      g.qty_net,
      g.qty_sales,
      g.qty_returns,
      g.retail_net,
      g.for_pay,
      g.commission,
      g.logistics,
      g.storage,
      g.acceptance,
      g.acquiring,
      g.additional,
      g.deduction,
      g.penalty
    from facts_grid g
  ),
  ads_by_day as (
    select
      g.d,
      g.ads_spend as spend,
      g.ads_views as views,
      g.ads_clicks as clicks,
      g.ads_orders as adv_orders,
      g.ads_atbs as atbs
    from facts_grid g
  ),
  fbo_by_day as (
    select
      g.d,
      g.fbo_orders as orders,
      g.fbo_cancels as cancels,
      g.fbo_sum as order_sum
    from facts_grid g
  ),
  fbs_by_day as (
    select
      g.d,
      g.fbs_orders as orders,
      g.fbs_cancels as cancels,
      g.fbs_sold as sold,
      g.fbs_sorted as sorted,
      g.fbs_waiting as waiting,
      g.fbs_sum as order_sum
    from facts_grid g
  ),
  fbo_stock_by_day as (
    select
      g.d,
      g.fbo_stock as qty,
      g.fbo_arts as arts,
      g.in_way_to,
      g.in_way_from
    from facts_grid g
  ),
  fbs_stock_by_day as (
    select
      g.d,
      g.fbs_stock as qty
    from facts_grid g
  ),
$ctes$;
begin
  src := pg_get_functiondef(p_fn);
  if src like '%private.info_dashboard_grid(%' then
    raise notice '% already uses info_facts_daily', p_fn;
    return;
  end if;
  pos1 := position('fin_by_day as (' in src);
  if pos1 < 1 then
    pos1 := position('fin_by_day as(' in src);
  end if;
  pos2 := position('grid as (' in src);
  if pos2 < 1 then
    pos2 := position('grid as(' in src);
  end if;
  if pos1 < 1 or pos2 < pos1 then
    raise exception '%: fin_by_day/grid markers not found', p_fn;
  end if;
  src := left(src, pos1 - 1) || chunk || substring(src from pos2);
  execute src;
end;
$$;

do $patch_info_grid$
begin
  perform private.patch_info_report_grid('public.report_info_daily(uuid, date, integer)'::regprocedure);
  perform private.patch_info_report_grid('public.report_info_weekly(uuid, date)'::regprocedure);
  perform private.patch_info_report_grid('public.report_info_monthly(uuid, date)'::regprocedure);
end;
$patch_info_grid$;

drop function if exists private.patch_info_report_grid(regprocedure);

do $patch_loads_date$
declare
  src text;
  from_expr text := 'public.dataset_data_date(m.seller_id, d.dataset) as data_date';
  to_expr text := 'coalesce(st.data_date, public.dataset_data_date(m.seller_id, d.dataset)) as data_date';
begin
  src := pg_get_functiondef('public.report_info_loads(uuid)'::regprocedure);
  if src like '%coalesce(st.data_date, public.dataset_data_date%' then
    return;
  end if;
  if src not like '%' || from_expr || '%' then
    raise exception 'report_info_loads: data_date expression not found';
  end if;
  execute replace(src, from_expr, to_expr);
end;
$patch_loads_date$;

-- Разовый проход: срезать старые снимки и наполнить факты (вечер, IO низкий).
select public.trim_stock_snapshots(45);

do $backfill_facts$
declare
  r record;
  d_from date := (timezone('Europe/Moscow', now()))::date - 90;
  d_to date := (timezone('Europe/Moscow', now()))::date;
begin
  perform set_config('statement_timeout', '180s', true);
  for r in select id from public.sellers where is_active loop
    perform public.refresh_info_facts(r.id, d_from, d_to);
  end loop;
end;
$backfill_facts$;

notify pgrst, 'reload schema';

