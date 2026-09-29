-- Расписание загрузок по кабинету: WB → база и база → GAS main.

alter table public.sellers
  add column if not exists wb_daily_at time not null default '05:00',
  add column if not exists gas_daily_at time not null default '07:00';

comment on column public.sellers.wb_daily_at is
  'Время МСК: постановка daily jobs (загрузка из WB API в базу).';
comment on column public.sellers.gas_daily_at is
  'Время МСК: утренний триггер GAS main (загрузка из базы в книгу).';

create or replace function public.parse_schedule_time(p_value text)
returns time
language plpgsql
immutable
as $$
declare
  t text := btrim(coalesce(p_value, ''));
  m text[];
begin
  if t = '' then
    return null;
  end if;
  if t ~ '^\d{1,2}:\d{2}$' then
    m := regexp_match(t, '^(\d{1,2}):(\d{2})$');
    return make_time(m[1]::int, m[2]::int, 0);
  end if;
  if t ~ '^\d{1,2}:\d{2}:\d{2}$' then
    return t::time;
  end if;
  raise exception 'invalid time: %', p_value;
end;
$$;

create or replace function public.get_seller_schedule(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'slug', s.slug,
    'wb_daily_at', to_char(s.wb_daily_at, 'HH24:MI'),
    'gas_daily_at', to_char(s.gas_daily_at, 'HH24:MI')
  )
  from public.sellers s
  where s.slug = p_slug;
$$;

create or replace function public.set_seller_schedule(
  p_slug text,
  p_wb_daily_at text default null,
  p_gas_daily_at text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  wb time;
  gas time;
begin
  if p_wb_daily_at is not null and btrim(p_wb_daily_at) <> '' then
    wb := public.parse_schedule_time(p_wb_daily_at);
    update public.sellers
      set wb_daily_at = wb
      where slug = p_slug;
  end if;

  if p_gas_daily_at is not null and btrim(p_gas_daily_at) <> '' then
    gas := public.parse_schedule_time(p_gas_daily_at);
    update public.sellers
      set gas_daily_at = gas
      where slug = p_slug;
  end if;

  if not exists (select 1 from public.sellers where slug = p_slug) then
    raise exception 'seller not found: %', p_slug;
  end if;

  return public.get_seller_schedule(p_slug);
end;
$$;

create or replace function public.enqueue_scheduled_daily_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
  today date := (timezone('Europe/Moscow', now()))::date;
  now_t time := (timezone('Europe/Moscow', now()))::time;
begin
  for r in
    select s.id
    from public.sellers s
    where s.is_active
      and s.wb_daily_at = date_trunc('minute', now_t)::time
      and not exists (
        select 1
        from public.sync_jobs j
        where j.seller_id = s.id
          and j.mode = 'daily'
          and (j.created_at at time zone 'Europe/Moscow')::date = today
      )
  loop
    n := n + public.enqueue_jobs(r.id, 'daily');
  end loop;
  return n;
end;
$$;

do $cron$
declare
  jid bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select jobid into jid
    from cron.job
    where jobname = 'wb-enqueue-daily'
    limit 1;
    if jid is not null then
      perform cron.unschedule(jid);
    end if;
    perform cron.schedule(
      'wb-enqueue-daily',
      '* * * * *',
      $cmd$select public.enqueue_scheduled_daily_jobs();$cmd$
    );
  end if;
end;
$cron$;

revoke all on function public.parse_schedule_time(text) from public, anon, authenticated;
revoke all on function public.get_seller_schedule(text) from public;
revoke all on function public.set_seller_schedule(text, text, text) from public;
revoke all on function public.enqueue_scheduled_daily_jobs() from public, anon, authenticated;

grant execute on function public.get_seller_schedule(text) to anon, authenticated, service_role;
grant execute on function public.set_seller_schedule(text, text, text) to service_role, authenticated;
grant execute on function public.enqueue_scheduled_daily_jobs() to service_role;

notify pgrst, 'reload schema';
