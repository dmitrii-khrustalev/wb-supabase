-- Client overlay columns (Артикул / Дата / clicks×CPC) stay in GAS 02, not in the shared view.
-- CREATE OR REPLACE cannot drop columns; recreate.

drop view if exists public.sheet_adv_stats;

create view public.sheet_adv_stats
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

grant select on table public.sheet_adv_stats to anon, authenticated;
