-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir's cloud model (pgTAP): clients cannot touch the tables or functions, installs
-- register only with their edition's key and within the per-IP limit, reservations hold
-- every cap (per minute, in flight, install, IP, edition, paused), an IPv6 /64 counts as one
-- address and its /48 holds wider caps, unused installs expire, refusals count toward the rates at their worst case and
-- keep the editions apart, costs follow the prices, sessions store only settled calls
-- within their size caps and forget, and the reader role sees only LayerMate sessions. Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(87);

create temp table t (k text primary key, v text) on commit drop;
grant all on t to anon, authenticated, service_role, mimir_session_reader;
-- The migration's role (postgres) administers mimir_session_reader but may not become it; the test may, until the rollback.
grant mimir_session_reader to postgres with set true;
grant usage on schema extensions to mimir_session_reader;

update public.mimir_limits set register_key_hash = public.mimir_token_hash(edition || '-key');
create function pg_temp.reg(p_edition text, p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register(p_edition, p_ip, p_edition || '-key');
  return v;
end;
$$;
grant execute on function pg_temp.reg(text, text) to service_role;
-- the deploy step (packages/store scripts/mimir-register-key.ts) hashes the key the same way
select is(public.mimir_token_hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'a registration key hashes to its sha256 hex');

-- Clients see nothing -----------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.mimir_limits $$, '42501', null, 'anon cannot read the limits');
select throws_ok($$ select * from public.mimir_sessions $$, '42501', null, 'anon cannot read sessions');
select throws_ok($$ select public.mimir_register('slicerx', '1.2.3.4', 'slicerx-key') $$, '42501', null, 'anon cannot register');
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
select throws_ok($$ select public.mimir_register('layermate', '10.0.0.7', 'slicerx-key') $$, 'P0001', 'wrong registration key',
  'one edition''s key cannot register another edition');
select throws_ok($$ select public.mimir_register('slicerx', '10.0.0.7', null) $$, 'P0001', 'wrong registration key', 'a build without a key cannot register');
select throws_ok($$ select public.mimir_register('slicerx', '', 'slicerx-key') $$, '22023', 'no client address',
  'a request without an address is refused, not counted in a shared bucket');
update public.mimir_limits set register_key_prev_hash = register_key_hash, register_key_hash = public.mimir_token_hash('slicerx-key-2')
where edition = 'slicerx';
select lives_ok($$ select public.mimir_register('slicerx', '10.0.0.7', 'slicerx-key') $$, 'the previous key works while it rotates out');
select lives_ok($$ select public.mimir_register('slicerx', '10.0.0.7', 'slicerx-key-2') $$, 'the new key works');
update public.mimir_limits set register_key_prev_hash = null where edition = 'slicerx';
select throws_ok($$ select public.mimir_register('slicerx', '10.0.0.8', 'slicerx-key') $$, 'P0001', 'wrong registration key',
  'a rotated-out key stops working');
update public.mimir_limits set register_key_hash = public.mimir_token_hash('slicerx-key') where edition = 'slicerx';
update public.mimir_limits set register_key_hash = null where edition = 'layermate';
select throws_ok($$ select public.mimir_register('layermate', '10.0.0.8', 'layermate-key') $$, 'P0001', 'wrong registration key',
  'an edition with no key set registers nothing');
update public.mimir_limits set register_key_hash = public.mimir_token_hash('layermate-key') where edition = 'layermate';
insert into t values ('lm', pg_temp.reg('layermate', '10.0.0.4'));

