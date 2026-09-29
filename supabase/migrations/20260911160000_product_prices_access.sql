-- История цен: отдельный блок доступа (main). Данные пишет синк products в product_prices_daily.

create or replace function public.wb_datasets()
returns text[]
language sql
immutable
as $$
  select array[
    'products',
    'product_prices',
    'finance',
    'adv_stats',
    'fbo_orders',
    'fbo_sales',
    'region_sales',
    'goods_returns',
    'order_feed',
    'feedbacks',
    'questions',
    'tariffs',
    'wb_retentions',
    'warehouse_services',
    'claims',
    'promos',
    'fbo_stocks',
    'stocks_lk',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies',
    'sales_funnel'
  ];
$$;

comment on function public.wb_datasets() is
  'Все датасеты WB. product_prices — доступ к листу «История цен»; снимок пишет products.';

create or replace function public.dataset_data_date(p_seller_id uuid, p_dataset text)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d date;
  success_day date;
begin
  if p_dataset = 'product_prices' then
    select max(pp.price_date) into d
    from public.product_prices_daily pp
    where pp.seller_id = p_seller_id;
    return d;
  end if;

  select st.data_date, (st.last_success_at at time zone 'Europe/Moscow')::date
    into d, success_day
  from public.sync_state st
  where st.seller_id = p_seller_id
    and st.dataset = p_dataset;

  if d is not null then
    return d;
  end if;
  if success_day is null then
    return null;
  end if;

  if p_dataset in (
    'fbo_stocks', 'stocks_lk', 'fbs_stocks', 'products',
    'fbs_warehouses', 'fbs_offices', 'claims', 'promos', 'tariffs'
  ) then
    return success_day;
  end if;
  return least(success_day, (timezone('Europe/Moscow', now()))::date - 1);
end;
$$;

notify pgrst, 'reload schema';
