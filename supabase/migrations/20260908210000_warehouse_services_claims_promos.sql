-- Складские услуги (платное хранение + приёмка), заявки на возврат, акции.
-- Только wb_datasets, не daily_datasets.

create table public.warehouse_services (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  kind text not null,
  row_key text not null,
  service_dt timestamptz,
  nm_id text,
  subject_name text,
  warehouse_name text,
  amount numeric,
  quantity numeric,
  income_id text,
  supplier_article text,
  barcode text,
  description text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, kind, row_key)
);

comment on table public.warehouse_services is
  'Складские услуги: paid_storage, acceptance (async reports API).';

create index warehouse_services_seller_dt_idx
  on public.warehouse_services (seller_id, service_dt desc);

create index warehouse_services_seller_kind_idx
  on public.warehouse_services (seller_id, kind, service_dt desc);

alter table public.warehouse_services enable row level security;
revoke all on table public.warehouse_services from anon, authenticated;
grant select, insert, update, delete on table public.warehouse_services to service_role;

create or replace view public.sheet_warehouse_services
with (security_invoker = false) as
select
  seller_id,
  service_dt,
  kind,
  row_key,
  nm_id,
  subject_name,
  warehouse_name,
  amount,
  quantity,
  income_id,
  supplier_article,
  barcode,
  description,
  extra,
  loaded_at
from public.warehouse_services;

revoke all on table public.sheet_warehouse_services from public, anon, authenticated;
grant select on table public.sheet_warehouse_services to anon, authenticated;

create table public.claims (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  claim_id text not null,
  claim_dt timestamptz,
  claim_updated_dt timestamptz,
  order_dt timestamptz,
  delivery_dt timestamptz,
  nm_id text,
  claim_type integer,
  status integer,
  status_ex integer,
  product_name text,
  user_comment text,
  wb_comment text,
  price numeric,
  currency_code text,
  srid text,
  is_archive boolean not null default false,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, claim_id)
);

comment on table public.claims is
  'Заявки покупателей на возврат (GET /api/v1/claims, ~14 дней).';

create index claims_seller_dt_idx
  on public.claims (seller_id, claim_dt desc);

create index claims_seller_nm_idx
  on public.claims (seller_id, nm_id, claim_dt desc);

alter table public.claims enable row level security;
revoke all on table public.claims from anon, authenticated;
grant select, insert, update, delete on table public.claims to service_role;

create or replace view public.sheet_claims
with (security_invoker = false) as
select
  seller_id,
  claim_id,
  claim_dt,
  claim_updated_dt,
  order_dt,
  delivery_dt,
  nm_id,
  claim_type,
  status,
  status_ex,
  product_name,
  user_comment,
  wb_comment,
  price,
  currency_code,
  srid,
  is_archive,
  extra,
  loaded_at
from public.claims;

revoke all on table public.sheet_claims from public, anon, authenticated;
grant select on table public.sheet_claims to anon, authenticated;

create table public.promos (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  promo_id text not null,
  nm_id text not null default '_',
  promo_name text,
  promo_type text,
  start_dt timestamptz,
  end_dt timestamptz,
  description text,
  in_action boolean,
  price numeric,
  plan_price numeric,
  discount numeric,
  plan_discount numeric,
  nomenclatures_loaded boolean not null default false,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, promo_id, nm_id)
);

comment on table public.promos is
  'Акции: календарь + детали + номенклатура (promo × nm). nm_id=_ — заголовок акции.';

create index promos_seller_start_idx
  on public.promos (seller_id, start_dt desc);

create index promos_seller_nm_idx
  on public.promos (seller_id, nm_id, start_dt desc);

alter table public.promos enable row level security;
revoke all on table public.promos from anon, authenticated;
grant select, insert, update, delete on table public.promos to service_role;

create or replace view public.sheet_promos
with (security_invoker = false) as
select
  seller_id,
  promo_id,
  nm_id,
  promo_name,
  promo_type,
  start_dt,
  end_dt,
  description,
  in_action,
  price,
  plan_price,
  discount,
  plan_discount,
  extra,
  loaded_at
from public.promos
where nm_id <> '_';

revoke all on table public.sheet_promos from public, anon, authenticated;
grant select on table public.sheet_promos to anon, authenticated;

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
    'fbo_sales',
    'region_sales',
    'goods_returns',
    'order_feed',
    'feedbacks',
    'questions',
    'tariffs',
    'wb_retentions',
    'warehouse_services',
    'claims',
    'promos',
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
    when 'fbo_sales' then
      select max((sale_dt at time zone 'Europe/Moscow')::date)
      into d from public.fbo_sales where seller_id = p_seller_id;
    when 'region_sales' then
      select max((sale_dt at time zone 'Europe/Moscow')::date)
      into d from public.region_sales where seller_id = p_seller_id;
    when 'goods_returns' then
      select max((order_dt at time zone 'Europe/Moscow')::date)
      into d from public.goods_returns where seller_id = p_seller_id;
    when 'order_feed' then
      select max((status_updated_at at time zone 'Europe/Moscow')::date)
      into d from public.order_feed where seller_id = p_seller_id;
    when 'feedbacks' then
      select max((feedback_dt at time zone 'Europe/Moscow')::date)
      into d from public.feedbacks where seller_id = p_seller_id;
    when 'questions' then
      select max((question_dt at time zone 'Europe/Moscow')::date)
      into d from public.questions where seller_id = p_seller_id;
    when 'search_queries' then
      select max(stat_date) into d from public.search_queries where seller_id = p_seller_id;
    when 'tariffs' then
      select max(tariff_dt) into d from public.tariffs where seller_id = p_seller_id;
    when 'wb_retentions' then
      select max((retention_dt at time zone 'Europe/Moscow')::date)
      into d from public.wb_retentions where seller_id = p_seller_id;
    when 'warehouse_services' then
      select max((service_dt at time zone 'Europe/Moscow')::date)
      into d from public.warehouse_services where seller_id = p_seller_id;
    when 'claims' then
      select max((claim_dt at time zone 'Europe/Moscow')::date)
      into d from public.claims where seller_id = p_seller_id;
    when 'promos' then
      select max((end_dt at time zone 'Europe/Moscow')::date)
      into d from public.promos where seller_id = p_seller_id;
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

notify pgrst, 'reload schema';
