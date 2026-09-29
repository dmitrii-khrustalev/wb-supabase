-- Bot → WB sync → Google Sheet: one request row, GAS claims when jobs after created_at are done.

create table public.sheet_load_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  scope text not null,
  status text not null default 'pending',
  error text,
  notified boolean not null default false,
  started_at timestamptz,
  finished_at timestamptz,
  constraint sheet_load_requests_status_chk
    check (status in ('pending', 'running', 'done', 'error')),
  constraint sheet_load_requests_scope_chk
    check (scope = 'all' or scope = any (public.daily_datasets()))
);

create index sheet_load_requests_open_idx
  on public.sheet_load_requests (status, created_at)
  where status in ('pending', 'running');

create index sheet_load_requests_notify_idx
  on public.sheet_load_requests (id)
  where notified = false and status in ('done', 'error');

comment on table public.sheet_load_requests is
  'Заявка из Telegram: обновить датасет(ы) в базе и залить на листы книги.';

alter table public.sheet_load_requests enable row level security;
revoke all on table public.sheet_load_requests from public, anon, authenticated;
grant all on table public.sheet_load_requests to service_role;

create or replace function private.request_sheet_load_impl(p_scope text)
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

  update public.sheet_load_requests
  set
    status = 'error',
    error = 'заменено',
    finished_at = coalesce(finished_at, now()),
    notified = true
  where status in ('pending', 'running');

  insert into public.sheet_load_requests (scope)
  values (p_scope)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.request_sheet_load(p_scope text)
returns bigint
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.request_sheet_load_impl(p_scope);
$$;

create or replace function private.sheet_load_claim_impl()
returns jsonb
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
declare
  rec public.sheet_load_requests%rowtype;
  open_n integer;
  err_n integer;
  done_n integer;
  need_n integer;
  err_txt text;
begin
  update public.sheet_load_requests
  set
    status = 'error',
    error = coalesce(error, 'книга не ответила'),
    finished_at = now()
  where status = 'running'
    and started_at < now() - interval '2 hours';

  update public.sheet_load_requests
  set
    status = 'error',
    error = coalesce(error, 'база не успела'),
    finished_at = now()
  where status = 'pending'
    and created_at < now() - interval '2 hours';

  select *
  into rec
  from public.sheet_load_requests
  where status = 'pending'
  order by id
  limit 1
  for update skip locked;

  if rec.id is null then
    return '{}'::jsonb;
  end if;

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
    update public.sheet_load_requests
    set status = 'error', error = 'нет активного кабинета', finished_at = now()
    where id = rec.id;
    return '{}'::jsonb;
  end if;

  if err_n > 0 then
    update public.sheet_load_requests
    set
      status = 'error',
      error = coalesce(left(err_txt, 180), 'ошибка выгрузки в базу'),
      finished_at = now()
    where id = rec.id;
    return '{}'::jsonb;
  end if;

  if open_n > 0 or done_n < need_n then
    return '{}'::jsonb;
  end if;

  update public.sheet_load_requests
  set status = 'running', started_at = now()
  where id = rec.id;

  return jsonb_build_object('id', rec.id, 'scope', rec.scope, 'ready', true);
end;
$$;

create or replace function public.sheet_load_claim()
returns jsonb
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.sheet_load_claim_impl();
$$;

create or replace function private.sheet_load_finish_impl(p_id bigint, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path to pg_catalog, public
as $$
begin
  update public.sheet_load_requests
  set
    status = case when p_ok then 'done' else 'error' end,
    error = case when p_ok then null else left(coalesce(p_error, 'ошибка листа'), 400) end,
    finished_at = now()
  where id = p_id
    and status = 'running';
end;
$$;

create or replace function public.sheet_load_finish(p_id bigint, p_ok boolean, p_error text default null)
returns void
language sql
security invoker
set search_path to pg_catalog, private
as $$
  select private.sheet_load_finish_impl(p_id, p_ok, p_error);
$$;

revoke all on function private.request_sheet_load_impl(text) from public;
revoke all on function private.sheet_load_claim_impl() from public;
revoke all on function private.sheet_load_finish_impl(bigint, boolean, text) from public;
revoke all on function public.request_sheet_load(text) from public, anon, authenticated;
revoke all on function public.sheet_load_claim() from public;
revoke all on function public.sheet_load_finish(bigint, boolean, text) from public;

grant usage on schema private to service_role;
grant execute on function private.request_sheet_load_impl(text) to service_role;
grant execute on function public.request_sheet_load(text) to service_role;

grant execute on function private.sheet_load_claim_impl() to anon, authenticated;
grant execute on function private.sheet_load_finish_impl(bigint, boolean, text) to anon, authenticated;
grant execute on function public.sheet_load_claim() to anon, authenticated;
grant execute on function public.sheet_load_finish(bigint, boolean, text) to anon, authenticated;

comment on function public.request_sheet_load(text) is
  'Бот: поставить заявку на заливку листа после sync. scope = all или имя датасета.';
comment on function public.sheet_load_claim() is
  'Книга: взять заявку, если нужные daily-джобы уже done после created_at.';
comment on function public.sheet_load_finish(bigint, boolean, text) is
  'Книга: заявка выполнена или ошибка.';

notify pgrst, 'reload schema';
