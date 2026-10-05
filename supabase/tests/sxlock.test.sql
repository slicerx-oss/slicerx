-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Locked projects (pgTAP): content keys only for the owning account, key
-- rotation and revocation, and integrator tokens limited to the sxlock_open
-- and sxlock_seal scopes. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash;
create temp table sealed (label text primary key, owner uuid, key_id uuid, content_key text) on commit drop;
create temp table tok (label text primary key, token text) on commit drop;
grant select on ids to anon, authenticated, service_role;
grant all on sealed, tok to anon, authenticated, service_role;

create function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
end;
$$;

-- Fixed salts, 32 bytes as hex.
create function pg_temp.salt(n int) returns text language sql as $$ select repeat(lpad(to_hex(n), 2, '0'), 32) $$;

-- Sealing ---------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select * from public.sxlock_seal(pg_temp.salt(1))$$, '42501', null, 'signed out, there is nothing to seal with');

select pg_temp.as_user((select rv from ids));
insert into sealed select 'a', s.owner, s.key_id, s.content_key from public.sxlock_seal(pg_temp.salt(1)) s;
select is((select owner from sealed where label = 'a'), (select rv from ids), 'the file names the exporting account as owner');
select ok((select content_key ~ '^[0-9a-f]{64}$' from sealed where label = 'a'), 'the content key is 32 bytes');
insert into sealed select 'b', s.owner, s.key_id, s.content_key from public.sxlock_seal(pg_temp.salt(2)) s;
select is((select key_id from sealed where label = 'b'), (select key_id from sealed where label = 'a'), 'exports share the account''s active key');
select isnt((select content_key from sealed where label = 'b'), (select content_key from sealed where label = 'a'), 'each salt gives its own content key');
select throws_ok($$select * from public.sxlock_seal('abc')$$, '22023', null, 'a short salt is refused');
select throws_ok($$select * from sxlock.account_keys$$, '42501', null, 'members cannot read account keys');
select is((select count(*)::int from public.sxlock_keys()), 1, 'the member sees one key, without its secret');

-- Opening ---------------------------------------------------------------------
select is(public.sxlock_open((select rv from ids), (select key_id from sealed where label = 'a'), pg_temp.salt(1)),
  (select content_key from sealed where label = 'a'), 'the owner gets the same content key back');
select throws_ok(format('select public.sxlock_open(%L, %L, %L)', (select rv from ids), gen_random_uuid(), pg_temp.salt(1)),
  'P0002', null, 'an unknown key id is refused');

select pg_temp.as_user((select ash from ids));
select throws_ok(format('select public.sxlock_open(%L, %L, %L)', (select rv from ids), (select key_id from sealed where label = 'a'), pg_temp.salt(1)),
  '42501', 'this locked project belongs to another SlicerX account', 'another account cannot open it');
select throws_ok(format('select public.sxlock_open(%L, %L, %L)', (select ash from ids), (select key_id from sealed where label = 'a'), pg_temp.salt(1)),
  'P0002', null, 'naming itself as owner does not borrow the owner''s key');

select pg_temp.as_anon();
select throws_ok(format('select public.sxlock_open(%L, %L, %L)', (select rv from ids), (select key_id from sealed where label = 'a'), pg_temp.salt(1)),
  '42501', null, 'signed out, nothing opens');

-- Rotation and revocation -----------------------------------------------------
select pg_temp.as_user((select rv from ids));
select isnt((select id from public.rotate_sxlock_key()), (select key_id from sealed where label = 'a'), 'rotation makes a new key');
insert into sealed select 'c', s.owner, s.key_id, s.content_key from public.sxlock_seal(pg_temp.salt(3)) s;
select isnt((select key_id from sealed where label = 'c'), (select key_id from sealed where label = 'a'), 'new exports use the new key');
select is(public.sxlock_open((select rv from ids), (select key_id from sealed where label = 'a'), pg_temp.salt(1)),
  (select content_key from sealed where label = 'a'), 'files under the retired key still open');
