-- Доступ к датасетам по кабинету (панель «Загрузки»).

create table if not exists public.sync_dataset_access (
  seller_id uuid not null references public.sellers(id) on delete cascade,
  dataset text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (seller_id, dataset),
  constraint sync_dataset_access_dataset_chk check (dataset ~ '^[a-z][a-z0-9_]*$')
);

comment on table public.sync_dataset_access is
  'Включён ли датасет для кабинета. Нет строки = включён.';

alter table public.sync_dataset_access enable row level security;
revoke all on table public.sync_dataset_access from public, anon, authenticated;
grant select, insert, update, delete on table public.sync_dataset_access to service_role;

create or replace function public.dataset_access_enabled(p_seller_id uuid, p_dataset text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select a.enabled
      from public.sync_dataset_access a
      where a.seller_id = p_seller_id
        and a.dataset = p_dataset
    ),
    true
  );
$$;

create or replace function public.sync_dataset_set_access(
  p_slug text,
  p_dataset text,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
  ds text;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  select id into sid from public.sellers where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;

  if p_enabled then
    delete from public.sync_dataset_access
    where seller_id = sid and dataset = ds;
    return;
  end if;

  insert into public.sync_dataset_access (seller_id, dataset, enabled, updated_at)
  values (sid, ds, false, now())
  on conflict (seller_id, dataset) do update
    set enabled = false, updated_at = now();
end;
$$;

create or replace function public.enqueue_one_job(p_seller_id uuid, p_dataset text, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  reused uuid;
  inserted integer;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;
  if not (p_dataset = any (public.wb_datasets())) then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  if not public.dataset_access_enabled(p_seller_id, p_dataset) then
    return 0;
  end if;

  if exists (
    select 1
    from public.sync_jobs
    where seller_id = p_seller_id
      and dataset = p_dataset
      and mode = p_mode
      and status in ('queued', 'running')
  ) then
    return 0;
  end if;

  if p_mode = 'daily' then
    update public.sync_jobs j
    set
      status = 'queued',
      cursor = '{}'::jsonb,
      error = null,
      attempts = 0,
      started_at = null,
      finished_at = null
    where j.id = (
      select s.id
      from public.sync_jobs s
      where s.seller_id = p_seller_id
        and s.dataset = p_dataset
        and s.mode = 'daily'
        and s.status in ('done', 'error')
      order by s.created_at desc
      limit 1
    )
    returning j.id into reused;

    if reused is not null then
      return 1;
    end if;
  end if;

  insert into public.sync_jobs (seller_id, dataset, mode, status)
  values (p_seller_id, p_dataset, p_mode, 'queued')
  on conflict (seller_id, dataset, mode) where status in ('queued', 'running')
  do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.dataset_access_enabled(uuid, text) from public, anon, authenticated;
revoke all on function public.sync_dataset_set_access(text, text, boolean) from public, anon, authenticated;
grant execute on function public.dataset_access_enabled(uuid, text) to service_role;
grant execute on function public.sync_dataset_set_access(text, text, boolean) to service_role;

notify pgrst, 'reload schema';
