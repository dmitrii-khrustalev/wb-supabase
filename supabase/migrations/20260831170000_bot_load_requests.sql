-- Bot refresh: notify when WB jobs finish. Sheet is loaded by the user in Google.

create table public.bot_load_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  scope text not null,
  status text not null default 'pending',
  error text,
  notified boolean not null default false,
  finished_at timestamptz,
  constraint bot_load_requests_status_chk
    check (status in ('pending', 'done', 'error')),
  constraint bot_load_requests_scope_chk
    check (scope = 'all' or scope = any (public.daily_datasets()))
);

create index bot_load_requests_open_idx
  on public.bot_load_requests (status, created_at)
  where status = 'pending';

create index bot_load_requests_notify_idx
  on public.bot_load_requests (id)
  where notified = false and status in ('done', 'error');

comment on table public.bot_load_requests is
  'Заявка из Telegram: выгрузить датасет(ы) в базу и написать, когда готово.';

alter table public.bot_load_requests enable row level security;
revoke all on table public.bot_load_requests from public, anon, authenticated;
grant all on table public.bot_load_requests to service_role;

create or replace function private.request_bot_load_impl(p_scope text)
returns bigint
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  new_id bigint;
begin
  if p_scope is null or (
    p_scope <> 'all' and not (p_scope = any (public.daily_datasets()))
  ) then
    raise exception 'unknown scope: %', p_scope;
  end if;

  update public.bot_load_requests
  set
    status = 'error',
    error = 'заменено',
    finished_at = coalesce(finished_at, now()),
    notified = true
  where status = 'pending';

  insert into public.bot_load_requests (scope)
  values (p_scope)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.request_bot_load(p_scope text)
returns bigint
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.request_bot_load_impl(p_scope);
$$;

create or replace function private.bot_load_settle_impl()
returns void
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  rec public.bot_load_requests%rowtype;
  open_n integer;
  err_n integer;
  done_n integer;
  need_n integer;
  err_txt text;
begin
  update public.bot_load_requests
  set
    status = 'error',
    error = coalesce(error, 'база не успела'),
    finished_at = now()
  where status = 'pending'
    and created_at < now() - interval '4 hours';

  for rec in
    select *
    from public.bot_load_requests
    where status = 'pending'
    order by id
    for update skip locked
  loop
    with need as (
      select s.id as seller_id, d.dataset
      from public.sellers s
      cross join lateral unnest(
        case
          when rec.scope = 'all' then public.daily_datasets()
          else array[rec.scope]::text[]
        end
      ) as d(dataset)
      where s.is_active
    ),
    latest as (
      select
        n.seller_id,
        n.dataset,
        j.status,
        j.error,
        j.updated_at
      from need n
      left join lateral (
        select sj.status, sj.error, sj.updated_at
        from public.sync_jobs sj
        where sj.seller_id = n.seller_id
          and sj.dataset = n.dataset
          and sj.mode = 'daily'
        order by sj.updated_at desc
        limit 1
      ) j on true
    )
    select
      count(*)::integer,
      count(*) filter (where l.status in ('queued', 'running'))::integer,
      count(*) filter (
        where l.status = 'error' and l.updated_at >= rec.created_at
      )::integer,
      count(*) filter (
        where l.status = 'done' and l.updated_at >= rec.created_at - interval '5 seconds'
      )::integer,
      min(l.error) filter (where l.status = 'error' and l.updated_at >= rec.created_at)
    into need_n, open_n, err_n, done_n, err_txt
    from latest l;

    if need_n = 0 then
      update public.bot_load_requests
      set status = 'error', error = 'нет активного кабинета', finished_at = now()
      where id = rec.id;
    elsif err_n > 0 then
      update public.bot_load_requests
      set
        status = 'error',
        error = coalesce(left(err_txt, 180), 'ошибка выгрузки в базу'),
        finished_at = now()
      where id = rec.id;
    elsif open_n = 0 and done_n >= need_n then
      update public.bot_load_requests
      set status = 'done', finished_at = now()
      where id = rec.id;
    end if;
  end loop;
end;
$$;

create or replace function public.bot_load_settle()
returns void
language plpgsql
security invoker
set search_path to pg_catalog, private
as $$
begin
  perform private.bot_load_settle_impl();
end;
$$;

create or replace function private.cancel_sheet_work_impl()
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  req_n integer := 0;
  bot_n integer := 0;
  job_n integer := 0;
  hush_n integer := 0;
  hush_bot integer := 0;
begin
  update public.sheet_load_requests
  set
    status = 'error',
    error = 'отменено',
    finished_at = coalesce(finished_at, now()),
    notified = true
  where status in ('pending', 'running');
  get diagnostics req_n = row_count;

  update public.bot_load_requests
  set
    status = 'error',
    error = 'отменено',
    finished_at = coalesce(finished_at, now()),
    notified = true
  where status = 'pending';
  get diagnostics bot_n = row_count;

  update public.sheet_load_requests
  set notified = true
  where notified = false
    and status in ('done', 'error');
  get diagnostics hush_n = row_count;

  update public.bot_load_requests
  set notified = true
  where notified = false
    and status in ('done', 'error');
  get diagnostics hush_bot = row_count;

  update public.sync_jobs
  set
    status = 'error',
    error = 'отменено',
    finished_at = now()
  where mode = 'daily'
    and status = 'queued';
  get diagnostics job_n = row_count;

  return jsonb_build_object(
    'requests', req_n + bot_n,
    'jobs', job_n,
    'silenced', hush_n + hush_bot
  );
end;
$$;

revoke all on function private.request_bot_load_impl(text) from public;
revoke all on function private.bot_load_settle_impl() from public;
revoke all on function public.request_bot_load(text) from public, anon, authenticated;
revoke all on function public.bot_load_settle() from public, anon, authenticated;

grant execute on function private.request_bot_load_impl(text) to service_role;
grant execute on function private.bot_load_settle_impl() to service_role;
grant execute on function public.request_bot_load(text) to service_role;
grant execute on function public.bot_load_settle() to service_role;

comment on function public.request_bot_load(text) is
  'Бот: заявка «напиши, когда база доедет».';
comment on function public.bot_load_settle() is
  'Тик: закрыть заявки бота, если daily-джобы после created_at уже done/error.';

-- Old chat→sheet request: no minute trigger, do not ping about the book.
update public.sheet_load_requests
set
  status = 'error',
  error = 'отменено',
  finished_at = coalesce(finished_at, now()),
  notified = true
where status in ('pending', 'running');

notify pgrst, 'reload schema';