-- Addresses: an IPv6 /64 is one address, and an IPv4-mapped address is its IPv4 one.
reset role;
select is(public.mimir_ip_hash('2001:db8:1:2::1'), public.mimir_ip_hash('2001:db8:1:2:ffff:ffff:ffff:9'), 'one IPv6 /64 hashes as one address');
select isnt(public.mimir_ip_hash('2001:db8:1:2::1'), public.mimir_ip_hash('2001:db8:1:3::1'), 'the next /64 is another address');
select is(public.mimir_ip_hash('::ffff:10.0.0.1'), public.mimir_ip_hash('10.0.0.1'), 'an IPv4-mapped address is its IPv4 address');
select throws_ok($$ select public.mimir_ip_hash('not-an-address') $$, '22023', 'no client address', 'an unreadable address is refused');
select is(public.mimir_net_hash('2001:db8:1:2::1'), public.mimir_net_hash('2001:db8:1:ff::1'), 'the /64s of one /48 share a network');
select isnt(public.mimir_net_hash('2001:db8:1:2::1'), public.mimir_net_hash('2001:db8:2:2::1'), 'the next /48 is another network');
select is(public.mimir_net_hash('10.0.0.1'), null, 'IPv4 has no wider network');
set local role service_role;
select throws_ok($$ select * from public.mimir_secret $$, '42501', null, 'the service role cannot read the IP salt');
select pg_temp.reg('slicerx', '2001:db8:5:5::1'), pg_temp.reg('slicerx', '2001:db8:5:5::2'), pg_temp.reg('slicerx', '2001:db8:5:5::3');
select throws_ok($$ select pg_temp.reg('slicerx', '2001:db8:5:5:abcd::7') $$, 'P0001', 'too many new installs from this address today',
  'new addresses in one /64 share its install limit');
-- 2001:db8:5::/48 holds those 3; new /64s in it register up to the network's limit
update public.mimir_limits set registers_per_net_day = 4 where edition = 'slicerx';
select lives_ok($$ select pg_temp.reg('slicerx', '2001:db8:5:6::1') $$, 'another /64 in the /48 registers');
select throws_ok($$ select pg_temp.reg('slicerx', '2001:db8:5:7::1') $$, 'P0001', 'too many new installs from this network today',
  'the /48 has a limit of new installs across its /64s');
update public.mimir_limits set registers_per_net_day = 20;
update public.mimir_limits set registers_per_day = (select count(*) from public.mimir_installs where edition = 'layermate') where edition = 'layermate';
select throws_ok($$ select pg_temp.reg('layermate', '10.0.0.30') $$, 'P0001', 'too many new installs for this edition today',
  'an edition has a limit of new installs a day, whatever the addresses');
update public.mimir_limits set registers_per_day = 5000;
-- An install that never made a call goes after 7 days; one that did stays.
insert into public.mimir_installs (edition, token_hash, created_at, created_ip_hash, last_call_at) values
  ('slicerx', 'stale-unused', now() - interval '8 days', 'x', null),
  ('slicerx', 'stale-used', now() - interval '8 days', 'x', now() - interval '8 days'),
  ('slicerx', 'stale-idle', now() - interval '60 days', 'x', now() - interval '31 days'),
  ('slicerx', 'stale-shared', now() - interval '60 days', 'x', now() - interval '31 days');
insert into public.mimir_sessions (install_id, session_key, edition, app_version, model, transcript)
select id, 'kept', 'slicerx', '0.2.0', 'claude-haiku-5-5', '{}' from public.mimir_installs where token_hash = 'stale-shared';
select pg_temp.reg('slicerx', '10.0.0.31');
select ok(not exists (select 1 from public.mimir_installs where token_hash = 'stale-unused'), 'an install never used for 7 days is removed');
select ok(exists (select 1 from public.mimir_installs where token_hash = 'stale-used'), 'an install used this month stays');
select ok(not exists (select 1 from public.mimir_installs where token_hash = 'stale-idle'), 'an install idle for 30 days is removed');
select ok(exists (select 1 from public.mimir_installs where token_hash = 'stale-shared'), 'unless it has shared sessions, which keep their 180 days');

-- Reservations ------------------------------------------------------------------------
-- (open calls count in full against the install here; mimir_install_call_cap.test.sql covers the clamp)
update public.mimir_limits set install_call_micros = 1000000000;
select throws_ok($$ select public.mimir_reserve('not-a-token', '10.0.0.1', 'claude-haiku-5-5', 0, 2000, 0) $$, 'P0001', 'unknown install', 'an unknown token is refused');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, -2, 0) $$, (select v from t where k = 'a')), '22023', null,
  'a negative reservation is refused');
