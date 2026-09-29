-- Снимки остатков не режем: история fbo_stocks / fbs_stocks / fbo_stocks_lk хранится целиком.

create or replace function public.trim_stock_snapshots(p_keep_days integer default 45)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- p_keep_days оставлен, чтобы старые вызовы RPC не падали.
  return jsonb_build_object(
    'cut', null,
    'fbo_stocks', 0,
    'fbs_stocks', 0,
    'fbo_stocks_lk', 0,
    'info_facts_daily', 0,
    'skipped', true,
    'keep_days', p_keep_days
  );
end;
$$;

comment on function public.trim_stock_snapshots(integer) is
  'Больше не удаляет снимки остатков. История складов хранится целиком.';
