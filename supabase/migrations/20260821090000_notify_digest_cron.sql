-- Recreate setup_wb_cron so existing projects pick up Telegram digest at 09:00 MSK.
-- After db push, run setup_wb_cron(...) again (same URL and service_role as before).

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

  perform cron.schedule(
    'wb-enqueue-daily',
    '0 2 * * *',
    $cron$
    select public.enqueue_daily_jobs();
    $cron$
  );

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
