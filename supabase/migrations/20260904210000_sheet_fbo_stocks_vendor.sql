-- Остатки FBW: артикул из каталога (API wb-warehouses его не отдаёт).
-- vendor_code в конце списка — иначе CREATE OR REPLACE не даёт вставить колонку в середину.

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
  ) as vendor_code
from public.fbo_stocks s
left join public.products p
  on p.seller_id = s.seller_id
 and p.nm_id = s.nm_id;

comment on view public.sheet_fbo_stocks is
  'Остатки FBW (wb-warehouses). vendor_code — из products или legacy extra (gas_history).';

revoke all on table public.sheet_fbo_stocks from public, anon, authenticated;
grant select on table public.sheet_fbo_stocks to anon, authenticated;
