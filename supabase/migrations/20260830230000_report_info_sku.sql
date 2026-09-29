-- SKU dashboards: period windows + daily facts + card / ranking RPCs.

create schema if not exists private;
revoke all on schema private from public;

create index if not exists finance_rows_seller_nm_dt_idx
  on public.finance_rows (seller_id, nm_id, rr_dt);

create index if not exists adv_stats_seller_nm_dt_idx
  on public.adv_stats (seller_id, nm_id, stat_date);

create index if not exists fbo_orders_seller_nm_dt_idx
  on public.fbo_orders (seller_id, nm_id, order_dt);

create index if not exists fbo_stocks_seller_nm_dt_idx
  on public.fbo_stocks (seller_id, nm_id, snapshot_date);

create index if not exists fbs_stocks_seller_nm_dt_idx
  on public.fbs_stocks (seller_id, nm_id, snapshot_date);

create or replace function private.info_period_windows(
  p_grain text,
  p_compare text,
  p_anchor date,
  p_today date
)
returns table (
  grain text,
  compare text,
  anchor date,
  cur_from date,
  cur_to date,
  prev_from date,
  prev_to date,
  complete boolean
)
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  g text;
  c text;
  a date;
  today date;
  week_start date;
  week_end date;
  month_start date;
  month_end date;
  prev_month date;
begin
  today := coalesce(p_today, current_date);
  g := lower(btrim(coalesce(p_grain, 'day')));
  if g not in ('day', 'week', 'month') then
    g := 'day';
  end if;
  c := lower(btrim(coalesce(p_compare, g)));
  if g = 'day' and c not in ('day', 'week', 'month') then
    c := 'day';
  elsif g = 'week' and c not in ('week', 'month') then
    c := 'week';
  elsif g = 'month' then
    c := 'month';
  end if;

  if p_anchor is null then
    if g = 'day' then
      a := today - 1;
    elsif g = 'week' then
      a := today - extract(isodow from today)::int;
    else
      a := today - 1;
    end if;
  else
    a := p_anchor;
    if a >= today then
      a := today - 1;
    end if;
  end if;

  if g = 'day' then
    grain := g;
    compare := c;
    anchor := a;
    cur_from := a;
    cur_to := a;
    if c = 'day' then
      prev_from := a - 1;
    elsif c = 'week' then
      prev_from := a - 7;
    else
      prev_from := (a - interval '1 month')::date;
    end if;
    prev_to := prev_from;
    complete := true;
    return next;
    return;
  end if;

  if g = 'week' then
    week_start := date_trunc('week', a)::date;
    week_end := week_start + 6;
    grain := g;
    compare := c;
    anchor := a;
    cur_from := week_start;
    if week_end >= today then
      cur_to := today - 1;
      complete := false;
    else
      cur_to := week_end;
      complete := true;
    end if;
    if cur_to < cur_from then
      cur_to := cur_from;
    end if;
    if c = 'week' then
      prev_from := week_start - 7;
    else
      prev_from := date_trunc('week', (week_start - interval '1 month')::date)::date;
    end if;
    prev_to := prev_from + (cur_to - cur_from);
    return next;
    return;
  end if;

  month_start := date_trunc('month', a)::date;
  month_end := (date_trunc('month', a) + interval '1 month - 1 day')::date;
  grain := g;
  compare := c;
  anchor := a;
  cur_from := month_start;
  if month_end >= today then
    cur_to := least(today - 1, month_end);
    complete := false;
  else
    cur_to := month_end;
    complete := true;
  end if;
  if cur_to < cur_from then
    cur_to := cur_from;
  end if;
  prev_month := (month_start - interval '1 month')::date;
  prev_from := prev_month;
  if complete then
    prev_to := month_start - 1;
  else
    prev_to := prev_from + (cur_to - cur_from);
    if prev_to >= month_start then
      prev_to := month_start - 1;
    end if;
  end if;
  return next;
end;
$$;

revoke all on function private.info_period_windows(text, text, date, date) from public;

