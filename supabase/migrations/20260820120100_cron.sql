-- Queue helpers, Vault token reader, cron installer.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sync_jobs_updated_at on public.sync_jobs;
create trigger sync_jobs_updated_at
  before update on public.sync_jobs
  for each row execute procedure public.touch_updated_at();

create or replace function public.wb_datasets()
returns text[]
language sql
immutable
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

create or replace function public.enqueue_jobs(p_seller_id uuid, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ds text;
  n integer := 0;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;

  foreach ds in array public.wb_datasets() loop
    insert into public.sync_jobs (seller_id, dataset, mode, status)
    values (p_seller_id, ds, p_mode, 'queued')
    on conflict (seller_id, dataset, mode) where status in ('queued', 'running')
    do nothing;
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.enqueue_daily_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select id from public.sellers where is_active loop
    n := n + public.enqueue_jobs(r.id, 'daily');
  end loop;
  return n;
end;
$$;

create or replace function public.enqueue_history_jobs(p_slug text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  select id into sid from public.sellers where slug = p_slug;
  if sid is null then
    raise exception 'seller not found: %', p_slug;
  end if;
  return public.enqueue_jobs(sid, 'history');
end;
$$;

create or replace function public.get_seller_wb_token(p_slug text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret text;
begin
  begin
    select decrypted_secret
      into secret
    from vault.decrypted_secrets
    where name = 'wb_token_' || p_slug
    limit 1;
  exception
    when undefined_table then
      return null;
  end;
  return secret;
end;
$$;

revoke all on function public.get_seller_wb_token(text) from public, anon, authenticated;
grant execute on function public.get_seller_wb_token(text) to service_role;

revoke all on function public.enqueue_jobs(uuid, text) from public, anon, authenticated;
revoke all on function public.enqueue_daily_jobs() from public, anon, authenticated;
revoke all on function public.enqueue_history_jobs(text) from public, anon, authenticated;
grant execute on function public.enqueue_jobs(uuid, text) to service_role;
grant execute on function public.enqueue_daily_jobs() to service_role;
grant execute on function public.enqueue_history_jobs(text) to service_role;
-- daily cron runs as postgres / supabase_admin; that role already can execute.

create or replace function public.setup_wb_cron(p_project_url text, p_service_role_key text)
returns text
language plpgsql
security definer
as $$
begin
  create extension if not exists pg_cron;
  create extension if not exists pg_net;

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
  where jobname in ('wb-sync-tick', 'wb-enqueue-daily', 'wb-notify-digest');

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

  -- 05:00 Europe/Moscow = 02:00 UTC (no DST in Russia)
  perform cron.schedule(
    'wb-enqueue-daily',
    '0 2 * * *',
    $cron$
    select public.enqueue_daily_jobs();
    $cron$
  );

  -- 09:00 Europe/Moscow = 06:00 UTC — утренний статус в Telegram
  perform cron.schedule(
    'wb-notify-digest',
    '0 6 * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
             || '/functions/v1/notify-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
      ),
      body := jsonb_build_object('source', 'pg_cron')
    );
    $cron$
  );

  return 'scheduled wb-sync-tick, wb-enqueue-daily (0 2 UTC), wb-notify-digest (0 6 UTC)';
end;
$$;

revoke all on function public.setup_wb_cron(text, text) from public, anon, authenticated;
grant execute on function public.setup_wb_cron(text, text) to service_role;
