-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir's cloud model (pgTAP): clients cannot touch the tables or functions, installs
-- register within the per-IP limit, reservations hold every cap (per minute, install,
-- IP, edition, paused) and keep the editions apart, costs follow the prices, sessions
-- store and forget, and the reader role sees only LayerMate sessions. Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

create temp table t (k text primary key, v text) on commit drop;
grant all on t to anon, authenticated, service_role, mimir_session_reader;
-- The migration's role (postgres) administers mimir_session_reader but may not become it; the test may, until the rollback.
grant mimir_session_reader to postgres with set true;
grant usage on schema extensions to mimir_session_reader;

create function pg_temp.reg(p_edition text, p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register(p_edition, p_ip);
  return v;
end;
$$;
grant execute on function pg_temp.reg(text, text) to service_role;

-- Clients see nothing -----------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.mimir_limits $$, '42501', null, 'anon cannot read the limits');
select throws_ok($$ select * from public.mimir_sessions $$, '42501', null, 'anon cannot read sessions');
select throws_ok($$ select public.mimir_register('slicerx', '1.2.3.4') $$, '42501', null, 'anon cannot register');
select throws_ok($$ select public.mimir_reserve('x', '1.2.3.4', 'claude-haiku-5-5', 0, 2, 0) $$, '42501', null, 'anon cannot reserve');
reset role;
set local role authenticated;
select throws_ok($$ select * from public.mimir_calls $$, '42501', null, 'authenticated cannot read calls');
select throws_ok($$ select public.mimir_forget('x') $$, '42501', null, 'authenticated cannot forget');
select throws_ok($$ select public.mimir_reader_sessions() $$, '42501', null, 'authenticated cannot use the reader functions');
reset role;

set local role service_role;

-- Registration ------------------------------------------------------------------------
insert into t values ('a', pg_temp.reg('slicerx', '10.0.0.1'));
select is(char_length((select v from t where k = 'a')), 64, 'a token is 64 hex characters');
select is((select count(*)::int from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 'a'))), 1,
  'only the hash of the token is stored');
select ok(not exists (select 1 from public.mimir_installs where token_hash = (select v from t where k = 'a')), 'the token itself is not stored');
insert into t values ('a2', pg_temp.reg('slicerx', '10.0.0.1')), ('a3', pg_temp.reg('slicerx', '10.0.0.1'));
select throws_ok($$ select pg_temp.reg('slicerx', '10.0.0.1') $$, 'P0001', 'too many new installs from this address today',
  'a fourth install from one address in a day is refused');
select lives_ok($$ select pg_temp.reg('slicerx', '10.0.0.2') $$, 'another address can still register');
select throws_ok($$ select pg_temp.reg('nope', '10.0.0.3') $$, '22023', 'unknown edition', 'an unknown edition cannot register');
insert into t values ('lm', pg_temp.reg('layermate', '10.0.0.4'));

-- Reservations ------------------------------------------------------------------------
select throws_ok($$ select public.mimir_reserve('not-a-token', '10.0.0.1', 'claude-haiku-5-5', 0, 2000, 0) $$, 'P0001', 'unknown install', 'an unknown token is refused');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, -2, 0) $$, (select v from t where k = 'a')), '22023', null,
  'a negative reservation is refused');
insert into t values ('c1', public.mimir_reserve((select v from t where k = 'a'), '10.0.0.1', 'claude-haiku-5-5', 0, 800000, 0)::text);
select is((select reserved_micros from public.mimir_calls where id = (select v::uuid from t where k = 'c1')), 400000::bigint,
  'a reservation is recorded');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 400000, 0) $$, (select v from t where k = 'a')), 'P0001',
  'daily limit for this install reached', 'the install cap counts open reservations');

-- Settling replaces the reservation with the real cost.
select is(public.mimir_settle((select v::uuid from t where k = 'c1'), 'claude-haiku-5-5', 100000, 0, 0, 0, 0), 10000::bigint,
  '100K input tokens cost $0.01');
select is((select cost_micros from public.mimir_calls where id = (select v::uuid from t where k = 'c1')), 10000::bigint, 'the cost is stored');
select throws_ok(format($$ select public.mimir_settle(%L, 'claude-haiku-5-5', 1, 0, 0, 0, 0) $$, (select v from t where k = 'c1')),
  '22023', null, 'a call settles once');
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 600000, 0) $$, (select v from t where k = 'a')),
  'after settling the install has room again');

