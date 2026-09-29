-- Aggregated finance for Sheets reports (qty / amount by article × day).
-- Anon may execute: same access as SELECT on sheet_finance_rows, without payload.

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
  from public.finance_rows f
  join public.products p
    on p.seller_id = f.seller_id
   and p.nm_id = f.nm_id
  where f.seller_id = p_seller_id
    and f.rr_dt >= p_from
    and f.rr_dt <= p_to
    and f.doc_type_name in ('Продажа', 'Возврат')
    and nullif(btrim(f.sa_name), '') is not null
    and btrim(f.sa_name) <> '-'
    and nullif(btrim(p.title), '') is not null
    and btrim(p.title) <> '-'
  group by 1, 2, 3
  order by 1, 2, 3;
$$;

comment on function public.report_finance_daily(uuid, date, date) is
  'Свёртка финансов для отчётов Вес продаж и К-во продаж: Продажа +, Возврат −.';

revoke all on function public.report_finance_daily(uuid, date, date) from public;
grant execute on function public.report_finance_daily(uuid, date, date) to anon, authenticated;

notify pgrst, 'reload schema';
