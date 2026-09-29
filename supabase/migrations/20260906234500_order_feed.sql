-- Лента заказов: POST /api/analytics/v1/order-feed (max 31 день, пагинация).

create table public.order_feed (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  event_id text not null,
  status_updated_at timestamptz,
  created_at timestamptz,
  srid text,
  nm_id text,
  chrt_id text,
  status_name text,
  cancel_type text,
  warehouse_name text,
  warehouse_region text,
  destination_city text,
  destination_district text,
  seller_price numeric,
  is_mp boolean,
  is_b2b boolean,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, event_id)
);

comment on table public.order_feed is
  'Лента заказов (POST /api/analytics/v1/order-feed). Окна до 31 дня, пагинация.';

create index order_feed_seller_status_dt_idx
  on public.order_feed (seller_id, status_updated_at);

create index order_feed_seller_nm_idx
  on public.order_feed (seller_id, nm_id, status_updated_at);

alter table public.order_feed enable row level security;
revoke all on table public.order_feed from anon, authenticated;
grant select, insert, update, delete on table public.order_feed to service_role;

create or replace view public.sheet_order_feed
with (security_invoker = false) as
select
  seller_id,
  event_id,
  status_updated_at,
  created_at,
  srid,
  nm_id,
  chrt_id,
  status_name,
  cancel_type,
  warehouse_name,
  warehouse_region,
  destination_city,
  destination_district,
  seller_price,
  is_mp,
  is_b2b,
  extra,
  loaded_at
from public.order_feed;

revoke all on table public.sheet_order_feed from public, anon, authenticated;
grant select on table public.sheet_order_feed to anon, authenticated;

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
    'order_feed',
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
    when 'order_feed' then
      select max((status_updated_at at time zone 'Europe/Moscow')::date)
      into d from public.order_feed where seller_id = p_seller_id;
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
