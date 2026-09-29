-- Лист «В пути»: последний снимок FBO-остатков × карточка, плюс inWay* из extra.

create or replace view public.sheet_in_transit
with (security_invoker = false) as
select
  s.seller_id,
  s.snapshot_date,
  s.nm_id,
  coalesce(
    p.vendor_code,
    s.extra->>'vendorCode',
    s.extra->>'vendor_code'
  ) as vendor_code,
  p.brand,
  p.subject_name,
  coalesce(p.barcode, s.extra->>'barcode') as barcode,
  p.price,
  p.discounted_price,
  s.warehouse_name,
  coalesce(s.extra->>'regionName', s.extra->>'region') as region,
  s.quantity,
  nullif(s.extra->>'inWayToClient', '')::numeric as in_way_to_client,
  nullif(s.extra->>'inWayFromClient', '')::numeric as in_way_from_client,
  null::numeric as weight_kg,
  null::numeric as in_way_to_weight_kg,
  null::numeric as in_way_from_weight_kg,
  null::numeric as stock_weight_kg,
  s.loaded_at
from public.fbo_stocks s
join (
  select seller_id, max(snapshot_date) as snapshot_date
  from public.fbo_stocks
  group by seller_id
) last
  on last.seller_id = s.seller_id
 and last.snapshot_date = s.snapshot_date
left join public.products p
  on p.seller_id = s.seller_id
 and p.nm_id = s.nm_id;

comment on view public.sheet_in_transit is
  'В пути: последний снимок остатков FBO. Вес подставляет GAS из «Товар+Вес». Без payload/extra.';

revoke all on table public.sheet_in_transit from public, anon, authenticated;
grant select on table public.sheet_in_transit to anon, authenticated;