create or replace function private.info_sku_daily(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_nm_id text default null
)
returns table (
  nm_id text,
  d date,
  qty_net numeric,
  qty_sales numeric,
  qty_returns numeric,
  retail_net numeric,
  for_pay numeric,
  commission numeric,
  logistics numeric,
  storage numeric,
  acceptance numeric,
  acquiring numeric,
  additional numeric,
  deduction numeric,
  penalty numeric,
  ads_spend numeric,
  ads_views numeric,
  ads_clicks numeric,
  ads_orders numeric,
  ads_atbs numeric,
  fbo_orders bigint,
  fbo_cancels bigint,
  fbo_sum numeric,
  fbs_orders bigint,
  fbs_cancels bigint,
  fbs_sum numeric,
  fbs_sorted bigint,
  fbs_waiting bigint,
  fbo_stock numeric,
  fbs_stock numeric,
  in_way_to numeric,
  in_way_from numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '90s'
as $$
  with fin as (
    select
      f.nm_id,
      f.rr_dt as d,
      sum(
        case f.doc_type_name
          when 'Продажа' then coalesce(f.quantity, 0)
          when 'Возврат' then -coalesce(f.quantity, 0)
          else 0
        end
      ) as qty_net,
      sum(case when f.doc_type_name = 'Продажа' then coalesce(f.quantity, 0) else 0 end) as qty_sales,
      sum(case when f.doc_type_name = 'Возврат' then coalesce(f.quantity, 0) else 0 end) as qty_returns,
      sum(
        case f.doc_type_name
          when 'Продажа' then coalesce(f.retail_amount, 0)
          when 'Возврат' then -coalesce(f.retail_amount, 0)
          else 0
        end
      ) as retail_net,
      sum(private.num_text(f.extra->>'ppvz_for_pay')) as for_pay,
      sum(private.num_text(f.extra->>'ppvz_sales_commission')) as commission,
      sum(private.num_text(f.extra->>'delivery_rub')) as logistics,
      sum(private.num_text(f.extra->>'storage_fee')) as storage,
      sum(private.num_text(f.extra->>'acceptance')) as acceptance,
      sum(private.num_text(f.extra->>'acquiring_fee')) as acquiring,
      sum(private.num_text(f.extra->>'additional_payment')) as additional,
      sum(private.num_text(f.extra->>'deduction')) as deduction,
      sum(private.num_text(f.extra->>'penalty')) as penalty
    from public.finance_rows f
    where f.seller_id = p_seller_id
      and f.rr_dt >= p_from
      and f.rr_dt <= p_to
      and nullif(btrim(f.nm_id), '') is not null
      and (p_nm_id is null or f.nm_id = p_nm_id)
    group by 1, 2
  ),
  ads as (
    select
      a.nm_id,
      a.stat_date as d,
      sum(coalesce(a.clicks, 0) * coalesce(a.cpc, 0)) as ads_spend,
      sum(coalesce(a.views, 0)) as ads_views,
      sum(coalesce(a.clicks, 0)) as ads_clicks,
      sum(coalesce(a.orders, 0)) as ads_orders,
      sum(coalesce(a.atbs, 0)) as ads_atbs
    from public.adv_stats a
    where a.seller_id = p_seller_id
      and a.stat_date >= p_from
      and a.stat_date <= p_to
      and nullif(btrim(a.nm_id), '') is not null
      and (p_nm_id is null or a.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbo as (
    select
      o.nm_id,
      (o.order_dt at time zone 'Europe/Moscow')::date as d,
      count(*) filter (where coalesce(o.is_cancel, false) = false) as fbo_orders,
      count(*) filter (where coalesce(o.is_cancel, false) = true) as fbo_cancels,
      sum(coalesce(o.finished_price, 0)) filter (where coalesce(o.is_cancel, false) = false) as fbo_sum
    from public.fbo_orders o
    where o.seller_id = p_seller_id
      and o.order_dt >= (p_from::timestamp at time zone 'Europe/Moscow')
      and o.order_dt < ((p_to + 1)::timestamp at time zone 'Europe/Moscow')
      and nullif(btrim(o.nm_id), '') is not null
      and (p_nm_id is null or o.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbs as (
    select
      o.nm_id,
      (o.created_at at time zone 'Europe/Moscow')::date as d,
      count(*) as fbs_orders,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) like '%cancel%'
           or lower(coalesce(o.wb_status, '')) like '%declined%'
           or lower(coalesce(o.wb_status, '')) like '%отмен%'
      ) as fbs_cancels,
      coalesce(sum(private.wb_kop_rub(o.extra->>'price')), 0) as fbs_sum,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) in ('sorted', 'ready_for_pickup')
           or lower(coalesce(o.wb_status, '')) like '%отсортир%'
           or lower(coalesce(o.wb_status, '')) like '%пвз%'
      ) as fbs_sorted,
      count(*) filter (
        where lower(coalesce(o.wb_status, '')) = 'waiting'
      ) as fbs_waiting
    from public.fbs_orders o
    where o.seller_id = p_seller_id
      and o.created_at is not null
      and (o.created_at at time zone 'Europe/Moscow')::date >= p_from
      and (o.created_at at time zone 'Europe/Moscow')::date <= p_to
      and nullif(btrim(o.nm_id), '') is not null
      and (p_nm_id is null or o.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbo_stk as (
    select
      s.nm_id,
      s.snapshot_date as d,
      sum(coalesce(s.quantity, 0)) as fbo_stock,
      sum(private.num_text(s.extra->>'inWayToClient')) as in_way_to,
      sum(private.num_text(s.extra->>'inWayFromClient')) as in_way_from
    from public.fbo_stocks s
    where s.seller_id = p_seller_id
      and s.snapshot_date >= p_from
      and s.snapshot_date <= p_to
      and nullif(btrim(s.nm_id), '') is not null
      and (p_nm_id is null or s.nm_id = p_nm_id)
    group by 1, 2
  ),
  fbs_stk as (
    select
      coalesce(nullif(btrim(s.nm_id), ''), nullif(btrim(z.nm_id), '')) as nm_id,
      s.snapshot_date as d,
      sum(coalesce(s.amount, 0)) as fbs_stock
    from public.fbs_stocks s
    left join public.product_sizes z
      on z.seller_id = s.seller_id
     and z.chrt_id = s.chrt_id
    where s.seller_id = p_seller_id
      and s.snapshot_date >= p_from
      and s.snapshot_date <= p_to
      and coalesce(nullif(btrim(s.nm_id), ''), nullif(btrim(z.nm_id), '')) is not null
      and (
        p_nm_id is null
        or coalesce(nullif(btrim(s.nm_id), ''), nullif(btrim(z.nm_id), '')) = p_nm_id
      )
    group by 1, 2
  ),
  keys as (
    select nm_id, d from fin
    union
    select nm_id, d from ads
    union
    select nm_id, d from fbo
    union
    select nm_id, d from fbs
    union
    select nm_id, d from fbo_stk
    union
    select nm_id, d from fbs_stk
  )
  select
    k.nm_id,
    k.d,
    coalesce(f.qty_net, 0),
    coalesce(f.qty_sales, 0),
    coalesce(f.qty_returns, 0),
    coalesce(f.retail_net, 0),
    coalesce(f.for_pay, 0),
    coalesce(f.commission, 0),
    coalesce(f.logistics, 0),
    coalesce(f.storage, 0),
    coalesce(f.acceptance, 0),
    coalesce(f.acquiring, 0),
    coalesce(f.additional, 0),
    coalesce(f.deduction, 0),
    coalesce(f.penalty, 0),
    coalesce(a.ads_spend, 0),
    coalesce(a.ads_views, 0),
    coalesce(a.ads_clicks, 0),
    coalesce(a.ads_orders, 0),
    coalesce(a.ads_atbs, 0),
    coalesce(o.fbo_orders, 0),
    coalesce(o.fbo_cancels, 0),
    coalesce(o.fbo_sum, 0),
    coalesce(b.fbs_orders, 0),
    coalesce(b.fbs_cancels, 0),
    coalesce(b.fbs_sum, 0),
    coalesce(b.fbs_sorted, 0),
    coalesce(b.fbs_waiting, 0),
    s.fbo_stock,
    fs.fbs_stock,
    s.in_way_to,
    s.in_way_from
  from keys k
  left join fin f on f.nm_id = k.nm_id and f.d = k.d
  left join ads a on a.nm_id = k.nm_id and a.d = k.d
  left join fbo o on o.nm_id = k.nm_id and o.d = k.d
  left join fbs b on b.nm_id = k.nm_id and b.d = k.d
  left join fbo_stk s on s.nm_id = k.nm_id and s.d = k.d
  left join fbs_stk fs on fs.nm_id = k.nm_id and fs.d = k.d;
$$;

revoke all on function private.info_sku_daily(uuid, date, date, text) from public;

create or replace function public.report_info_sku_list(p_seller_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'nm_id', p.nm_id,
    'sa_name', p.vendor_code,
    'title', p.title,
    'brand', p.brand,
    'price', p.discounted_price
  ) order by p.vendor_code, p.nm_id), '[]'::jsonb)
  from public.products p
  where p.seller_id = p_seller_id
    and nullif(btrim(p.nm_id), '') is not null;
$$;

comment on function public.report_info_sku_list(uuid) is
  'Список карточек для выбора в дашборде sku.';

revoke all on function public.report_info_sku_list(uuid) from public;
grant execute on function public.report_info_sku_list(uuid) to anon, authenticated;

create or replace function private.info_sku_first_date(p_seller_id uuid, p_nm_id text)
returns date
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select min(x.d)
  from (
    select min(rr_dt) as d
    from public.finance_rows
    where seller_id = p_seller_id and nm_id = p_nm_id
    union all
    select min(stat_date)
    from public.adv_stats
    where seller_id = p_seller_id and nm_id = p_nm_id
    union all
    select min((order_dt at time zone 'Europe/Moscow')::date)
    from public.fbo_orders
    where seller_id = p_seller_id and nm_id = p_nm_id
    union all
    select min((created_at at time zone 'Europe/Moscow')::date)
    from public.fbs_orders
    where seller_id = p_seller_id and nm_id = p_nm_id
    union all
    select min(snapshot_date)
    from public.fbo_stocks
    where seller_id = p_seller_id and nm_id = p_nm_id
    union all
    select min(snapshot_date)
    from public.fbs_stocks
    where seller_id = p_seller_id and nm_id = p_nm_id
  ) x;
$$;

revoke all on function private.info_sku_first_date(uuid, text) from public;

create or replace function public.report_info_sku(
  p_seller_id uuid,
  p_nm_id text default null,
  p_sa_name text default null,
  p_anchor date default null,
  p_grain text default 'day',
  p_compare text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '90s'
as $$
declare
  today date := (timezone('Europe/Moscow', now()))::date;
  w record;
  nm text;
  sa text;
  title text;
  brand text;
  price numeric;
  journal_from date;
  payload jsonb;
begin
  select
    p.nm_id, p.vendor_code, p.title, p.brand, coalesce(p.discounted_price, p.price)
  into nm, sa, title, brand, price
  from public.products p
  where p.seller_id = p_seller_id
    and (
      (nullif(btrim(p_nm_id), '') is not null and p.nm_id = btrim(p_nm_id))
      or (
        nullif(btrim(p_sa_name), '') is not null
        and upper(replace(btrim(p.vendor_code), 'Х', 'X'))
          = upper(replace(btrim(p_sa_name), 'Х', 'X'))
      )
    )
  order by
    case when nullif(btrim(p_nm_id), '') is not null and p.nm_id = btrim(p_nm_id) then 0 else 1 end
  limit 1;

  if nm is null then
    nm := nullif(btrim(p_nm_id), '');
  end if;
  if nm is null then
    raise exception 'Не найден товар';
  end if;

  select * into w
  from private.info_period_windows(p_grain, p_compare, p_anchor, today);

  journal_from := coalesce(
    private.info_sku_first_date(p_seller_id, nm),
    least(w.cur_from, w.prev_from)
  );

  with daily as (
    select *
    from private.info_sku_daily(p_seller_id, journal_from, w.cur_to, nm)
  ),
  cab as (
    select
      sum(qty_net) filter (where d >= w.cur_from and d <= w.cur_to) as qty,
      sum(retail_net) filter (where d >= w.cur_from and d <= w.cur_to) as retail,
      sum(for_pay) filter (where d >= w.cur_from and d <= w.cur_to) as for_pay,
      sum(ads_spend) filter (where d >= w.cur_from and d <= w.cur_to) as ads,
      sum(fbo_orders + fbs_orders) filter (where d >= w.cur_from and d <= w.cur_to) as orders
    from private.info_sku_daily(p_seller_id, least(w.prev_from, w.cur_from), w.cur_to, null)
  ),
  cur as (
    select
      coalesce(sum(qty_net), 0) as qty_net,
      coalesce(sum(qty_sales), 0) as qty_sales,
      coalesce(sum(qty_returns), 0) as qty_returns,
      coalesce(sum(retail_net), 0) as retail_net,
      coalesce(sum(for_pay), 0) as for_pay,
      coalesce(sum(commission), 0) as commission,
      coalesce(sum(logistics), 0) as logistics,
      coalesce(sum(storage), 0) as storage,
      coalesce(sum(acceptance), 0) as acceptance,
      coalesce(sum(acquiring), 0) as acquiring,
      coalesce(sum(additional), 0) as additional,
      coalesce(sum(deduction), 0) as deduction,
      coalesce(sum(penalty), 0) as penalty,
      coalesce(sum(ads_spend), 0) as ads_spend,
      coalesce(sum(ads_views), 0) as ads_views,
      coalesce(sum(ads_clicks), 0) as ads_clicks,
      coalesce(sum(ads_orders), 0) as ads_orders,
      coalesce(sum(ads_atbs), 0) as ads_atbs,
      coalesce(sum(fbo_orders), 0) as fbo_orders,
      coalesce(sum(fbo_cancels), 0) as fbo_cancels,
      coalesce(sum(fbo_sum), 0) as fbo_sum,
      coalesce(sum(fbs_orders), 0) as fbs_orders,
      coalesce(sum(fbs_cancels), 0) as fbs_cancels,
      coalesce(sum(fbs_sum), 0) as fbs_sum,
      coalesce(sum(fbs_sorted), 0) as fbs_sorted,
      coalesce(sum(fbs_waiting), 0) as fbs_waiting,
      (array_agg(fbo_stock order by d desc) filter (where fbo_stock is not null))[1] as fbo_stock,
      (array_agg(fbs_stock order by d desc) filter (where fbs_stock is not null))[1] as fbs_stock,
      (array_agg(in_way_to order by d desc) filter (where in_way_to is not null))[1] as in_way_to,
      (array_agg(in_way_from order by d desc) filter (where in_way_from is not null))[1] as in_way_from
    from daily
    where d >= w.cur_from and d <= w.cur_to
  ),
  prev as (
    select
      coalesce(sum(qty_net), 0) as qty_net,
      coalesce(sum(qty_sales), 0) as qty_sales,
      coalesce(sum(qty_returns), 0) as qty_returns,
      coalesce(sum(retail_net), 0) as retail_net,
      coalesce(sum(for_pay), 0) as for_pay,
      coalesce(sum(commission), 0) as commission,
      coalesce(sum(logistics), 0) as logistics,
      coalesce(sum(storage), 0) as storage,
      coalesce(sum(acceptance), 0) as acceptance,
      coalesce(sum(acquiring), 0) as acquiring,
      coalesce(sum(deduction), 0) as deduction,
      coalesce(sum(penalty), 0) as penalty,
      coalesce(sum(ads_spend), 0) as ads_spend,
      coalesce(sum(ads_views), 0) as ads_views,
      coalesce(sum(ads_clicks), 0) as ads_clicks,
      coalesce(sum(ads_orders), 0) as ads_orders,
      coalesce(sum(ads_atbs), 0) as ads_atbs,
      coalesce(sum(fbo_orders), 0) as fbo_orders,
      coalesce(sum(fbo_cancels), 0) as fbo_cancels,
      coalesce(sum(fbo_sum), 0) as fbo_sum,
      coalesce(sum(fbs_orders), 0) as fbs_orders,
      coalesce(sum(fbs_cancels), 0) as fbs_cancels,
      coalesce(sum(fbs_sum), 0) as fbs_sum,
      coalesce(sum(fbs_sorted), 0) as fbs_sorted,
      coalesce(sum(fbs_waiting), 0) as fbs_waiting,
      (array_agg(fbo_stock order by d desc) filter (where fbo_stock is not null))[1] as fbo_stock,
      (array_agg(fbs_stock order by d desc) filter (where fbs_stock is not null))[1] as fbs_stock,
      (array_agg(in_way_to order by d desc) filter (where in_way_to is not null))[1] as in_way_to,
      (array_agg(in_way_from order by d desc) filter (where in_way_from is not null))[1] as in_way_from
    from daily
    where d >= w.prev_from and d <= w.prev_to
  ),
  days as (
    select generate_series(journal_from, w.cur_to, '1 day'::interval)::date as d
  ),
  dense as (
    select
      d.d,
      coalesce(x.qty_net, 0) as qty_net,
      coalesce(x.retail_net, 0) as retail_net,
      coalesce(x.for_pay, 0) as for_pay,
      coalesce(x.ads_spend, 0) as ads_spend,
      coalesce(x.fbo_orders, 0) as fbo_orders,
      coalesce(x.fbs_orders, 0) as fbs_orders,
      coalesce(x.fbo_cancels, 0) as fbo_cancels,
      coalesce(x.fbs_cancels, 0) as fbs_cancels,
      x.fbo_stock,
      x.fbs_stock
    from days d
    left join daily x on x.d = d.d
  ),
  journal_rows as (
    select
      p.period_start,
      case w.grain
        when 'day' then p.period_start
        when 'week' then p.period_start + 6
        else (date_trunc('month', p.period_start) + interval '1 month - 1 day')::date
      end as period_end,
      p.qty_net,
      p.retail_net,
      p.for_pay,
      p.ads_spend,
      p.fbo_orders,
      p.fbs_orders,
      p.fbo_cancels,
      p.fbs_cancels,
      p.fbo_stock,
      p.fbs_stock
    from (
      select
        case w.grain
          when 'day' then g.d
          when 'week' then date_trunc('week', g.d)::date
          else date_trunc('month', g.d)::date
        end as period_start,
        sum(g.qty_net) as qty_net,
        sum(g.retail_net) as retail_net,
        sum(g.for_pay) as for_pay,
        sum(g.ads_spend) as ads_spend,
        sum(g.fbo_orders) as fbo_orders,
        sum(g.fbs_orders) as fbs_orders,
        sum(g.fbo_cancels) as fbo_cancels,
        sum(g.fbs_cancels) as fbs_cancels,
        (array_agg(g.fbo_stock order by g.d desc) filter (where g.fbo_stock is not null))[1] as fbo_stock,
        (array_agg(g.fbs_stock order by g.d desc) filter (where g.fbs_stock is not null))[1] as fbs_stock
      from dense g
      group by 1
    ) p
  ),
  last_fbo as (
    select max(snapshot_date) as d
    from public.fbo_stocks
    where seller_id = p_seller_id and nm_id = nm
  ),
  last_fbs as (
    select max(s.snapshot_date) as d
    from public.fbs_stocks s
    left join public.product_sizes z
      on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
    where s.seller_id = p_seller_id
      and coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) = nm
  ),
  stocks_now as (
    select
      (select coalesce(sum(quantity), 0) from public.fbo_stocks s, last_fbo l
        where s.seller_id = p_seller_id and s.nm_id = nm and s.snapshot_date = l.d) as fbo_qty,
      (select l.d from last_fbo l) as fbo_snap,
      (select coalesce(sum(s.amount), 0)
        from public.fbs_stocks s
        left join public.product_sizes z on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
        join last_fbs l on s.snapshot_date = l.d
        where s.seller_id = p_seller_id
          and coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) = nm) as fbs_qty,
      (select l.d from last_fbs l) as fbs_snap,
      (select coalesce(sum(private.num_text(s.extra->>'inWayToClient')), 0)
        from public.fbo_stocks s, last_fbo l
        where s.seller_id = p_seller_id and s.nm_id = nm and s.snapshot_date = l.d) as in_way_to,
      (select coalesce(sum(private.num_text(s.extra->>'inWayFromClient')), 0)
        from public.fbo_stocks s, last_fbo l
        where s.seller_id = p_seller_id and s.nm_id = nm and s.snapshot_date = l.d) as in_way_from
  ),
  warehouses as (
    select coalesce(jsonb_agg(x.obj order by x.qty desc), '[]'::jsonb) as rows
    from (
      select
        jsonb_build_object(
          'warehouse', s.warehouse_name,
          'qty', round(sum(coalesce(s.quantity, 0)), 0)
        ) as obj,
        sum(coalesce(s.quantity, 0)) as qty
      from public.fbo_stocks s
      join last_fbo l on s.snapshot_date = l.d
      where s.seller_id = p_seller_id
        and s.nm_id = nm
        and coalesce(s.quantity, 0) > 0
      group by s.warehouse_name
    ) x
  ),
  supplies as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'status_id', x.status_id,
      'status_name', x.status_name,
      'qty', round(x.qty, 2)
    ) order by x.status_id), '[]'::jsonb) as rows
    from (
      select
        coalesce(s.extra->>'statusID', s.extra->>'statusId', '') as status_id,
        case coalesce(s.extra->>'statusID', s.extra->>'statusId')
          when '1' then 'Не запланировано'
          when '2' then 'Запланировано'
          when '3' then 'Отгрузка разрешена'
          when '4' then 'Идёт приёмка'
          when '5' then 'Принято'
          when '6' then 'Отгружено на воротах'
          else coalesce(s.extra->>'statusID', s.extra->>'statusId', '')
        end as status_name,
        sum(coalesce(g.quantity, 0)) as qty
      from public.fbw_supply_goods g
      join public.fbw_supplies s
        on s.seller_id = g.seller_id and s.supply_id = g.supply_id
      where g.seller_id = p_seller_id
        and g.nm_id = nm
        and coalesce(s.extra->>'statusID', s.extra->>'statusId', '') <> '5'
      group by 1, 2
    ) x
  ),
  fbs_sup as (
    select count(*)::integer as open_orders
    from public.fbs_supply_orders so
    join public.fbs_supplies s
      on s.seller_id = so.seller_id and s.supply_id = so.supply_id
    join public.fbs_orders o
      on o.seller_id = so.seller_id and o.order_id = so.order_id
    where so.seller_id = p_seller_id
      and s.done is not true
      and o.nm_id = nm
  )
  select jsonb_build_object(
    'grain', w.grain,
    'compare', w.compare,
    'complete', w.complete,
    'day', w.cur_to,
    'cur_from', w.cur_from,
    'cur_to', w.cur_to,
    'prev_from', w.prev_from,
    'prev_to', w.prev_to,
    'today', today,
    'updated_at', to_char(timezone('Europe/Moscow', now()), 'YYYY-MM-DD HH24:MI'),
    'product', jsonb_build_object(
      'nm_id', nm,
      'sa_name', sa,
      'title', title,
      'brand', brand,
      'price', price
    ),
    'kpi', jsonb_build_object(
      'qty', round(c.qty_net, 2),
      'qty_prev', round(p.qty_net, 2),
      'qty_cab', round(coalesce(cb.qty, 0), 2),
      'retail', round(c.retail_net, 2),
      'retail_prev', round(p.retail_net, 2),
      'retail_cab', round(coalesce(cb.retail, 0), 2),
      'for_pay', round(c.for_pay, 2),
      'for_pay_prev', round(p.for_pay, 2),
      'for_pay_cab', round(coalesce(cb.for_pay, 0), 2),
      'ads', round(c.ads_spend, 2),
      'ads_prev', round(p.ads_spend, 2),
      'ads_cab', round(coalesce(cb.ads, 0), 2),
      'drr', case when c.retail_net <> 0 then round(c.ads_spend / c.retail_net, 4) else null end,
      'drr_prev', case when p.retail_net <> 0 then round(p.ads_spend / p.retail_net, 4) else null end,
      'orders', c.fbo_orders + c.fbs_orders,
      'orders_prev', p.fbo_orders + p.fbs_orders,
      'orders_cab', coalesce(cb.orders, 0)
    ),
    'finance', jsonb_build_object(
      'qty', round(c.qty_net, 2),
      'qty_sales', round(c.qty_sales, 2),
      'qty_returns', round(c.qty_returns, 2),
      'qty_returns_prev', round(p.qty_returns, 2),
      'retail', round(c.retail_net, 2),
      'avg_check', case when c.qty_net <> 0 then round(c.retail_net / c.qty_net, 2) else null end,
      'avg_check_prev', case when p.qty_net <> 0 then round(p.retail_net / p.qty_net, 2) else null end,
      'card_price', price,
      'for_pay', round(c.for_pay, 2),
      'commission', round(c.commission, 2),
      'commission_prev', round(p.commission, 2),
      'logistics', round(c.logistics, 2),
      'logistics_prev', round(p.logistics, 2),
      'storage', round(c.storage, 2),
      'storage_prev', round(p.storage, 2),
      'acceptance', round(c.acceptance, 2),
      'acceptance_prev', round(p.acceptance, 2),
      'acquiring', round(c.acquiring, 2),
      'acquiring_prev', round(p.acquiring, 2),
      'additional', round(c.additional, 2),
      'deduction', round(c.deduction, 2),
      'deduction_prev', round(p.deduction, 2),
      'penalty', round(c.penalty, 2),
      'penalty_prev', round(p.penalty, 2)
    ),
    'ads', jsonb_build_object(
      'spend', round(c.ads_spend, 2),
      'views', round(c.ads_views, 0),
      'views_prev', round(p.ads_views, 0),
      'clicks', round(c.ads_clicks, 0),
      'clicks_prev', round(p.ads_clicks, 0),
      'cpc', case when c.ads_clicks <> 0 then round(c.ads_spend / c.ads_clicks, 2) else null end,
      'cpc_prev', case when p.ads_clicks <> 0 then round(p.ads_spend / p.ads_clicks, 2) else null end,
      'ctr', case when c.ads_views <> 0 then round(c.ads_clicks / c.ads_views, 4) else null end,
      'ctr_prev', case when p.ads_views <> 0 then round(p.ads_clicks / p.ads_views, 4) else null end,
      'orders', round(c.ads_orders, 0),
      'orders_prev', round(p.ads_orders, 0),
      'atbs', round(c.ads_atbs, 0),
      'drr', case when c.retail_net <> 0 then round(c.ads_spend / c.retail_net, 4) else null end,
      'after_ads', round(c.for_pay - c.ads_spend, 2),
      'after_ads_prev', round(p.for_pay - p.ads_spend, 2)
    ),
    'fbo', jsonb_build_object(
      'orders', c.fbo_orders,
      'orders_prev', p.fbo_orders,
      'cancels', c.fbo_cancels,
      'cancels_prev', p.fbo_cancels,
      'sum', round(c.fbo_sum, 2),
      'sum_prev', round(p.fbo_sum, 2)
    ),
    'fbs', jsonb_build_object(
      'orders', c.fbs_orders,
      'orders_prev', p.fbs_orders,
      'cancels', c.fbs_cancels,
      'cancels_prev', p.fbs_cancels,
      'sum', round(c.fbs_sum, 2),
      'sum_prev', round(p.fbs_sum, 2),
      'sorted', c.fbs_sorted,
      'sorted_prev', p.fbs_sorted,
      'waiting', c.fbs_waiting,
      'waiting_prev', p.fbs_waiting
    ),
    'stocks', jsonb_build_object(
      'fbo_qty', round(coalesce(sn.fbo_qty, 0), 0),
      'fbo_qty_prev', round(coalesce(p.fbo_stock, 0), 0),
      'fbs_qty', round(coalesce(sn.fbs_qty, 0), 0),
      'fbs_qty_prev', round(coalesce(p.fbs_stock, 0), 0),
      'in_way_to', round(coalesce(sn.in_way_to, 0), 0),
      'in_way_to_prev', round(coalesce(p.in_way_to, 0), 0),
      'in_way_from', round(coalesce(sn.in_way_from, 0), 0),
      'in_way_from_prev', round(coalesce(p.in_way_from, 0), 0),
      'fbo_snap', sn.fbo_snap,
      'fbs_snap', sn.fbs_snap,
      'days', case
        when (c.fbo_orders + c.fbs_orders) > 0
          then round(
            (coalesce(sn.fbo_qty, 0) + coalesce(sn.fbs_qty, 0))
            / ((c.fbo_orders + c.fbs_orders)::numeric / greatest((w.cur_to - w.cur_from) + 1, 1)),
            1
          )
        else null
      end,
      'warehouses', coalesce((select rows from warehouses), '[]'::jsonb)
    ),
    'supplies', coalesce((select rows from supplies), '[]'::jsonb),
    'fbs_supplies', jsonb_build_object('open_orders', coalesce((select open_orders from fbs_sup), 0)),
    'journal', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day', j.period_start,
        'week_end', j.period_end,
        'qty', round(j.qty_net, 2),
        'retail', round(j.retail_net, 2),
        'for_pay', round(j.for_pay, 2),
        'ads', round(j.ads_spend, 2),
        'drr', case when j.retail_net <> 0 then round(j.ads_spend / j.retail_net, 4) else null end,
        'fbo', j.fbo_orders,
        'fbs', j.fbs_orders,
        'fbo_cancels', j.fbo_cancels,
        'fbs_cancels', j.fbs_cancels,
        'fbo_stock', j.fbo_stock,
        'fbs_stock', j.fbs_stock
      ) order by j.period_start desc), '[]'::jsonb)
      from journal_rows j
    )
  )
  into payload
  from cur c
  cross join prev p
  cross join cab cb
  cross join stocks_now sn;

  return payload;