-- Costs.
select is(public.mimir_cost('claude-haiku-5-5', 0, 0, 0, 1000000, 0), 500000::bigint, 'a million output tokens cost $0.50 on a short prompt');
select is(public.mimir_cost('claude-haiku-5-5', 0, 100000, 0, 0, 0), 12500::bigint, 'cache writes cost 1.25x input');
select is(public.mimir_cost('claude-haiku-5-5', 0, 0, 100000, 0, 0), 1000::bigint, 'cache reads cost 0.1x input');
select is(public.mimir_cost('claude-haiku-5-5', 0, 0, 0, 0, 3), 30000::bigint, 'web searches count');
select is(public.mimir_cost('claude-haiku-5-5', 200000, 0, 0, 0, 0), 100000::bigint, 'prompts over 100K tokens bill at the long rate');
select is(public.mimir_cost('claude-haiku-5-5', 1, 0, 0, 0, 0), 1::bigint, 'costs round up');

-- The IP cap: three installs on one address share $2.
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 1000000, 0) $$, (select v from t where k = 'a2')), 'second install, first call');
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 1000000, 0) $$, (select v from t where k = 'a3')), 'third install, first call');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.9', 'claude-haiku-5-5', 0, 1000000, 0) $$, (select v from t where k = 'a3')), 'P0001',
  'daily limit for this install reached', 'moving address does not reset the install cap');
-- 10.0.0.1 has used 10000 + 300000 + 500000 + 500000; a fourth install brought there adds 499999.
insert into t values ('a4', pg_temp.reg('slicerx', '10.0.0.5')), ('a5', pg_temp.reg('slicerx', '10.0.0.6'));
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 999998, 0) $$, (select v from t where k = 'a4')), 'up to the IP cap');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 380004, 0) $$, (select v from t where k = 'a5')), 'P0001',
  'daily limit for this address reached', 'past the IP cap is refused');

-- The edition cap keeps LayerMate apart from SlicerX.
update public.mimir_limits set edition_daily_micros = 1500000 where edition = 'layermate';
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.0.4', 'claude-haiku-5-5', 0, 800000, 0) $$, (select v from t where k = 'lm')),
  'LayerMate is not charged for SlicerX use');
update public.mimir_limits set edition_daily_micros = 2000000 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.6', 'claude-haiku-5-5', 0, 380004, 0) $$, (select v from t where k = 'a5')), 'P0001',
  'daily limit for this edition reached', 'the edition cap is shared by every install of the edition');

-- Paused and per-minute.
update public.mimir_limits set enabled = false where edition = 'layermate';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.4', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'lm')), 'P0001',
  'mimir is paused', 'a paused edition refuses calls');
update public.mimir_limits set enabled = true, install_per_minute = 1 where edition = 'layermate';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.4', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'lm')), 'P0001',
  'too many requests', 'the per-minute limit holds');

-- Sessions, forget and the reader --------------------------------------------------------
select public.mimir_store_session((select v::uuid from t where k = 'c1'), 's1', '0.2.0', 'claude-haiku-5-5', '{"messages":[1]}');
select public.mimir_store_session((select v::uuid from t where k = 'c1'), 's1', '0.2.0', 'claude-haiku-5-5', '{"messages":[1,2]}');
select is((select turns from public.mimir_sessions where session_key = 's1'), 2, 'each turn updates the one session');
select public.mimir_store_session((select id from public.mimir_calls where edition = 'layermate' limit 1), 's2', '0.2.0',
  'claude-haiku-5-5', '{"messages":["lm"]}');
insert into t values ('aid', (select id from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 'a')))::text);
reset role;
set local role mimir_session_reader;
select is((select count(*)::int from public.mimir_reader_sessions()), 1, 'the reader sees only LayerMate sessions');
select is(public.mimir_reader_session((select v::uuid from t where k = 'aid'), 's1'),
  null, 'the reader cannot open a SlicerX session');
reset role;
set local role service_role;
select is(public.mimir_forget((select v from t where k = 'a')), 1, 'forget deletes the install''s sessions');

select * from finish();
rollback;
