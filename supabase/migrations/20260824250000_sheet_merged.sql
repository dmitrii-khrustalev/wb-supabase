-- Объединённые views для тестовой книги: один документ = один лист.

drop view if exists public.sheet_skus;
drop view if exists public.sheet_fbs;
drop view if exists public.sheet_fbs_orders;
drop view if exists public.sheet_fbs_warehouses;

create view public.sheet_skus
with (security_invoker = false) as
select
  p.seller_id,
  s.chrt_id,
  p.nm_id,
  coalesce(s.vendor_code, p.vendor_code) as vendor_code,
  coalesce(s.title, p.title) as title,
  coalesce(s.brand, p.brand) as brand,
  coalesce(s.subject_name, p.subject_name) as subject_name,
  p.imt_id,
  p.barcode,
  s.tech_size,
  s.wb_size,
  s.skus,
  p.price,
  p.discounted_price,
  p.club_discounted_price,
  p.discount_percent,
  p.currency,
  p.extra,
  p.loaded_at
from public.products p
left join public.product_sizes s
  on s.seller_id = p.seller_id
 and s.nm_id = p.nm_id;

comment on view public.sheet_skus is
  'Товары: одна строка на размер (SKU). Карточка повторяется. extra — с карточки, без payload.';

create view public.sheet_fbs_orders
with (security_invoker = false) as
select
  o.seller_id,
  o.order_id,
  o.rid,
  o.order_uid,
  o.created_at,
  o.article,
  o.nm_id,
  o.chrt_id,
  o.warehouse_id,
  o.supply_id,
  o.supplier_status,
  o.wb_status,
  o.source,
  st.barcode as sticker_barcode,
  st.part_a,
  st.part_b,
  o.extra,
  o.loaded_at
from public.fbs_orders o
left join public.fbs_order_stickers st
  on st.seller_id = o.seller_id
 and st.order_id = o.order_id;

create view public.sheet_fbs_warehouses
with (security_invoker = false) as
select
  w.seller_id,
  w.warehouse_id,
  w.name,
  w.office_id,
  o.name as office_name,
  o.address as office_address,
  o.city as office_city,
  w.cargo_type,
  w.delivery_type,
  w.extra,
  w.loaded_at
from public.fbs_warehouses w
left join public.fbs_offices o
  on o.seller_id = w.seller_id
 and o.office_id = w.office_id;

create view public.sheet_fbs
with (security_invoker = false) as
select
  s.seller_id,
  s.supply_id,
  s.name as supply_name,
  s.done,
  so.order_id,
  o.rid,
  o.article,
  o.nm_id,
  o.chrt_id,
  o.supplier_status,
  o.wb_status,
  s.extra,
  s.loaded_at
from public.fbs_supplies s
left join public.fbs_supply_orders so
  on so.seller_id = s.seller_id
 and so.supply_id = s.supply_id
left join public.fbs_orders o
  on o.seller_id = s.seller_id
 and o.order_id = so.order_id;

comment on view public.sheet_fbs is
  'Поставки FBS: одна строка на заказ в поставке. Шапка поставки повторяется. extra — с поставки.';

revoke all on table public.sheet_skus from public, anon, authenticated;
grant select on table public.sheet_skus to anon, authenticated;

revoke all on table public.sheet_fbs_orders from public, anon, authenticated;
grant select on table public.sheet_fbs_orders to anon, authenticated;

revoke all on table public.sheet_fbs_warehouses from public, anon, authenticated;
grant select on table public.sheet_fbs_warehouses to anon, authenticated;

revoke all on table public.sheet_fbs from public, anon, authenticated;
grant select on table public.sheet_fbs to anon, authenticated;
