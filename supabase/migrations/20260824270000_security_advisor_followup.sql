-- Security Advisor: search_path, execute on definer RPCs, RLS without policies.
-- sheet_* views stay security_invoker = false: anon reads views, not base tables (no payload).

alter function public.wb_datasets() set search_path = public;
alter function public.setup_wb_cron(text, text) set search_path = public;
alter function public.daily_datasets() set search_path = public;
alter function public.parse_sheet_date(text) set search_path = public;
alter function public.parse_sheet_num(text) set search_path = public;

revoke all on function public.finance_kvv_page(date, integer, integer) from public, anon, authenticated;
revoke all on function public.refresh_finance_kvv(date, date) from public, anon, authenticated;
grant execute on function public.finance_kvv_page(date, integer, integer) to service_role;
grant execute on function public.refresh_finance_kvv(date, date) to service_role;

revoke all on function public.setup_wb_cron(text, text) from public, anon, authenticated;
grant execute on function public.setup_wb_cron(text, text) to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['fbo_stocks_gas', 'finance_kvv', 'sheet_morning']
  loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    if not exists (
      select 1
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and p.polname = 'deny_anon_authenticated'
    ) then
      execute format(
        'create policy deny_anon_authenticated on public.%I for all to anon, authenticated using (false) with check (false)',
        t
      );
    end if;
  end loop;
end $$;

create schema if not exists extensions;

do $$
declare
  in_public boolean;
begin
  select exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net'
      and n.nspname = 'public'
  ) into in_public;

  if in_public then
    begin
      execute 'alter extension pg_net set schema extensions';
    exception
      when insufficient_privilege then
        raise notice 'pg_net: not owner, left in public';
      when feature_not_supported then
        raise notice 'pg_net: not relocatable, left in public';
      when others then
        raise notice 'pg_net: not moved (%)', sqlerrm;
    end;
  end if;
end $$;
