-- Heap of finance_rows includes payload jsonb (~600 MB). Seq/index scan + heap
-- fetch hits statement_timeout. Covering partial index → index-only scan.

create index if not exists finance_rows_report_daily_idx
  on public.finance_rows (seller_id, rr_dt)
  include (sa_name, nm_id, quantity, retail_amount, doc_type_name)
  where doc_type_name in ('Продажа', 'Возврат');

analyze public.finance_rows;

create or replace function public.report_finance_daily(
  p_seller_id uuid,
  p_from date,
  p_to date
)
returns table (
  sa_name text,
  title text,
  day date,
  qty numeric,
  amount numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  select
    btrim(f.sa_name) as sa_name,
    btrim(p.title) as title,
    f.rr_dt as day,
    sum(
      case f.doc_type_name
        when 'Продажа' then coalesce(f.quantity, 0)
        when 'Возврат' then -coalesce(f.quantity, 0)
        else 0
      end
    ) as qty,
    sum(
      case f.doc_type_name
        when 'Продажа' then coalesce(f.retail_amount, 0)
        when 'Возврат' then -coalesce(f.retail_amount, 0)
        else 0
      end
    ) as amount
  from (
    select seller_id, sa_name, nm_id, rr_dt, quantity, retail_amount, doc_type_name
    from public.finance_rows
    where seller_id = p_seller_id
      and rr_dt >= p_from
      and rr_dt <= p_to
      and doc_type_name in ('Продажа', 'Возврат')
  ) f
  join public.products p
    on p.seller_id = f.seller_id
   and p.nm_id = f.nm_id
  where nullif(btrim(f.sa_name), '') is not null
    and btrim(f.sa_name) <> '-'
    and nullif(btrim(p.title), '') is not null
    and btrim(p.title) <> '-'
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

revoke all on function public.report_finance_daily(uuid, date, date) from public;
grant execute on function public.report_finance_daily(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
