-- Базовый пакет main (полная версия): 11 листов + отчёты info/sku/stock.
-- Остальные листы — 🔒 на start (book_access_enabled = false).
-- После выполнения в Google Sheets: Сервис → «Обновить доступ» или «Обновить start».

update public.gas_books
set datasets_locked_default = true,
    updated_at = now()
where slug = 'main';

delete from public.gas_book_access
where book_slug = 'main';

insert into public.gas_book_access (book_slug, dataset, enabled, updated_at)
select 'main', d, true, now()
from unnest(array[
  'finance',
  'adv_stats',
  'products',
  'fbo_orders',
  'fbo_sales',
  'fbo_stocks',
  'fbw_supplies',
  'fbs_orders',
  'fbs_stocks',
  'fbs_supplies',
  'fbs_warehouses'
]::text[]) as d
on conflict (book_slug, dataset) do update
  set enabled = excluded.enabled,
      updated_at = excluded.updated_at;

-- Проверка: enabled = true только у базовых
select d.dataset, public.book_access_enabled('main', d.dataset) as enabled
from unnest(public.wb_datasets()) with ordinality as d(dataset, ord)
order by d.ord;