insert into t values ('c1', public.mimir_reserve((select v from t where k = 'a'), '10.0.0.1', 'claude-haiku-5-5', 0, 800000, 0)::text);
select is((select reserved_micros from public.mimir_calls where id = (select v::uuid from t where k = 'c1')), 400000::bigint,
  'a reservation is recorded');
select is(public.mimir_cost('claude-haiku-5-5', 0, 1000, 0, 0, 0), 125::bigint, 'a prompt is reserved at the cache write rate');
select throws_ok(format($$ select public.mimir_store_session(%L, 's0', '0.2.0', 'claude-haiku-5-5', '{}') $$, (select v from t where k = 'c1')),
  '22023', null, 'an open call stores no session');
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 400000, 0) $$, (select v from t where k = 'a')), 'P0001',
  'daily limit for this install reached', 'the install cap counts open reservations');

-- Settling replaces the reservation with the real cost.
select is(public.mimir_settle((select v::uuid from t where k = 'c1'), 'claude-haiku-5-5', 100000, 0, 0, 0, 0), 10000::bigint,
  '100K input tokens cost $0.01');
select is((select cost_micros from public.mimir_calls where id = (select v::uuid from t where k = 'c1')), 10000::bigint, 'the cost is stored');
select ok((select last_call_at is not null from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 'a'))),
  'a reservation marks the install used');
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
-- (a large install cap, so the shrinking install cap does not answer first)
update public.mimir_limits set edition_daily_micros = 2000000, install_daily_micros = 100000000 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.6', 'claude-haiku-5-5', 0, 380004, 0) $$, (select v from t where k = 'a5')), 'P0001',
  'daily limit for this edition reached', 'the edition cap is shared by every install of the edition');
update public.mimir_limits set install_daily_micros = 500000 where edition = 'slicerx';

-- In flight: a call that has not settled holds a place.
update public.mimir_limits set install_in_flight = 1 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.6', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'a4')), 'P0001',
  'too many calls at once', 'an install has a limit of calls at once');
update public.mimir_limits set install_in_flight = 3, edition_in_flight = 1 where edition = 'layermate';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.4', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'lm')), 'P0001',
  'too many calls at once for this edition', 'an edition has a limit of calls at once');
update public.mimir_limits set install_in_flight = 3, edition_in_flight = 400;
-- 10.0.0.1 has calls open, so a fresh install there is held to the address's share.
update public.mimir_limits set ip_in_flight = 1 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.1', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'a5')), 'P0001',
  'too many calls at once from this address', 'an address has a limit of calls at once');
update public.mimir_limits set ip_in_flight = 10;
-- A call left open past the function's time limit (the runtime killed it) frees its place.
insert into t values ('w', pg_temp.reg('slicerx', '10.0.1.1'));
update public.mimir_limits set install_in_flight = 1 where edition = 'slicerx';
select public.mimir_reserve((select v from t where k = 'w'), '10.0.1.1', 'claude-haiku-5-5', 0, 2, 0);
update public.mimir_calls set created_at = now() - interval '8 minutes'
where install_id = (select id from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 'w')));
select lives_ok(format($$ select public.mimir_reserve(%L, '10.0.1.1', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'w')),
  'a call open past the time limit no longer holds a place');
update public.mimir_limits set install_in_flight = 3 where edition = 'slicerx';
-- A /48 holds calls at once and spending across its /64s.
insert into t values ('v1', pg_temp.reg('slicerx', '2001:db8:9:1::1')), ('v2', pg_temp.reg('slicerx', '2001:db8:9:2::1'));
update public.mimir_limits set net_in_flight = 1 where edition = 'slicerx';
select public.mimir_reserve((select v from t where k = 'v1'), '2001:db8:9:1::1', 'claude-haiku-5-5', 0, 2, 0);
select throws_ok(format($$ select public.mimir_reserve(%L, '2001:db8:9:2::1', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'v2')), 'P0001',
  'too many calls at once from this network', 'a /48 has a limit of calls at once across its /64s');