select ok(public.revoke_sxlock_key((select key_id from sealed where label = 'a')), 'the owner revokes the old key');
select throws_ok(format('select public.sxlock_open(%L, %L, %L)', (select rv from ids), (select key_id from sealed where label = 'a'), pg_temp.salt(1)),
  '42501', 'the key this project was locked with was revoked', 'files under a revoked key no longer open');
select is(public.sxlock_open((select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  (select content_key from sealed where label = 'c'), 'files under the new key still open');

-- Integrator tokens -----------------------------------------------------------
insert into tok select 'open', t.token from public.create_api_token('LayerMate', array['sxlock_open']) t;
insert into tok select 'other', t.token from public.create_api_token('Slicing', array['cloud_slice']) t;
insert into tok select 'export', t.token from public.create_api_token('Exporter', array['sxlock_seal']) t;
select pg_temp.as_user((select ash from ids));
insert into tok select 'ash', t.token from public.create_api_token('Ash LayerMate', array['sxlock_open']) t;

select pg_temp.as_anon();
select is(public.sxlock_open_with_token((select token from tok where label = 'open'), (select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  (select content_key from sealed where label = 'c'), 'a token with sxlock_open opens the owner''s file');
select throws_ok(format('select public.sxlock_open_with_token(%L, %L, %L, %L)', (select token from tok where label = 'other'), (select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  '42501', 'the API token does not have the sxlock_open scope', 'a token without the scope is refused');
select throws_ok(format('select public.sxlock_open_with_token(%L, %L, %L, %L)', (select token from tok where label = 'ash'), (select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  '42501', 'this locked project belongs to another SlicerX account', 'another account''s token is refused');
select throws_ok(format('select public.sxlock_open_with_token(%L, %L, %L, %L)', 'sxk_not_a_token', (select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  '42501', 'the API token is not valid', 'an unknown token is refused');

insert into sealed select 'd', s.owner, s.key_id, s.content_key from public.sxlock_seal_with_token((select token from tok where label = 'export'), pg_temp.salt(4)) s;
select is((select owner from sealed where label = 'd'), (select rv from ids), 'a token with sxlock_seal locks files for its own account');
select is((select key_id from sealed where label = 'd'), (select key_id from sealed where label = 'c'), 'under the account''s active key');
select throws_ok(format('select * from public.sxlock_seal_with_token(%L, %L)', (select token from tok where label = 'open'), pg_temp.salt(5)),
  '42501', 'the API token does not have the sxlock_seal scope', 'an open-only token cannot export');
select throws_ok(format('select public.sxlock_open_with_token(%L, %L, %L, %L)', (select token from tok where label = 'export'), (select rv from ids), (select key_id from sealed where label = 'd'), pg_temp.salt(4)),
  '42501', 'the API token does not have the sxlock_open scope', 'an export-only token cannot open');

reset role;
update public.profiles set banned_at = now(), ban_reason = 'test' where id = (select rv from ids);
select pg_temp.as_anon();
select throws_ok(format('select public.sxlock_open_with_token(%L, %L, %L, %L)', (select token from tok where label = 'open'), (select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  '42501', 'this account is banned', 'a banned account cannot open by token');
reset role;
update public.profiles set banned_at = null, ban_reason = null where id = (select rv from ids);

select pg_temp.as_user((select rv from ids));
select is(public.sxlock_open((select rv from ids), (select key_id from sealed where label = 'd'), pg_temp.salt(4)),
  (select content_key from sealed where label = 'd'), 'the owner opens what the integrator locked');
select ok(public.revoke_all_api_tokens() >= 3, 'the owner revokes the tokens');
select pg_temp.as_anon();
select throws_ok(format('select public.sxlock_open_with_token(%L, %L, %L, %L)', (select token from tok where label = 'open'), (select rv from ids), (select key_id from sealed where label = 'c'), pg_temp.salt(3)),
  '42501', 'the API token is not valid', 'a revoked token no longer opens anything');

select * from finish();
rollback;
