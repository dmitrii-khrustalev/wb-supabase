-- История цен: отдельный лист. Цены убраны с «Остатки FBW».

alter table public.product_prices_daily
  add column if not exists discount_percent numeric;

comment on column public.product_prices_daily.discount_percent is
  'Скидка продавца, % — на дату снимка.';

comment on table public.product_prices_daily is
  'Цены каталога по дням (МСК). Пишется при синке products; лист «История цен».';

update public.product_prices_daily pp
set discount_percent = round((1 - pp.discounted_price / pp.price) * 100)
where pp.discount_percent is null
  and pp.price is not null
  and pp.price <> 0
  and pp.discounted_price is not null;

drop view if exists public.sheet_fbo_stocks;

create view public.sheet_fbo_stocks
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
  'Остатки FBW. vendor_code — products или legacy extra. Без цен.';

create or replace view public.sheet_product_prices_daily
with (security_invoker = false) as
select
  pp.seller_id,
  pp.price_date,
  pp.nm_id,
  coalesce(p.vendor_code, '') as vendor_code,
  pp.price,
  pp.discounted_price,
  pp.club_discounted_price,
  pp.discount_percent,
  pp.currency,
  pp.loaded_at
from public.product_prices_daily pp
left join public.products p
  on p.seller_id = pp.seller_id
 and p.nm_id = pp.nm_id;

comment on view public.sheet_product_prices_daily is
  'История цен каталога: nm × день, все поля product_prices_daily.';

revoke all on table public.sheet_fbo_stocks from public, anon, authenticated;
grant select on table public.sheet_fbo_stocks to anon, authenticated;

revoke all on table public.sheet_product_prices_daily from public, anon, authenticated;
grant select on table public.sheet_product_prices_daily to anon, authenticated;
