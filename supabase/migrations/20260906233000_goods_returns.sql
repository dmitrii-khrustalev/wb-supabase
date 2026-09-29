-- Возвраты товаров: GET /api/v1/analytics/goods-return (max 31 день за запрос).

create table public.goods_returns (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  return_id text not null,
  order_dt timestamptz,
  order_id text,
  srid text,
  shk_id text,
  nm_id text,
  barcode text,
  tech_size text,
  status_name text,
  return_type text,
  reason text,
  completed_dt timestamptz,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, return_id)
);

comment on table public.goods_returns is
  'Возвраты товаров (GET /api/v1/analytics/goods-return). Окна до 31 дня.';

create index goods_returns_seller_order_dt_idx
  on public.goods_returns (seller_id, order_dt);

create index goods_returns_seller_nm_idx
  on public.goods_returns (seller_id, nm_id, order_dt);

alter table public.goods_returns enable row level security;
revoke all on table public.goods_returns from anon, authenticated;
grant select, insert, update, delete on table public.goods_returns to service_role;

create or replace view public.sheet_goods_returns
with (security_invoker = false) as
select
  seller_id,
  return_id,
  order_dt,
  order_id,
  srid,
  shk_id,
  nm_id,
  barcode,
  tech_size,
  status_name,
  return_type,
  reason,
  completed_dt,
  extra,
  loaded_at
from public.goods_returns;

revoke all on table public.sheet_goods_returns from public, anon, authenticated;
grant select on table public.sheet_goods_returns to anon, authenticated;

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
    'goods_returns',
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
    when 'goods_returns' then
      select max((order_dt at time zone 'Europe/Moscow')::date)
      into d from public.goods_returns where seller_id = p_seller_id;
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
