-- Info: текущий снимок поставок FBS + колонка fbs_supplies в daily/weekly.

create or replace function private.info_fbs_supplies(p_seller_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'open', count(*) filter (where s.done is not true)::integer,
    'closed', count(*) filter (where s.done is true)::integer,
    'open_orders', (
      select count(*)::integer
      from public.fbs_supply_orders so
      join public.fbs_supplies s2
        on s2.seller_id = so.seller_id
       and s2.supply_id = so.supply_id
      where so.seller_id = p_seller_id
        and s2.done is not true
    ),
    'no_qr', count(*) filter (
      where s.done is not true
        and not exists (
          select 1
          from public.fbs_supply_qr q
          where q.seller_id = s.seller_id
            and q.supply_id = s.supply_id
        )
    )::integer
  )
  from public.fbs_supplies s
  where s.seller_id = p_seller_id;
$$;

revoke all on function private.info_fbs_supplies(uuid) from public;

do $patch$
declare
  src text;
begin
  src := pg_get_functiondef('public.report_info_daily(uuid, date, integer)'::regprocedure);
  if src not like '%) as supplies,%' then
    raise exception 'report_info_daily: supplies alias not found';
  end if;
  if src like '%private.info_fbs_supplies(m.seller_id)%' then
    raise exception 'report_info_daily: fbs_supplies already patched';
  end if;
  src := replace(
    src,
    ') as supplies,',
    ') as supplies,
      private.info_fbs_supplies(m.seller_id) as fbs_supplies,'
  );
  src := replace(
    src,
    '''supplies'', p.supplies,',
    '''supplies'', p.supplies,
    ''fbs_supplies'', p.fbs_supplies,'
  );
  execute src;

  src := pg_get_functiondef('public.report_info_weekly(uuid, date)'::regprocedure);
  if src not like '%) as supplies,%' then
    raise exception 'report_info_weekly: supplies alias not found';
  end if;
  if src like '%private.info_fbs_supplies(m.seller_id)%' then
    raise exception 'report_info_weekly: fbs_supplies already patched';
  end if;
  src := replace(
    src,
    ') as supplies,',
    ') as supplies,
      private.info_fbs_supplies(m.seller_id) as fbs_supplies,'
  );
  src := replace(
    src,
    '''supplies'', p.supplies,',
    '''supplies'', p.supplies,
    ''fbs_supplies'', p.fbs_supplies,'
  );
  execute src;
end
$patch$;

comment on function private.info_fbs_supplies(uuid) is
  'Текущий снимок поставок FBS: открытые, заказы в открытых, закрытые, открытые без QR.';

notify pgrst, 'reload schema';
