-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- An install's own caps count an open call at no more than install_call_micros, so a long
-- agent turn's worst case does not refuse an install with most of its day left; the address
-- cap still counts the whole worst case. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

create temp table t (k text primary key, v text) on commit drop;
grant all on t to service_role;
update public.mimir_limits set register_key_hash = public.mimir_token_hash(edition || '-key') where not signed_in;
-- the $0.50 install day these numbers were written for (0023 made it $1)
update public.mimir_limits set install_daily_micros = 500000 where edition = 'slicerx';
create function pg_temp.reg(p_edition text, p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register(p_edition, p_ip, p_edition || '-key');
  return v;
end;
$$;
grant execute on function pg_temp.reg(text, text) to service_role;
set local role service_role;

select is((select install_call_micros from public.mimir_limits where edition = 'slicerx'), 50000::bigint,
  'an open call counts at most $0.05 against its install');
insert into t values ('q', pg_temp.reg('slicerx', '10.0.2.1'));
-- 800K reply tokens reserve $0.40, most of the install's $0.50 day
insert into t values ('q1', public.mimir_reserve((select v from t where k = 'q'), '10.0.2.1', 'claude-haiku-5-5', 0, 800000, 0)::text);
select is((select reserved_micros from public.mimir_calls where id = (select v::uuid from t where k = 'q1')), 400000::bigint,
  'the whole worst case is still reserved');
select is((select install_used from public.mimir_quota((select v from t where k = 'q'), '10.0.2.1')), 50000::bigint,
  'the install shows the open call at its clamp');
select is((select ip_used from public.mimir_quota((select v from t where k = 'q'), '10.0.2.1')), 400000::bigint,
  'the address shows it in full');
insert into t values ('q2', public.mimir_reserve((select v from t where k = 'q'), '10.0.2.1', 'claude-haiku-5-5', 0, 800000, 0)::text);
select ok((select v from t where k = 'q2') is not null, 'a second worst case call fits beside the first');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.2.1', 'claude-haiku-5-5', 0, 2400002, 0) $$, (select v from t where k = 'q')),
  'P0001', 'daily limit for this address reached', 'the address cap counts both open calls in full');
-- q1 settles at $0.400001, so $0.049999 of the day is left with q2 still open
select public.mimir_settle((select v::uuid from t where k = 'q1'), 'claude-haiku-5-5', 0, 0, 0, 800002, 0);
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.2.1', 'claude-haiku-5-5', 0, 1000000, 0) $$, (select v from t where k = 'q')),
  'P0001', 'daily limit for this install reached', 'a large call is refused once less than the clamp is left');
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.2.1', 'claude-haiku-5-5', 0, 8, 0) $$, (select v from t where k = 'q')),
  'a small one still fits');
reset role;
update public.mimir_limits set install_call_micros = 1000000000 where edition = 'slicerx';
set local role service_role;
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.2.1', 'claude-haiku-5-5', 0, 8, 0) $$, (select v from t where k = 'q')),
  'P0001', 'daily limit for this install reached', 'with no clamp an open call counts in full again');

select * from finish();
rollback;
