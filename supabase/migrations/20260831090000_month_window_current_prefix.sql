-- Monthly default (no date): current month through yesterday vs the same
-- number of days in the previous month — not the last fully finished month.

create or replace function private.info_period_windows(
  p_grain text,
  p_compare text,
  p_anchor date,
  p_today date
)
returns table (
  grain text,
  compare text,
  anchor date,
  cur_from date,
  cur_to date,
  prev_from date,
  prev_to date,
  complete boolean
)
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  g text;
  c text;
  a date;
  today date;
  week_start date;
  week_end date;
  month_start date;
  month_end date;
  prev_month date;
begin
  today := coalesce(p_today, current_date);
  g := lower(btrim(coalesce(p_grain, 'day')));
  if g not in ('day', 'week', 'month') then
    g := 'day';
  end if;
  c := lower(btrim(coalesce(p_compare, g)));
  if g = 'day' and c not in ('day', 'week', 'month') then
    c := 'day';
  elsif g = 'week' and c not in ('week', 'month') then
    c := 'week';
  elsif g = 'month' then
    c := 'month';
  end if;

  if p_anchor is null then
    if g = 'day' then
      a := today - 1;
    elsif g = 'week' then
      a := today - extract(isodow from today)::int;
    else
      a := today - 1;
    end if;
  else
    a := p_anchor;
    if a >= today then
      a := today - 1;
    end if;
  end if;

  if g = 'day' then
    grain := g;
    compare := c;
    anchor := a;
    cur_from := a;
    cur_to := a;
    if c = 'day' then
      prev_from := a - 1;
    elsif c = 'week' then
      prev_from := a - 7;
    else
      prev_from := (a - interval '1 month')::date;
    end if;
    prev_to := prev_from;
    complete := true;
    return next;
    return;
  end if;

  if g = 'week' then
    week_start := date_trunc('week', a)::date;
    week_end := week_start + 6;
    grain := g;
    compare := c;
    anchor := a;
    cur_from := week_start;
    if week_end >= today then
      cur_to := today - 1;
      complete := false;
    else
      cur_to := week_end;
      complete := true;
    end if;
    if cur_to < cur_from then
      cur_to := cur_from;
    end if;
    if c = 'week' then
      prev_from := week_start - 7;
    else
      prev_from := date_trunc('week', (week_start - interval '1 month')::date)::date;
    end if;
    prev_to := prev_from + (cur_to - cur_from);
    return next;
    return;
  end if;

  month_start := date_trunc('month', a)::date;
  month_end := (date_trunc('month', a) + interval '1 month - 1 day')::date;
  grain := g;
  compare := c;
  anchor := a;
  cur_from := month_start;
  if month_end >= today then
    cur_to := least(today - 1, month_end);
    complete := false;
  else
    cur_to := month_end;
    complete := true;
  end if;
  if cur_to < cur_from then
    cur_to := cur_from;
  end if;
  prev_month := (month_start - interval '1 month')::date;
  prev_from := prev_month;
  if complete then
    prev_to := month_start - 1;
  else
    prev_to := prev_from + (cur_to - cur_from);
    if prev_to >= month_start then
      prev_to := month_start - 1;
    end if;
  end if;
  return next;
end;
$$;

comment on function private.info_period_windows(text, text, date, date) is
  'Окна grain/compare. Месяц без даты: текущий месяц до вчера vs столько же дней прошлого.';
