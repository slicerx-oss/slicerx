-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir_usage: an install's day, week and last 24 hours as shares of its caps, open calls at
-- install_call_micros; and mimir_install_edition. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

create temp table t (k text primary key, v text) on commit drop;
grant all on t to service_role;
update public.mimir_limits set register_key_hash = public.mimir_token_hash(edition || '-key') where edition in ('slicerx', 'layermate');
create function pg_temp.reg(p_edition text, p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register(p_edition, p_ip, p_edition || '-key');
  return v;
end;
$$;
grant execute on function pg_temp.reg(text, text) to service_role;
set local role service_role;

insert into t values ('a', pg_temp.reg('slicerx', '10.0.4.1'));
select is((public.mimir_usage((select v from t where k = 'a')) -> 'day' ->> 'used')::numeric, 0::numeric, 'a new install has used nothing');
select is(jsonb_array_length(public.mimir_usage((select v from t where k = 'a')) -> 'hourly'), 24, 'hourly has the last 24 hours');
select is((public.mimir_usage((select v from t where k = 'a')) -> 'perMinute' ->> 'limit')::int,
  (select install_per_minute from public.mimir_limits where edition = 'slicerx'), 'perMinute is the install''s rate limit');
select is((public.mimir_usage((select v from t where k = 'a')) -> 'day' ->> 'resetsAt')::timestamptz,
  (public.mimir_day() + 1)::timestamp at time zone 'Australia/Melbourne', 'the day resets at the next Melbourne midnight');

-- one call settles at $0.25, a quarter of the $1 day; another stays open at its $0.40 worst case
insert into t values ('c1', public.mimir_reserve((select v from t where k = 'a'), '10.0.4.1', 'claude-haiku-5-5', 0, 1000, 0)::text);
select public.mimir_settle((select v::uuid from t where k = 'c1'), 'claude-haiku-5-5', 0, 0, 0, 500000, 0);
select is((public.mimir_usage((select v from t where k = 'a')) -> 'day' ->> 'used')::numeric, 0.25, 'a settled call counts what it cost');
insert into t values ('c2', public.mimir_reserve((select v from t where k = 'a'), '10.0.4.1', 'claude-haiku-5-5', 0, 800000, 0)::text);
select is((public.mimir_usage((select v from t where k = 'a')) -> 'day' ->> 'used')::numeric, 0.3, 'an open call counts at the clamp');
select is((public.mimir_usage((select v from t where k = 'a')) -> 'hourly' ->> 23)::numeric, 0.3, 'the hour under way holds both');
select is((public.mimir_usage((select v from t where k = 'a')) -> 'hourly' ->> 0)::numeric, 0::numeric, 'the oldest hour is empty');
select is((public.mimir_usage((select v from t where k = 'a')) -> 'week' ->> 'used')::numeric, round(0.3 / 7, 4), 'the week is against 7 days of cap');

-- a call from yesterday counts in the week and not in today
reset role;
update public.mimir_calls set day = public.mimir_day() - 1, created_at = now() - interval '25 hours'
where id = (select v::uuid from t where k = 'c1');
set local role service_role;
select is((public.mimir_usage((select v from t where k = 'a')) -> 'day' ->> 'used')::numeric, 0.05, 'yesterday is not today');
select is((public.mimir_usage((select v from t where k = 'a')) -> 'week' ->> 'used')::numeric, round(0.3 / 7, 4), 'but it is this week');

select is(public.mimir_install_edition((select v from t where k = 'a')), 'slicerx', 'the edition an install belongs to');
select throws_ok($$ select public.mimir_usage('nope') $$, 'P0001', 'unknown install', 'an unknown token gets nothing');

reset role;
set local role anon;
select throws_ok($$ select public.mimir_usage('nope') $$, '42501', null, 'anon cannot read usage');

select * from finish();
rollback;
