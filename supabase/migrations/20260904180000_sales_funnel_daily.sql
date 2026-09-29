-- Воронка продаж: история по дням (nm × date) из WB Analytics v3.

create table public.sales_funnel_daily (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  stat_date date not null,
  nm_id text not null,
  vendor_code text,
  title text,
  brand_name text,
  subject_name text,
  open_count numeric,
  cart_count numeric,
  order_count numeric,
  order_sum numeric,
  buyout_count numeric,
  buyout_sum numeric,
  buyout_percent numeric,
  add_to_cart_conversion numeric,
  cart_to_order_conversion numeric,
  add_to_wishlist_count numeric,
  extra jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, stat_date, nm_id)
);

create index sales_funnel_daily_seller_date_idx
  on public.sales_funnel_daily (seller_id, stat_date desc);

create index sales_funnel_daily_seller_nm_idx
  on public.sales_funnel_daily (seller_id, nm_id, stat_date desc);

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

create or replace view public.sheet_sales_funnel_daily
with (security_invoker = false) as
select
  seller_id,
  stat_date,
  nm_id,
  vendor_code,
  title,
  brand_name,
  subject_name,
  open_count,
  cart_count,
  order_count,
  order_sum,
  buyout_count,
  buyout_sum,
  buyout_percent,
  add_to_cart_conversion,
  cart_to_order_conversion,
  add_to_wishlist_count,
  extra,
  loaded_at
from public.sales_funnel_daily;

grant select on public.sheet_sales_funnel_daily to anon, authenticated;