-- room for 1 more micro-dollar, and a call worth 2
update public.mimir_limits set net_in_flight = 24, net_daily_micros = 1 + (select sum(coalesce(cost_micros, reserved_micros)) from public.mimir_calls
  where net_hash = (select c.net_hash from public.mimir_calls c join public.mimir_installs i on i.id = c.install_id
    where i.token_hash = public.mimir_token_hash((select v from t where k = 'v1')) limit 1)) where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '2001:db8:9:2::1', 'claude-haiku-5-5', 0, 4, 0) $$, (select v from t where k = 'v2')), 'P0001',
  'daily limit for this network reached', 'a /48 has a daily cap across its /64s');
-- a /48 already at its day's spend is refused before the lock, with a hint that asks for no exact count
update public.mimir_limits set net_daily_micros = (select sum(coalesce(cost_micros, reserved_micros)) from public.mimir_calls
  where net_hash = (select c.net_hash from public.mimir_calls c join public.mimir_installs i on i.id = c.install_id
    where i.token_hash = public.mimir_token_hash((select v from t where k = 'v1')) limit 1)) where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '2001:db8:9:2::1', 'claude-haiku-5-5', 0, 0, 0) $$, (select v from t where k = 'v2')), 'P0001',
  'this network has used its daily limit', 'a /48 at its cap is refused even for a call that costs nothing');
-- and one already holding its calls at once
update public.mimir_limits set net_daily_micros = 6000000, net_in_flight = 1 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '2001:db8:9:2::1', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'v2')), 'P0001',
  'too many calls at once from this network', 'a /48 at its calls at once is refused before the lock');
update public.mimir_limits set net_daily_micros = 6000000, net_in_flight = 24;

-- Past half of the edition's cap, an install's cap shrinks with what the edition has left.
select is(public.mimir_install_cap((select l from public.mimir_limits l where edition = 'slicerx'), 0), 500000::bigint, 'full install cap early in the day');
select is(public.mimir_install_cap((select l from public.mimir_limits l where edition = 'slicerx'), 1500000), 250000::bigint,
  'three quarters of the edition used leaves half an install cap');
select is(public.mimir_install_cap((select l from public.mimir_limits l where edition = 'slicerx'), 2000000), 0::bigint, 'nothing at the edition cap');
-- slicerx has used 1809999 of 2000000, so a4's cap is down to 95000: the refusal names the edition
update public.mimir_limits set install_in_flight = 10 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.6', 'claude-haiku-5-5', 0, 200000, 0) $$, (select v from t where k = 'a5')), 'P0001',
  'daily limit for this edition reached', 'a cap shrunk by the edition''s budget says the edition''s limit is used up');
update public.mimir_limits set install_in_flight = 3 where edition = 'slicerx';

-- Paused and per-minute.
update public.mimir_limits set enabled = false where edition = 'layermate';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.4', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'lm')), 'P0001',
  'mimir is paused', 'a paused edition refuses calls');
update public.mimir_limits set enabled = true, install_per_minute = 1 where edition = 'layermate';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.0.4', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'lm')), 'P0001',
  'too many requests', 'the per-minute limit holds');
-- Refused requests count toward the rates, per install and per address.
insert into t values ('r', pg_temp.reg('slicerx', '10.0.2.1'));
select public.mimir_refused((select v from t where k = 'r'), '10.0.2.1'), public.mimir_refused((select v from t where k = 'r'), '10.0.2.1');
update public.mimir_limits set install_per_minute = 2 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.2.9', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'r')), 'P0001',
  'too many requests', 'refusals count toward the install''s rate');
update public.mimir_limits set install_per_minute = 20, ip_per_minute = 2 where edition = 'slicerx';
select throws_ok(format($$ select public.mimir_reserve(%L, '10.0.2.1', 'claude-haiku-5-5', 0, 2, 0) $$, (select v from t where k = 'w')), 'P0001',
  'too many requests from this address', 'refusals count toward the address''s rate');
