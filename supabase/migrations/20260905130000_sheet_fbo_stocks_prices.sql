-- Остатки FBW: цены из products (раньше были только на листе «В пути»).

create or replace view public.sheet_fbo_stocks
with (security_invoker = false) as
select
  s.seller_id,
  s.snapshot_date,
  s.nm_id,
  s.warehouse_name,
  s.quantity,
  s.extra,
  s.loaded_at,
  coalesce(
    p.vendor_code,
    s.extra->>'vendorCode',
    s.extra->>'vendor_code'
  ) as vendor_code,
  p.price,
  p.discounted_price
from public.fbo_stocks s
left join public.products p
  on p.seller_id = s.seller_id
 and p.nm_id = s.nm_id;

comment on view public.sheet_fbo_stocks is
  'Остатки FBW (wb-warehouses). vendor_code и цены — из products или legacy extra.';

revoke all on table public.sheet_fbo_stocks from public, anon, authenticated;
grant select on table public.sheet_fbo_stocks to anon, authenticated;

drop view if exists public.sheet_in_transit;
