-- Дневной снимок цен каталога. На листе «Остатки FBW» join по snapshot_date = price_date.

create table if not exists public.product_prices_daily (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  nm_id text not null,
  price_date date not null,
  price numeric,
  discounted_price numeric,
  club_discounted_price numeric,
  currency text,
  loaded_at timestamptz not null default now(),
  primary key (seller_id, nm_id, price_date)
);

create index if not exists product_prices_daily_date_idx
  on public.product_prices_daily (seller_id, price_date);

comment on table public.product_prices_daily is
  'Цены каталога по дням (МСК). Пишется при синке products; на остатках FBW — только за дату снимка.';

alter table public.product_prices_daily enable row level security;

revoke all on table public.product_prices_daily from public, anon, authenticated;
grant select, insert, update, delete on table public.product_prices_daily to service_role;

-- Старт истории: сегодня (МСК) из текущего каталога, без прошлых дат.
insert into public.product_prices_daily (
  seller_id, nm_id, price_date, price, discounted_price, club_discounted_price, currency
)
select
  p.seller_id,
  p.nm_id,
  (timezone('Europe/Moscow', now()))::date,
  p.price,
  p.discounted_price,
  p.club_discounted_price,
  p.currency
from public.products p
where p.price is not null or p.discounted_price is not null
on conflict (seller_id, nm_id, price_date) do update set
  price = excluded.price,
  discounted_price = excluded.discounted_price,
  club_discounted_price = excluded.club_discounted_price,
  currency = excluded.currency,
  loaded_at = now();

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
  pp.price,
  pp.discounted_price
from public.fbo_stocks s
left join public.products p
  on p.seller_id = s.seller_id
 and p.nm_id = s.nm_id
left join public.product_prices_daily pp
  on pp.seller_id = s.seller_id
 and pp.nm_id = s.nm_id
 and pp.price_date = s.snapshot_date;

comment on view public.sheet_fbo_stocks is
  'Остатки FBW. vendor_code — products; цены — product_prices_daily на дату снимка.';

revoke all on table public.sheet_fbo_stocks from public, anon, authenticated;
grant select on table public.sheet_fbo_stocks to anon, authenticated;
