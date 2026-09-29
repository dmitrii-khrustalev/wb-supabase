-- Доступ и расписание книги GAS (DMZ), отдельно от галочек кабинета на /sync.

create table if not exists public.gas_books (
  slug text primary key,
  gas_daily_at time not null default '07:00',
  datasets_locked_default boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint gas_books_slug_chk check (slug ~ '^[a-z][a-z0-9_]*$')
);

comment on table public.gas_books is
  'Книга GAS: время база→лист и locked-by-default для gas_book_access. Не кабинет WB.';

comment on column public.gas_books.gas_daily_at is
  'Время МСК: утренний триггер этой книги.';

comment on column public.gas_books.datasets_locked_default is
  'true (dmz): датасет закрыт, пока нет enabled=true. false: открыт, пока нет enabled=false.';

alter table public.gas_books enable row level security;
revoke all on table public.gas_books from public, anon, authenticated;
grant select, insert, update, delete on table public.gas_books to service_role;
grant select on table public.gas_books to authenticated;

create table if not exists public.gas_book_access (
  book_slug text not null references public.gas_books(slug) on delete cascade,
  dataset text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (book_slug, dataset),
  constraint gas_book_access_dataset_chk check (dataset ~ '^[a-z][a-z0-9_]*$')
);

comment on table public.gas_book_access is
  'Галочки листов книги. Не ставит очередь WB.';

alter table public.gas_book_access enable row level security;
revoke all on table public.gas_book_access from public, anon, authenticated;
grant select, insert, update, delete on table public.gas_book_access to service_role;
grant select on table public.gas_book_access to authenticated;

insert into public.gas_books (slug, gas_daily_at, datasets_locked_default)
values
  ('main', '07:00', false),
  ('dmz', '05:05', true)
on conflict (slug) do nothing;

update public.gas_books b
set gas_daily_at = s.gas_daily_at
from public.sellers s
where b.slug = 'main'
  and s.slug = 'main';

insert into public.gas_book_access (book_slug, dataset, enabled, updated_at)
select 'dmz', d.dataset, true, now()
from unnest(public.dmz_daily_datasets()) as d(dataset)
on conflict (book_slug, dataset) do nothing;

create or replace function public.book_access_enabled(p_book_slug text, p_dataset text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select a.enabled
      from public.gas_book_access a
      where a.book_slug = p_book_slug
        and a.dataset = p_dataset
    ),
    not (
      select b.datasets_locked_default
      from public.gas_books b
      where b.slug = p_book_slug
    )
  );
$$;

create or replace function public.dmz_open_datasets()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    array_agg(d.dataset order by d.ord),
    '{}'::text[]
  )
  from unnest(public.dmz_daily_datasets()) with ordinality as d(dataset, ord)
  where public.book_access_enabled('dmz', d.dataset);
$$;

create or replace function public.set_book_access(
  p_book_slug text,
  p_dataset text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ds text;
  locked boolean;
begin
  ds := lower(btrim(coalesce(p_dataset, '')));
  if ds = '' or ds !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'unknown dataset: %', p_dataset;
  end if;
  if not (ds = any (public.wb_datasets()) or ds = any (public.dmz_daily_datasets())) then
    raise exception 'unknown dataset: %', p_dataset;
  end if;

  select datasets_locked_default into locked
  from public.gas_books
  where slug = p_book_slug;
  if locked is null then
    raise exception 'book not found: %', p_book_slug;
  end if;

  if p_enabled then
    if locked then
      insert into public.gas_book_access (book_slug, dataset, enabled, updated_at)
      values (p_book_slug, ds, true, now())
      on conflict (book_slug, dataset) do update
        set enabled = true, updated_at = now();
    else
      delete from public.gas_book_access
      where book_slug = p_book_slug and dataset = ds;
    end if;
  elsif locked then
    delete from public.gas_book_access
    where book_slug = p_book_slug and dataset = ds;
  else
    insert into public.gas_book_access (book_slug, dataset, enabled, updated_at)
    values (p_book_slug, ds, false, now())
    on conflict (book_slug, dataset) do update
      set enabled = false, updated_at = now();
  end if;

  update public.gas_books set updated_at = now() where slug = p_book_slug;

  return jsonb_build_object(
    'book', p_book_slug,
    'dataset', ds,
    'enabled', public.book_access_enabled(p_book_slug, ds)
  );
end;
$$;

create or replace function public.list_book_access(p_book_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'book', b.slug,
    'gas_daily_at', to_char(b.gas_daily_at, 'HH24:MI'),
    'datasets_locked_default', b.datasets_locked_default,
    'datasets', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'dataset', d.dataset,
            'enabled', public.book_access_enabled(b.slug, d.dataset)
          )
          order by d.ord
        )
        from unnest(
          case
            when b.slug = 'dmz' then public.dmz_daily_datasets()
            else public.wb_datasets()
          end
        ) with ordinality as d(dataset, ord)
      ),
      '[]'::jsonb
    )
  )
  from public.gas_books b
  where b.slug = p_book_slug;
$$;

create or replace function public.get_book_schedule(p_book_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'book', b.slug,
    'gas_daily_at', to_char(b.gas_daily_at, 'HH24:MI')
  )
  from public.gas_books b
  where b.slug = p_book_slug;
$$;

create or replace function public.set_book_schedule(
  p_book_slug text,
  p_gas_daily_at text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  gas time;
begin
  if not exists (select 1 from public.gas_books where slug = p_book_slug) then
    raise exception 'book not found: %', p_book_slug;
  end if;
  gas := public.parse_schedule_time(p_gas_daily_at);
  if gas is null then
    raise exception 'invalid time: %', p_gas_daily_at;
  end if;
  update public.gas_books
    set gas_daily_at = gas, updated_at = now()
    where slug = p_book_slug;
  return public.get_book_schedule(p_book_slug);
end;
$$;

create or replace function private.sheet_dmz_daily_status_impl()
returns table (
  run_date date,
  ready boolean,
  total_jobs integer,
  done_jobs integer,
  error_jobs integer,
  open_jobs integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    s.run_date,
    (s.total_jobs = 0 or s.ready) as ready,
    s.total_jobs,
    s.done_jobs,
    s.error_jobs,
    s.open_jobs
  from private.sheet_daily_status_for(public.dmz_open_datasets()) s;
$$;

comment on function public.sheet_dmz_daily_status() is
  'Готовность daily для DMZ: только открытые блоки книги dmz.';

revoke all on function public.book_access_enabled(text, text) from public;
revoke all on function public.dmz_open_datasets() from public;
revoke all on function public.set_book_access(text, text, boolean) from public;
revoke all on function public.list_book_access(text) from public;
revoke all on function public.get_book_schedule(text) from public;
revoke all on function public.set_book_schedule(text, text) from public;

grant execute on function public.book_access_enabled(text, text)
  to anon, authenticated, service_role;
grant execute on function public.dmz_open_datasets()
  to anon, authenticated, service_role;
grant execute on function public.set_book_access(text, text, boolean)
  to service_role, authenticated;
grant execute on function public.list_book_access(text)
  to anon, authenticated, service_role;
grant execute on function public.get_book_schedule(text)
  to anon, authenticated, service_role;
grant execute on function public.set_book_schedule(text, text)
  to service_role, authenticated;

notify pgrst, 'reload schema';
