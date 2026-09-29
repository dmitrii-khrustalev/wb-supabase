-- Удержания WB: габариты, подмены, маркировка, товары с ОМ, самовыкупы. Только wb_datasets.

create table public.wb_retentions (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  retention_dt timestamptz,
  kind text not null,
  row_key text not null,
  nm_id text,
  subject_name text,
  description text,
  amount numeric,
  supplier_article text,
  barcode text,
  shk_id text,
  income_id text,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, kind, row_key)
);

comment on table public.wb_retentions is
  'Удержания WB: measurement, substitution, labeling, excise, antifraud.';

create index wb_retentions_seller_dt_idx
  on public.wb_retentions (seller_id, retention_dt desc);

create index wb_retentions_seller_kind_idx
  on public.wb_retentions (seller_id, kind, retention_dt desc);

create index wb_retentions_seller_nm_idx
  on public.wb_retentions (seller_id, nm_id, retention_dt desc);

alter table public.wb_retentions enable row level security;
revoke all on table public.wb_retentions from anon, authenticated;
grant select, insert, update, delete on table public.wb_retentions to service_role;

create or replace view public.sheet_wb_retentions
with (security_invoker = false) as
select
  seller_id,
  retention_dt,
  kind,
  row_key,
  nm_id,
  subject_name,
  description,
  amount,
  supplier_article,
  barcode,
  shk_id,
  income_id,
  extra,
  loaded_at
from public.wb_retentions;

revoke all on table public.sheet_wb_retentions from public, anon, authenticated;
grant select on table public.sheet_wb_retentions to anon, authenticated;

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
    'search_queries',
    'tariffs',
    'wb_retentions',
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
