-- Продажи по регионам: GET /api/v1/analytics/region-sale (max 31 день за запрос).

create table public.region_sales (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  sale_id text not null,
  sale_dt timestamptz,
  region_name text,
  country_name text,
  nm_id text,
  supplier_article text,
  barcode text,
  total_price numeric,
  finished_price numeric,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, sale_id)
);

comment on table public.region_sales is
  'Продажи по регионам (GET /api/v1/analytics/region-sale). Окна до 31 дня.';

create index region_sales_seller_dt_idx
  on public.region_sales (seller_id, sale_dt);

create index region_sales_seller_region_idx
  on public.region_sales (seller_id, region_name, nm_id);

alter table public.region_sales enable row level security;
revoke all on table public.region_sales from anon, authenticated;
grant select, insert, update, delete on table public.region_sales to service_role;

create or replace view public.sheet_region_sales
with (security_invoker = false) as
select
  seller_id,
  sale_id,
  sale_dt,
  region_name,
  country_name,
  nm_id,
  supplier_article,
  barcode,
  total_price,
  finished_price,
  extra,
  loaded_at
from public.region_sales;

revoke all on table public.sheet_region_sales from public, anon, authenticated;
grant select on table public.sheet_region_sales to anon, authenticated;

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
    'fbo_incomes',
    'region_sales',
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
    when 'fbo_incomes' then
      select max((income_dt at time zone 'Europe/Moscow')::date)
      into d from public.fbo_incomes where seller_id = p_seller_id;
    when 'region_sales' then
      select max((sale_dt at time zone 'Europe/Moscow')::date)
      into d from public.region_sales where seller_id = p_seller_id;
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
