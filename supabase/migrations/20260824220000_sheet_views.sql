-- Stage 2: PostgREST views for the test Google Sheet.
-- Base tables stay locked. Views omit payload and PII (fbs_order_clients).
-- security_invoker = false: view owner reads through RLS; anon only needs SELECT on the view.

create or replace view public.sheet_sellers
with (security_invoker = false) as
select
  id,
  name,
  slug,
  is_active
from public.sellers;

create or replace view public.sheet_finance_rows
with (security_invoker = false) as
select
  seller_id,
  rrd_id,
  nm_id,
  sa_name,
  barcode,
  doc_type_name,
  quantity,
  retail_amount,
  office_name,
  supplier_oper_name,
  rr_dt,
  shk_id,
  extra,
  loaded_at
from public.finance_rows;

create or replace view public.sheet_adv_stats
with (security_invoker = false) as
select
  seller_id,
  advert_id,
  stat_date,
  app_type,
  nm_id,
  name,
  views,
  clicks,
  spend,
  atbs,
  orders,
  shks,
  cpc,
  ctr,
  cr,
  payment_type,
  extra,
  loaded_at
from public.adv_stats;

create or replace view public.sheet_fbo_orders
with (security_invoker = false) as
select
  seller_id,
  srid,
  order_dt,
  last_change_dt,
  nm_id,
  supplier_article,
  barcode,
  warehouse_name,
  total_price,
  finished_price,
  is_cancel,
  extra,
  loaded_at
from public.fbo_orders;

create or replace view public.sheet_fbo_stocks
with (security_invoker = false) as
select
  seller_id,
  snapshot_date,
  nm_id,
  warehouse_name,
  quantity,
  extra,
  loaded_at
from public.fbo_stocks;

create or replace view public.sheet_products
with (security_invoker = false) as
select
  seller_id,
  nm_id,
  vendor_code,
  title,
  brand,
  subject_name,
  imt_id,
  barcode,
  price,
  discounted_price,
  club_discounted_price,
  discount_percent,
  currency,
  sizes,
  extra,
  loaded_at
from public.products;

create or replace view public.sheet_product_sizes
with (security_invoker = false) as
select
  seller_id,
  chrt_id,
  nm_id,
  vendor_code,
  title,
  brand,
  subject_name,
  tech_size,
  wb_size,
  skus,
  loaded_at
from public.product_sizes;

create or replace view public.sheet_fbw_supplies
with (security_invoker = false) as
select
  seller_id,
  supply_id,
  details_loaded,
  extra,
  loaded_at
from public.fbw_supplies;

create or replace view public.sheet_fbw_supply_goods
with (security_invoker = false) as
select
  seller_id,
  supply_id,
  nm_id,
  barcode,
  quantity,
  extra,
  loaded_at
from public.fbw_supply_goods;

create or replace view public.sheet_fbs_warehouses
with (security_invoker = false) as
select
  seller_id,
  warehouse_id,
  name,
  office_id,
  cargo_type,
  delivery_type,
  extra,
  loaded_at
from public.fbs_warehouses;

create or replace view public.sheet_fbs_offices
with (security_invoker = false) as
select
  seller_id,
  office_id,
  name,
  address,
  city,
  extra,
  loaded_at
from public.fbs_offices;

create or replace view public.sheet_fbs_stocks
with (security_invoker = false) as
select
  seller_id,
  snapshot_date,
  warehouse_id,
  chrt_id,
  amount,
  sku,
  nm_id,
  extra,
  loaded_at
from public.fbs_stocks;

create or replace view public.sheet_fbs_orders
with (security_invoker = false) as
select
  seller_id,
  order_id,
  rid,
  order_uid,
  created_at,
  article,
  nm_id,
  chrt_id,
  warehouse_id,
  supply_id,
  supplier_status,
  wb_status,
  source,
  extra,
  loaded_at
from public.fbs_orders;

create or replace view public.sheet_fbs_order_stickers
with (security_invoker = false) as
select
  seller_id,
  order_id,
  barcode,
  part_a,
  part_b,
  extra,
  loaded_at
from public.fbs_order_stickers;

create or replace view public.sheet_fbs_supplies
with (security_invoker = false) as
select
  seller_id,
  supply_id,
  name,
  done,
  details_loaded,
  extra,
  loaded_at
from public.fbs_supplies;

create or replace view public.sheet_fbs_supply_orders
with (security_invoker = false) as
select
  seller_id,
  supply_id,
  order_id,
  loaded_at
from public.fbs_supply_orders;

create or replace view public.sheet_fbs_supply_trbx
with (security_invoker = false) as
select
  seller_id,
  supply_id,
  trbx_id,
  barcode,
  extra,
  loaded_at
from public.fbs_supply_trbx;

create or replace view public.sheet_fbs_order_history
with (security_invoker = false) as
select
  seller_id,
  order_id,
  extra,
  loaded_at
from public.fbs_order_history;

create or replace view public.sheet_fbs_order_reshipment
with (security_invoker = false) as
select
  seller_id,
  order_id,
  extra,
  loaded_at
from public.fbs_order_reshipment;

create or replace view public.sheet_fbs_supply_qr
with (security_invoker = false) as
select
  seller_id,
  supply_id,
  barcode,
  extra,
  loaded_at
from public.fbs_supply_qr;

do $$
declare
  v text;
begin
  foreach v in array array[
    'sheet_sellers',
    'sheet_finance_rows',
    'sheet_adv_stats',
    'sheet_fbo_orders',
    'sheet_fbo_stocks',
    'sheet_products',
    'sheet_product_sizes',
    'sheet_fbw_supplies',
    'sheet_fbw_supply_goods',
    'sheet_fbs_warehouses',
    'sheet_fbs_offices',
    'sheet_fbs_stocks',
    'sheet_fbs_orders',
    'sheet_fbs_order_stickers',
    'sheet_fbs_supplies',
    'sheet_fbs_supply_orders',
    'sheet_fbs_supply_trbx',
    'sheet_fbs_order_history',
    'sheet_fbs_order_reshipment',
    'sheet_fbs_supply_qr'
  ]
  loop
    execute format('revoke all on table public.%I from public, anon, authenticated', v);
    execute format('grant select on table public.%I to anon, authenticated', v);
  end loop;
end $$;
