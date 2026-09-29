-- Ads sheet: article / date / clicks*cpc like the battle workbook.
-- payment_type was wrongly filled from updTime (ISO date).

update public.adv_stats
set payment_type = null
where payment_type ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}';

create or replace view public.sheet_adv_stats
with (security_invoker = false) as
select
  a.seller_id,
  a.advert_id,
  a.stat_date,
  a.app_type,
  a.nm_id,
  a.name,
  a.views,
  a.clicks,
  a.spend,
  a.atbs,
  a.orders,
  a.shks,
  a.cpc,
  a.ctr,
  a.cr,
  a.payment_type,
  a.extra,
  a.loaded_at,
  p.vendor_code as ads_article,
  a.stat_date as ads_date,
  coalesce(a.clicks, 0) * coalesce(a.cpc, 0) as ads_cost
from public.adv_stats a
left join public.products p
  on p.seller_id = a.seller_id
 and p.nm_id = a.nm_id;

revoke all on table public.sheet_adv_stats from public, anon, authenticated;
grant select on table public.sheet_adv_stats to anon, authenticated;
