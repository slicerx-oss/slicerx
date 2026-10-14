-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir_register's per-address and per-network limits (pgTAP): they count the installs made in the last
-- 24 hours, so older installs from a shared address never block it, and other addresses are unaffected.
-- Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

update public.mimir_limits set register_key_hash = public.mimir_token_hash(edition || '-key') where not signed_in;
update public.mimir_limits set registers_per_ip_day = 3, registers_per_net_day = 20, registers_per_day = 5000 where edition = 'slicerx';
create function pg_temp.reg(p_ip text) returns text language plpgsql as $$
declare v text;
begin
  select token into v from public.mimir_register('slicerx', p_ip, 'slicerx-key');
  return v;
end;
$$;
-- moves an address's installs back in time (still inside the 7 day cleanup of unused installs)
create function pg_temp.age(p_ip text, p_by interval) returns void language sql as $$
  update public.mimir_installs set created_at = created_at - p_by where created_ip_hash = public.mimir_ip_hash(p_ip);
$$;

set local role service_role;

-- three a day from one address, the fourth refused
select lives_ok($$ select pg_temp.reg('10.9.0.1') $$, 'a first install from an address registers');
select lives_ok($$ select pg_temp.reg('10.9.0.1') $$, 'a second registers');
select lives_ok($$ select pg_temp.reg('10.9.0.1') $$, 'a third registers');
select throws_ok($$ select pg_temp.reg('10.9.0.1') $$, 'P0001', 'too many new installs from this address today',
  'a fourth in the same day is refused');
select lives_ok($$ select pg_temp.reg('10.9.0.2') $$, 'another address is unaffected');

-- installs older than a day stop counting
reset role;
select pg_temp.age('10.9.0.1', interval '23 hours');
set local role service_role;
select throws_ok($$ select pg_temp.reg('10.9.0.1') $$, 'P0001', 'too many new installs from this address today',
  'installs 23 hours old still count');
reset role;
select pg_temp.age('10.9.0.1', interval '2 hours');
set local role service_role;
select lives_ok($$ select pg_temp.reg('10.9.0.1') $$, 'installs over 24 hours old no longer count');
select is((select count(*)::int from public.mimir_installs where created_ip_hash = public.mimir_ip_hash('10.9.0.1')), 4,
  'the old installs stay; only the count changed');
select lives_ok($$ select pg_temp.reg('10.9.0.1') $$, 'the new day has room for a second');
select lives_ok($$ select pg_temp.reg('10.9.0.1') $$, 'and a third');
select throws_ok($$ select pg_temp.reg('10.9.0.1') $$, 'P0001', 'too many new installs from this address today',
  'and refuses a fourth again');

-- the IPv6 /48 limit counts the same way
reset role;
update public.mimir_limits set registers_per_net_day = 2 where edition = 'slicerx';
select pg_temp.reg('2001:db8:9:1::1'), pg_temp.reg('2001:db8:9:2::1');
set local role service_role;
select throws_ok($$ select pg_temp.reg('2001:db8:9:3::1') $$, 'P0001', 'too many new installs from this network today',
  'a /48 at its limit inside the day is refused');
select lives_ok($$ select pg_temp.reg('2001:db8:a:1::1') $$, 'another /48 is unaffected');
reset role;
update public.mimir_installs set created_at = created_at - interval '25 hours'
  where created_net_hash = public.mimir_net_hash('2001:db8:9:1::1');
set local role service_role;
select lives_ok($$ select pg_temp.reg('2001:db8:9:3::1') $$, 'a /48''s installs over a day old no longer count');

select * from finish();
rollback;
