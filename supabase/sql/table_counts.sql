-- Точные counts по всем таблицам public. Вставить в SQL Editor.

select
  t.table_name,
  (xpath(
    '/row/c/text()',
    query_to_xml(format('select count(*)::bigint as c from public.%I', t.table_name), false, true, '')
  ))[1]::text::bigint as rows
from information_schema.tables t
where t.table_schema = 'public'
  and t.table_type = 'BASE TABLE'
order by t.table_name;
