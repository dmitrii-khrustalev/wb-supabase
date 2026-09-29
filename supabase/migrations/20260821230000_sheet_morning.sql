-- Lock + last text for the morning Telegram ping after daily sync finishes.

create table public.sheet_morning (
  id integer primary key default 1 check (id = 1),
  run_date date,
  daily_text text not null default '',
  status_text text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.sheet_morning (id) values (1);

alter table public.sheet_morning enable row level security;
revoke all on table public.sheet_morning from anon, authenticated;
grant select, insert, update on table public.sheet_morning to service_role;

comment on table public.sheet_morning is 'Текст утренней выгрузки Google Sheets для команд бота.';
