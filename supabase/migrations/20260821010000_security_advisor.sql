-- Security Advisor: search_path on functions, pg_net out of public, RLS policies.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.wb_datasets()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'products',
    'finance',
    'adv_stats',
    'fbo_orders',
    'fbo_stocks',
    'wb_warehouses',
    'transit_tariffs',
    'fbw_supplies',
    'fbs_warehouses',
    'fbs_offices',
    'fbs_stocks',
    'fbs_orders',
    'fbs_supplies'
  ];
$$;

create or replace function public.setup_wb_cron(p_project_url text, p_service_role_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  create extension if not exists pg_cron;
  create schema if not exists extensions;
  create extension if not exists pg_net with schema extensions;

  if exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'project_url' limit 1),
      p_project_url
    );
  else
    perform vault.create_secret(p_project_url, 'project_url');
  end if;

  if exists (select 1 from vault.secrets where name = 'service_role_key') then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'service_role_key' limit 1),
      p_service_role_key
    );
  else
    perform vault.create_secret(p_service_role_key, 'service_role_key');
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname in ('wb-sync-tick', 'wb-enqueue-daily');

  perform cron.schedule(
    'wb-sync-tick',
    '* * * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
             || '/functions/v1/sync-tick',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
      ),
      body := jsonb_build_object('source', 'pg_cron')
    );
    $cron$
  );

  perform cron.schedule(
    'wb-enqueue-daily',
    '0 2 * * *',
    $cron$
    select public.enqueue_daily_jobs();
    $cron$
  );

  return 'scheduled wb-sync-tick (* * * * *) and wb-enqueue-daily (0 2 * * * UTC)';
end;
$$;

revoke all on function public.setup_wb_cron(text, text) from public, anon, authenticated;
grant execute on function public.setup_wb_cron(text, text) to service_role;

-- pg_net: callable objects live in schema net; advisor flags the extension's home schema.
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
        raise notice 'pg_net: not owner, left in public (objects are in net.*)';
      when feature_not_supported then
        raise notice 'pg_net: not relocatable, left in public (objects are in net.*)';
      when others then
        raise notice 'pg_net: not moved (%)', sqlerrm;
    end;
  end if;
end $$;

-- RLS is on with no policies → Data API is already closed.
-- Explicit deny for anon/authenticated so the advisor stops warning.
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  loop
    execute format(
      'create policy deny_anon_authenticated on public.%I for all to anon, authenticated using (false) with check (false)',
      r.relname
    );
  end loop;
end $$;
