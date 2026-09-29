-- Книга DMZ: полный список блоков как у кабинета. Стартово открыты только 13 core.

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
  from unnest(public.daily_datasets()) with ordinality as d(dataset, ord)
  where public.book_access_enabled('dmz', d.dataset);
$$;

comment on function public.dmz_open_datasets() is
  'Открытые блоки книги dmz среди daily. Утро ждёт только их.';

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
        from unnest(public.wb_datasets()) with ordinality as d(dataset, ord)
      ),
      '[]'::jsonb
    )
  )
  from public.gas_books b
  where b.slug = p_book_slug;
$$;

notify pgrst, 'reload schema';