end;
$$;

comment on function public.report_info_sku(uuid, text, text, date, text, text) is
  'Карточка товара: окно grain/compare, KPI, блоки, журнал.';

revoke all on function public.report_info_sku(uuid, text, text, date, text, text) from public;
grant execute on function public.report_info_sku(uuid, text, text, date, text, text) to anon, authenticated;

create or replace function public.report_info_sku_all(
  p_seller_id uuid,
  p_anchor date default null,
  p_grain text default 'day',
  p_compare text default 'day'
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
set statement_timeout = '90s'
as $$
  with today as (
    select (timezone('Europe/Moscow', now()))::date as d
  ),
  w as (
    select *
    from private.info_period_windows(
      p_grain,
      p_compare,
      p_anchor,
      (select d from today)
    )
  ),
  daily as (
    select x.*
    from w
    cross join lateral private.info_sku_daily(
      p_seller_id,
      least(w.prev_from, w.cur_from),
      w.cur_to,
      null
    ) x
  ),
  cur as (
    select
      d.nm_id,
      coalesce(sum(d.qty_net), 0) as qty_net,
      coalesce(sum(d.qty_sales), 0) as qty_sales,
      coalesce(sum(d.qty_returns), 0) as qty_returns,
      coalesce(sum(d.retail_net), 0) as retail_net,
      coalesce(sum(d.for_pay), 0) as for_pay,
      coalesce(sum(d.ads_spend), 0) as ads_spend,
      coalesce(sum(d.fbo_orders), 0) as fbo_orders,
      coalesce(sum(d.fbs_orders), 0) as fbs_orders,
      coalesce(sum(d.fbo_cancels + d.fbs_cancels), 0) as cancels
    from daily d
    join w on true
    where d.d >= w.cur_from and d.d <= w.cur_to
    group by 1
  ),
  prev as (
    select
      d.nm_id,
      coalesce(sum(d.qty_net), 0) as qty_net,
      coalesce(sum(d.qty_returns), 0) as qty_returns,
      coalesce(sum(d.retail_net), 0) as retail_net,
      coalesce(sum(d.for_pay), 0) as for_pay,
      coalesce(sum(d.ads_spend), 0) as ads_spend,
      coalesce(sum(d.fbo_orders + d.fbs_orders), 0) as orders
    from daily d
    join w on true
    where d.d >= w.prev_from and d.d <= w.prev_to
    group by 1
  ),
  last_fbo as (
    select nm_id, max(snapshot_date) as d
    from public.fbo_stocks
    where seller_id = p_seller_id
    group by 1
  ),
  last_fbs as (
    select
      coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) as nm_id,
      max(s.snapshot_date) as d
    from public.fbs_stocks s
    left join public.product_sizes z
      on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
    where s.seller_id = p_seller_id
      and coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) is not null
    group by 1
  ),
  stk_fbo as (
    select s.nm_id, sum(coalesce(s.quantity, 0)) as qty
    from public.fbo_stocks s
    join last_fbo l on l.nm_id = s.nm_id and l.d = s.snapshot_date
    where s.seller_id = p_seller_id
    group by 1
  ),
  stk_fbs as (
    select
      coalesce(nullif(btrim(s.nm_id), ''), z.nm_id) as nm_id,
      sum(coalesce(s.amount, 0)) as qty
    from public.fbs_stocks s
    left join public.product_sizes z
      on z.seller_id = s.seller_id and z.chrt_id = s.chrt_id
    join last_fbs l
      on l.nm_id = coalesce(nullif(btrim(s.nm_id), ''), z.nm_id)
     and l.d = s.snapshot_date
    where s.seller_id = p_seller_id
    group by 1
  ),
  nms as (
    select p.nm_id from public.products p where p.seller_id = p_seller_id
    union
    select nm_id from cur
    union
    select nm_id from prev
    union
    select nm_id from stk_fbo
    union
    select nm_id from stk_fbs
  ),
  cab as (
    select
      coalesce(sum(qty_net), 0) as qty,
      coalesce(sum(retail_net), 0) as retail,
      coalesce(sum(for_pay), 0) as for_pay,
      coalesce(sum(ads_spend), 0) as ads,
      coalesce(sum(fbo_orders + fbs_orders), 0) as orders
    from cur
  ),
  rows as (
    select
      n.nm_id,
      pr.vendor_code as sa_name,
      pr.title,
      coalesce(c.qty_net, 0) as qty,
      coalesce(pv.qty_net, 0) as qty_prev,
      coalesce(c.qty_returns, 0) as qty_returns,
      coalesce(c.qty_sales, 0) as qty_sales,
      coalesce(c.retail_net, 0) as retail,
      coalesce(pv.retail_net, 0) as retail_prev,
      coalesce(c.for_pay, 0) as for_pay,
      coalesce(pv.for_pay, 0) as for_pay_prev,
      coalesce(c.ads_spend, 0) as ads,
      coalesce(pv.ads_spend, 0) as ads_prev,
      coalesce(c.fbo_orders + c.fbs_orders, 0) as orders,
      coalesce(pv.orders, 0) as orders_prev,
      coalesce(c.cancels, 0) as cancels,
      coalesce(sf.qty, 0) as fbo_stock,
      coalesce(ss.qty, 0) as fbs_stock
    from nms n
    left join public.products pr
      on pr.seller_id = p_seller_id and pr.nm_id = n.nm_id
    left join cur c on c.nm_id = n.nm_id
    left join prev pv on pv.nm_id = n.nm_id
    left join stk_fbo sf on sf.nm_id = n.nm_id
    left join stk_fbs ss on ss.nm_id = n.nm_id
  ),
  packed as (
    select
      r.*,
      case when r.retail <> 0 then r.ads / r.retail else null end as drr,
      case when r.retail_prev <> 0 then r.ads_prev / r.retail_prev else null end as drr_prev,
      r.for_pay - r.ads as after_ads,
      case
        when r.orders > 0 then
          (r.fbo_stock + r.fbs_stock)
          / (r.orders::numeric / greatest((select (cur_to - cur_from) + 1 from w), 1))
        else null
      end as days_left,
      case when (select retail from cab) <> 0 then r.retail / (select retail from cab) else null end as share
    from rows r
  ),
  flagged as (
    select
      p.*,
      nullif(concat_ws(', ',
        case when p.fbo_stock + p.fbs_stock <= 0 and p.orders > 0 then 'нет остатка' end,
        case
          when p.retail > 0
           and p.drr is not null
           and (select ads from cab) is not null
           and (select retail from cab) > 0
           and p.drr > 2 * ((select ads from cab) / (select retail from cab))
          then 'ДРР×2'
        end,
        case when p.retail_prev > 0 and p.retail <= p.retail_prev * 0.5 then '−50% выр.' end,
        case when p.qty_sales > 0 and p.qty_returns / p.qty_sales > 0.15 then 'возвраты' end,
        case
          when p.retail_prev > 0
           and p.retail >= p.retail_prev * 1.3
           and (p.drr_prev is null or p.drr is null or p.drr <= p.drr_prev)
          then 'рост'
        end,
        case when p.days_left is not null and p.days_left < 7 then 'остаток <7д' end,
        case when p.after_ads < 0 then 'после рекламы <0' end,
        case when p.qty_prev = 0 and p.qty > 0 then 'новый' end
      ), '') as flags
    from packed p
  )
  select jsonb_build_object(
    'grain', (select grain from w),
    'compare', (select compare from w),
    'complete', (select complete from w),
    'cur_from', (select cur_from from w),
    'cur_to', (select cur_to from w),
    'prev_from', (select prev_from from w),
    'prev_to', (select prev_to from w),
    'today', (select d from today),
    'updated_at', to_char(timezone('Europe/Moscow', now()), 'YYYY-MM-DD HH24:MI'),
    'cab', jsonb_build_object(
      'qty', round((select qty from cab), 2),
      'retail', round((select retail from cab), 2),
      'for_pay', round((select for_pay from cab), 2),
      'ads', round((select ads from cab), 2),
      'orders', (select orders from cab),
      'drr', case
        when (select retail from cab) <> 0
          then round((select ads from cab) / (select retail from cab), 4)
        else null
      end
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nm_id', f.nm_id,
        'sa_name', f.sa_name,
        'title', f.title,
        'qty', round(f.qty, 2),
        'qty_prev', round(f.qty_prev, 2),
        'retail', round(f.retail, 2),
        'retail_prev', round(f.retail_prev, 2),
        'for_pay', round(f.for_pay, 2),
        'for_pay_prev', round(f.for_pay_prev, 2),
        'ads', round(f.ads, 2),
        'drr', case when f.drr is not null then round(f.drr, 4) else null end,
        'drr_prev', case when f.drr_prev is not null then round(f.drr_prev, 4) else null end,
        'after_ads', round(f.after_ads, 2),
        'orders', f.orders,
        'orders_prev', f.orders_prev,
        'cancels', f.cancels,
        'fbo_stock', round(f.fbo_stock, 0),
        'fbs_stock', round(f.fbs_stock, 0),
        'days', case when f.days_left is not null then round(f.days_left, 1) else null end,
        'share', case when f.share is not null then round(f.share, 4) else null end,
        'flags', f.flags
      ) order by f.retail desc, f.sa_name, f.nm_id)
      from flagged f
    ), '[]'::jsonb)
  );
$$;

comment on function public.report_info_sku_all(uuid, date, text, text) is
  'Рейтинг всех товаров за окно grain/compare.';

revoke all on function public.report_info_sku_all(uuid, date, text, text) from public;
grant execute on function public.report_info_sku_all(uuid, date, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
