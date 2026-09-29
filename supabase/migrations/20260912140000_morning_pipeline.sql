-- Morning pipeline: base 04:00, DMZ GAS 05:00, main GAS 06:00, summary ~07:00.
-- Unified daily_datasets() priority: money → stocks → orders → supplies → rest.

create or replace function public.daily_datasets()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'finance',
    'adv_stats',
    'products',
    'fbo_stocks',
    'fbs_stocks',
    'stocks_lk',
    'fbo_orders',
    'fbs_orders',
    'fbw_supplies',
    'fbs_supplies',
    'sales_funnel',
    'fbo_sales',
    'region_sales',
    'goods_returns',
    'order_feed',
    'feedbacks',
    'questions',
    'tariffs',
    'wb_retentions',
    'warehouse_services',
    'claims',
    'promos',
    'fbs_warehouses',
    'fbs_offices'
  ];
$$;

create or replace function public.dmz_daily_datasets()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'finance',
    'adv_stats',
    'products',
    'fbo_stocks',
    'stocks_lk',
    'fbo_orders',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

comment on function public.daily_datasets() is
  'Daily queue order: finance, adv, stocks, orders, supplies, then rest.';
comment on function public.dmz_daily_datasets() is
  'DMZ morning subset in the same priority order as daily_datasets().';

update public.sellers
set
  wb_daily_at = '04:00'::time,
  gas_daily_at = '06:00'::time
where slug = 'main';

update public.gas_books
set gas_daily_at = case slug
  when 'dmz' then '05:00'::time
  when 'main' then '06:00'::time
  else gas_daily_at
end;

create table if not exists public.gas_morning_status (
  book_slug text not null,
  run_date date not null,
  base_ok boolean not null default false,
  gas_ok boolean not null default false,
  sheets_done integer not null default 0,
  sheets_total integer not null default 0,
  base_bad text[] not null default '{}',
  gas_bad text[] not null default '{}',
  summary text not null default '',
  notified boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (book_slug, run_date)
);

comment on table public.gas_morning_status is
  '07:00 snapshot from each GAS book: base fresh + sheets loaded today.';

alter table public.gas_morning_status enable row level security;
revoke all on table public.gas_morning_status from public, anon, authenticated;
grant all on table public.gas_morning_status to service_role;
grant select, insert, update on table public.gas_morning_status to anon, authenticated;

create or replace function public.gas_morning_status_upsert(
  p_book_slug text,
  p_run_date date,
  p_base_ok boolean,
  p_gas_ok boolean,
  p_sheets_done integer,
  p_sheets_total integer,
  p_base_bad text[],
  p_gas_bad text[],
  p_summary text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.gas_morning_status (
    book_slug, run_date, base_ok, gas_ok, sheets_done, sheets_total,
    base_bad, gas_bad, summary, notified, updated_at
  )
  values (
    p_book_slug, p_run_date, coalesce(p_base_ok, false), coalesce(p_gas_ok, false),
    coalesce(p_sheets_done, 0), coalesce(p_sheets_total, 0),
    coalesce(p_base_bad, '{}'), coalesce(p_gas_bad, '{}'),
    left(coalesce(p_summary, ''), 500), false, now()
  )
  on conflict (book_slug, run_date) do update set
    base_ok = excluded.base_ok,
    gas_ok = excluded.gas_ok,
    sheets_done = excluded.sheets_done,
    sheets_total = excluded.sheets_total,
    base_bad = excluded.base_bad,
    gas_bad = excluded.gas_bad,
    summary = excluded.summary,
    updated_at = now();
end;
$$;

create or replace function public.morning_pipeline_notify_text()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  today date := (timezone('Europe/Moscow', now()))::date;
  r record;
  lines text[] := array[]::text[];
  base_bad text[];
  any_base boolean := true;
  any_gas boolean := true;
begin
  for r in
    select *
    from public.gas_morning_status
    where run_date = today
    order by book_slug
  loop
    lines := array_append(lines, upper(r.book_slug) || ': ' || r.summary);
    if not r.base_ok then any_base := false; end if;
    if not r.gas_ok then any_gas := false; end if;
  end loop;

  if array_length(lines, 1) is null then
    return null;
  end if;

  select coalesce(array_agg(distinct b), '{}')
  into base_bad
  from (
    select unnest(g.base_bad) as b
    from public.gas_morning_status g
    where g.run_date = today
  ) x
  where b is not null and b <> '';

  return format(
    E'Утро %s\n%s\n\n%s\n%s',
    to_char(today, 'DD.MM'),
    case when any_base and any_gas then '✅ Загрузка ок' else '⚠️ Загрузка не ок' end,
    array_to_string(lines, E'\n'),
    case
      when any_base and any_gas then 'Клиенту: можно смотреть листы.'
      when not any_base then 'Догрузите базу с сайта → «база ок» → клиенту: загрузите GAS.'
      else 'GAS: перезагрузите проблемные листы вручную.'
    end
  );
end;
$$;

revoke all on function public.gas_morning_status_upsert(text, date, boolean, boolean, integer, integer, text[], text[], text) from public;
grant execute on function public.gas_morning_status_upsert(text, date, boolean, boolean, integer, integer, text[], text[], text)
  to anon, authenticated, service_role;

revoke all on function public.morning_pipeline_notify_text() from public, anon, authenticated;
grant execute on function public.morning_pipeline_notify_text() to service_role;

notify pgrst, 'reload schema';