update public.mimir_limits set ip_per_minute = 60;
-- refusals past the rate window are cleared
insert into public.mimir_refusals (install_id, ip_hash, created_at)
select id, 'old', now() - interval '2 minutes' from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 'r'));
select public.mimir_refused((select v from t where k = 'r'), '10.0.2.1');
select ok(not exists (select 1 from public.mimir_refusals where ip_hash = 'old'), 'refusals past the rate window are cleared');

-- Sessions, forget and the reader --------------------------------------------------------
-- Each stored turn is a settled call of its own.
create function pg_temp.done(p_token text) returns uuid language plpgsql as $$
declare v uuid := public.mimir_reserve(p_token, '10.0.0.20', 'claude-haiku-5-5', 0, 2, 0);
begin
  perform public.mimir_settle(v, 'claude-haiku-5-5', 1, 0, 0, 1, 0);
  return v;
end;
$$;
grant execute on function pg_temp.done(text) to service_role;
insert into t values ('aid', (select id from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 'a')))::text);
update public.mimir_limits set install_per_minute = 100;
-- a fresh install, so the earlier calls' caps do not get in the way
insert into t values ('s', pg_temp.reg('slicerx', '10.0.0.21'));
insert into t values ('d1', pg_temp.done((select v from t where k = 's'))::text), ('d2', pg_temp.done((select v from t where k = 's'))::text);
select ok(public.mimir_store_session((select v::uuid from t where k = 'd1'), 's1', '0.2.0', 'claude-haiku-5-5', '{"messages":[1]}'),
  'a settled call stores its turn');
select throws_ok(format($$ select public.mimir_store_session(%L, 's1', '0.2.0', 'claude-haiku-5-5', '{}') $$, (select v from t where k = 'd1')),
  '22023', null, 'a call stores once');
select public.mimir_store_session((select v::uuid from t where k = 'd2'), 's1', '0.2.0', 'claude-haiku-5-5', '{"messages":[1,2]}');
select is((select turns from public.mimir_sessions where session_key = 's1'), 2, 'each turn updates the one session');
insert into t values ('d3', pg_temp.done((select v from t where k = 's'))::text);
select ok(not public.mimir_store_session((select v::uuid from t where k = 'd3'), 's1', '0.2.0', 'claude-haiku-5-5',
  jsonb_build_object('pad', repeat('x', 262145))), 'a turn over 256 KB is not stored');
select is((select octet_length(transcript::text) < 100 from public.mimir_sessions where session_key = 's1'), true, 'and the last stored turn stays');
update public.mimir_limits set install_store_daily_bytes = 40 where edition = 'slicerx';
insert into t values ('d4', pg_temp.done((select v from t where k = 's'))::text);
select ok(not public.mimir_store_session((select v::uuid from t where k = 'd4'), 's1', '0.2.0', 'claude-haiku-5-5', '{"messages":[1,2,3]}'),
  'an install stops storing past its bytes for the day');
update public.mimir_limits set install_store_daily_bytes = 8388608 where edition = 'slicerx';
update public.mimir_limits set edition_daily_micros = 5000000, enabled = true where edition = 'layermate';
insert into t values ('lm2', pg_temp.reg('layermate', '10.0.0.22'));
select public.mimir_store_session(pg_temp.done((select v from t where k = 'lm2')), 's2', '0.2.0', 'claude-haiku-5-5', '{"messages":["lm"]}');
insert into t values ('sid', (select id from public.mimir_installs where token_hash = public.mimir_token_hash((select v from t where k = 's')))::text);
reset role;
set local role mimir_session_reader;
select is((select count(*)::int from public.mimir_reader_sessions()), 1, 'the reader sees only LayerMate sessions');
select is(public.mimir_reader_session((select v::uuid from t where k = 'sid'), 's1'),
  null, 'the reader cannot open a SlicerX session');
reset role;
set local role service_role;
select is(public.mimir_forget((select v from t where k = 's')), 1, 'forget deletes the install''s sessions');

select * from finish();
rollback;
