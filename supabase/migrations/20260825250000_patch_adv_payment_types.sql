-- Fill adv_stats.payment_type from /adv/v1/upd without rewriting spend.

create or replace function public.patch_adv_payment_types(
  p_seller_id uuid,
  p_from date,
  p_to date,
  p_map jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_map is null or p_map = '{}'::jsonb then
    return 0;
  end if;

  update public.adv_stats a
  set payment_type = coalesce(
    p_map ->> (a.advert_id || '_' || to_char(a.stat_date, 'YYYY-MM-DD')),
    p_map ->> a.advert_id
  )
  where a.seller_id = p_seller_id
    and a.stat_date >= p_from
    and a.stat_date <= p_to
    and (
      p_map ? (a.advert_id || '_' || to_char(a.stat_date, 'YYYY-MM-DD'))
      or p_map ? a.advert_id
    );

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.patch_adv_payment_types(uuid, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.patch_adv_payment_types(uuid, date, date, jsonb) to service_role;
