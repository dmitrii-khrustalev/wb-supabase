-- Акции: details для auto (сброс description), лист — только активные.

update public.promos
set description = null
where nm_id = '_'
  and promo_type = 'auto'
  and coalesce(description, '') = '';

create or replace view public.sheet_promos_active
with (security_invoker = false) as
select
  seller_id,
  promo_id,
  case when nm_id = '_' then '' else nm_id end as nm_id,
  promo_name,
  promo_type,
  start_dt,
  end_dt,
  description,
  in_action,
  price,
  plan_price,
  discount,
  plan_discount,
  extra,
  loaded_at
from public.promos
where (end_dt at time zone 'Europe/Moscow')::date
  >= (timezone('Europe/Moscow', now()))::date;

revoke all on table public.sheet_promos_active from public, anon, authenticated;
grant select on table public.sheet_promos_active to anon, authenticated;

notify pgrst, 'reload schema';
