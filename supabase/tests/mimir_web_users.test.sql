-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The browser build's mimir edition (pgTAP): signed-in users only, one install per user made on first use, every
-- cap at or under slicerx's, nothing registers for it, and its use counts apart from slicerx's. Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000', 'b2b2b2b2-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'web1@example.com'),
  ('00000000-0000-0000-0000-000000000000', 'b2b2b2b2-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'web2@example.com');

select is((select count(*)::int from public.mimir_limits where edition = 'slicerx-web' and enabled and signed_in), 1,
  'slicerx-web is a signed-in edition, on');
select is((select install_daily_micros from public.mimir_limits where edition = 'slicerx-web'), 250000::bigint, 'a user gets $0.25 a day');
select is((select install_per_minute from public.mimir_limits where edition = 'slicerx-web'), 10, 'and 10 calls a minute');
select ok(
  (select w.edition_daily_micros <= s.edition_daily_micros and w.install_daily_micros <= s.install_daily_micros and w.ip_daily_micros <= s.ip_daily_micros
      and w.net_daily_micros <= s.net_daily_micros and w.install_in_flight <= s.install_in_flight and w.ip_in_flight <= s.ip_in_flight
      and w.net_in_flight <= s.net_in_flight and w.edition_in_flight <= s.edition_in_flight
      and w.install_per_minute <= s.install_per_minute and w.ip_per_minute <= s.ip_per_minute
   from public.mimir_limits w, public.mimir_limits s where w.edition = 'slicerx-web' and s.edition = 'slicerx'),
  'every web cap is at or under the desktop edition''s');
select throws_ok($$ update public.mimir_limits set register_key_hash = public.mimir_token_hash('web-build-key-0001') where edition = 'slicerx-web' $$,
  '23514', null, 'a signed-in edition cannot take a registration key');

set local role anon;
select throws_ok($$ select public.mimir_user_token('slicerx-web', 'b2b2b2b2-0000-4000-8000-000000000001', '203.0.113.7') $$, '42501', null, 'anon cannot get a user token');
set local role authenticated;
select throws_ok($$ select public.mimir_user_token('slicerx-web', 'b2b2b2b2-0000-4000-8000-000000000001', '203.0.113.7') $$, '42501', null, 'nor can a signed-in user');
reset role;

set local role service_role;
select throws_ok($$ select * from public.mimir_register('slicerx-web', '203.0.113.7', 'any-web-build-key-01') $$, 'P0001', null, 'nothing registers for slicerx-web');
select throws_ok($$ select public.mimir_user_token('slicerx', 'b2b2b2b2-0000-4000-8000-000000000001', '203.0.113.7') $$, '22023', null, 'slicerx takes no user tokens');
select throws_ok($$ select public.mimir_user_token('slicerx-web', 'b2b2b2b2-0000-4000-8000-0000000000ff', '203.0.113.7') $$, 'P0001', 'unknown user', 'an unknown user gets none');
create temp table toks as select
  public.mimir_user_token('slicerx-web', 'b2b2b2b2-0000-4000-8000-000000000001', '203.0.113.7') as a1,
  public.mimir_user_token('slicerx-web', 'b2b2b2b2-0000-4000-8000-000000000001', '198.51.100.9') as a2,
  public.mimir_user_token('slicerx-web', 'b2b2b2b2-0000-4000-8000-000000000002', '203.0.113.7') as b;
select ok((select a1 = a2 and a1 <> b and a1 ~ '^[0-9a-f]{64}$' from toks), 'a user''s token is the same from any address, and theirs alone');
select is((select count(*)::int from public.mimir_installs where edition = 'slicerx-web'), 2, 'one install per user');
select lives_ok($$ select public.mimir_reserve((select a1 from toks), '203.0.113.7', 'claude-haiku-5-5', 100, 100, 0) $$, 'a user''s token reserves');
select is((select edition from public.mimir_quota((select a1 from toks), '203.0.113.7')), 'slicerx-web', 'and its quota is the web edition''s');
reset role;

delete from auth.users where id = 'b2b2b2b2-0000-4000-8000-000000000001';
select is((select count(*)::int from public.mimir_installs where edition = 'slicerx-web'), 1, 'deleting the account deletes its install');

select * from finish();
rollback;
