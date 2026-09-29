-- Orders report: same rules as ЗаказыЛК — all API rows (including cancels),
-- article from the order, name from the card.

drop index if exists public.fbo_orders_report_daily_idx;

create index fbo_orders_report_daily_idx
  on public.fbo_orders (seller_id, order_dt)
  include (nm_id, supplier_article);

analyze public.fbo_orders;

create or replace function public.report_fbo_orders_daily(
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
  select
    btrim(o.supplier_article) as sa_name,
    max(btrim(p.title)) as title,
    (o.order_dt at time zone 'Europe/Moscow')::date as day,
    count(*)::numeric as qty
  from public.fbo_orders o
  join public.products p
    on p.seller_id = o.seller_id
   and p.nm_id = o.nm_id
  where o.seller_id = p_seller_id
    and o.order_dt >= (p_from::timestamp at time zone 'Europe/Moscow')
    and o.order_dt < ((p_to + 1)::timestamp at time zone 'Europe/Moscow')
    and nullif(btrim(o.supplier_article), '') is not null
    and btrim(o.supplier_article) <> '-'
    and nullif(btrim(p.title), '') is not null
    and btrim(p.title) <> '-'
  group by 1, 3
  order by 1, 3;
$$;

create or replace function public.report_order_article_extras(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  returns numeric,
  stocks numeric,
  avg_price numeric,
  current_price numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with fin as (
    select
      btrim(f.sa_name) as sa_name,
      sum(
        case
          when f.doc_type_name = 'Возврат' then abs(coalesce(f.quantity, 0))
          else 0
        end
      ) as returns,
      avg(
        case
          when f.doc_type_name = 'Продажа'
           and coalesce(p.discounted_price, 0) > 0
          then p.discounted_price * coalesce(f.quantity, 0)
        end
      ) as avg_price
    from public.finance_rows f
    left join public.products p
      on p.seller_id = f.seller_id
     and p.nm_id = f.nm_id
    where f.seller_id = p_seller_id
      and f.rr_dt >= p_from
      and f.rr_dt <= p_to
      and f.doc_type_name in ('Продажа', 'Возврат')
      and nullif(btrim(f.sa_name), '') is not null
    group by 1
  ),
  last_snap as (
    select max(s.snapshot_date) as d
    from public.fbo_stocks s
    where s.seller_id = p_seller_id
  ),
  stk as (
    select
      btrim(p.vendor_code) as sa_name,
      sum(coalesce(s.quantity, 0)) as stocks
    from public.fbo_stocks s
    join last_snap l on s.snapshot_date = l.d
    join public.products p
      on p.seller_id = s.seller_id
     and p.nm_id = s.nm_id
    where s.seller_id = p_seller_id
      and nullif(btrim(p.vendor_code), '') is not null
    group by 1
  ),
  cur as (
    select
      btrim(p.vendor_code) as sa_name,
      max(p.discounted_price) as current_price
    from public.products p
    where p.seller_id = p_seller_id
      and nullif(btrim(p.vendor_code), '') is not null
    group by 1
  )
  select
    coalesce(fin.sa_name, stk.sa_name, cur.sa_name) as sa_name,
    coalesce(fin.returns, 0) as returns,
    coalesce(stk.stocks, 0) as stocks,
    fin.avg_price,
    cur.current_price
  from fin
  full join stk on stk.sa_name = fin.sa_name
  full join cur on cur.sa_name = coalesce(fin.sa_name, stk.sa_name);
$$;

notify pgrst, 'reload schema';
