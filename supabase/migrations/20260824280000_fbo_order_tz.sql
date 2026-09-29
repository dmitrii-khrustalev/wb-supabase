-- WB statistics API sends order/lastChange without timezone (Moscow wall clock).
-- They were stored as timestamptz in UTC. Shift so the instant is Moscow.

update public.fbo_orders
set
  order_dt = order_dt - interval '3 hours',
  last_change_dt = last_change_dt - interval '3 hours'
where order_dt is not null;
