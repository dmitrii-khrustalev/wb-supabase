-- «К-во заказов»: order_count из воронки продаж, не FBO API / ЗаказыЛК.

create or replace function public.report_sales_funnel_daily(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  title text,
  day date,
  qty numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with prod as (
    select distinct on (p.nm_id)
      p.nm_id::text as nm_id,
      nullif(btrim(p.vendor_code), '') as vendor_code,
      nullif(btrim(p.title), '') as title
    from public.products p
    where p.seller_id = p_seller_id
    order by p.nm_id, p.vendor_code nulls last
  ),
  rows as (
    select
      coalesce(nullif(btrim(f.vendor_code), ''), prod.vendor_code) as sa_name,
      coalesce(nullif(btrim(f.title), ''), prod.title) as title,
      f.stat_date as day,
      coalesce(f.order_count, 0)::numeric as qty
    from public.sales_funnel_daily f
    left join prod on prod.nm_id = f.nm_id::text
    where f.seller_id = p_seller_id
      and f.stat_date >= p_from
      and f.stat_date <= p_to
  )
  select
    btrim(sa_name) as sa_name,
    max(btrim(title)) as title,
    day,
    sum(qty) as qty
  from rows
  where nullif(btrim(sa_name), '') is not null
    and btrim(sa_name) <> '-'
  group by btrim(sa_name), day
  having max(nullif(btrim(title), '')) is not null
     and max(btrim(title)) <> '-'
  order by 1, 3;
$$;

comment on function public.report_sales_funnel_daily(uuid, date, date) is
  'К-во заказов: order_count из sales_funnel_daily, артикул vendor_code.';

grant execute on function public.report_sales_funnel_daily(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
