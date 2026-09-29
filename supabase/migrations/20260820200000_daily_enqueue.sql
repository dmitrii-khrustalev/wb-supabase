-- Daily: skip broken supplies-api catalogs; reuse the last daily job row.

create or replace function public.enqueue_jobs(p_seller_id uuid, p_mode text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ds text;
  n integer := 0;
  reused uuid;
begin
  if p_mode not in ('history', 'daily') then
    raise exception 'mode must be history or daily';
  end if;

  foreach ds in array public.wb_datasets() loop
    reused := null;
    if p_mode = 'daily' and ds in ('wb_warehouses', 'transit_tariffs') then
      continue;
    end if;

    if p_mode = 'daily' then
      update public.sync_jobs j
      set
        status = 'queued',
        cursor = '{}'::jsonb,
        error = null,
        attempts = 0,
        started_at = null,
        finished_at = null
      where j.id = (
        select s.id
        from public.sync_jobs s
        where s.seller_id = p_seller_id
          and s.dataset = ds
          and s.mode = 'daily'
          and s.status in ('done', 'error')
        order by s.created_at desc
        limit 1
      )
      and not exists (
        select 1
        from public.sync_jobs a
        where a.seller_id = p_seller_id
          and a.dataset = ds
          and a.mode = 'daily'
          and a.status in ('queued', 'running')
      )
      returning j.id into reused;

      if reused is not null then
        n := n + 1;
        continue;
      end if;
    end if;

    insert into public.sync_jobs (seller_id, dataset, mode, status)
    values (p_seller_id, ds, p_mode, 'queued')
    on conflict (seller_id, dataset, mode) where status in ('queued', 'running')
    do nothing;
    n := n + 1;
  end loop;
  return n;
end;
$$;
