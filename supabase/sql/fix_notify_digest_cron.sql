-- Запасной cron: утренний дайджест в Telegram в 09:00 МСК (06:00 UTC).
-- Основной путь — sync-tick → maybeNotifyDailyDone, когда все daily = done.

select cron.unschedule(jobid)
from cron.job
where jobname = 'wb-notify-digest';

select cron.schedule(
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

select jobid, jobname, schedule, active from cron.job order by jobid;
