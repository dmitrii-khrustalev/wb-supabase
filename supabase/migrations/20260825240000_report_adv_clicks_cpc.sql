-- Ads report expenses = clicks × CPC, same as «Расходы рекламы» in the battle sheet.

drop index if exists public.adv_stats_report_daily_idx;

create index adv_stats_report_daily_idx
  on public.adv_stats (seller_id, stat_date)
  include (nm_id, name, clicks, cpc);

analyze public.adv_stats;

create or replace function public.report_adv_daily(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  title text,
  day date,
  spend numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  select
    btrim(p.vendor_code) as sa_name,
    max(btrim(p.title)) as title,
    a.stat_date as day,
    sum(coalesce(a.clicks, 0) * coalesce(a.cpc, 0)) as spend
  from (
    select seller_id, nm_id, name, stat_date, clicks, cpc
    from public.adv_stats
    where seller_id = p_seller_id
      and stat_date >= p_from
      and stat_date <= p_to
      and nullif(nm_id, '') is not null
  ) a
  join public.products p
    on p.seller_id = a.seller_id
   and p.nm_id = a.nm_id
  where nullif(btrim(p.vendor_code), '') is not null
    and btrim(p.vendor_code) <> '-'
    and nullif(btrim(p.title), '') is not null
    and btrim(p.title) <> '-'
  group by btrim(p.vendor_code), a.stat_date
  order by 1, 3;
$$;

comment on function public.report_adv_daily(uuid, date, date) is
  'Свёртка рекламы: расход = клики × CPC по артикулу × дню.';

revoke all on function public.report_adv_daily(uuid, date, date) from public;
grant execute on function public.report_adv_daily(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
