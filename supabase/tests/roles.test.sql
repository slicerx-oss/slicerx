-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Roles, bans, the audit log and paired devices (pgTAP). Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(69);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'owner') as owner,
  (select id from public.profiles where handle = 'moderator') as moderator,
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.profiles where handle = 'ferro') as ferro,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_listing;
grant select on ids to anon, authenticated, service_role;
create temp table tok (token text, id uuid) on commit drop;
grant all on tok to authenticated, service_role;

create function pg_temp.as_user(p_handle text) returns void language plpgsql as $$
declare
  uid uuid;
begin
  reset role;
  select id into uid from public.profiles where handle = p_handle;
  if uid is null then raise exception 'no profile %', p_handle; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
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

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end;
$$;


-- Roles -----------------------------------------------------------------------------
select is((select role from public.profiles where handle = 'owner'), 'owner', 'the seed has one owner');
select is((select count(*)::int from public.profiles where role = 'owner'), 1, 'only one owner can exist');
select throws_ok(
  $$update public.profiles set role = 'owner' where handle = 'rv'$$,
  '23505', null, 'a second owner is refused by the database');

select pg_temp.as_anon();
select is(public.my_role(), null, 'my_role is null when signed out');
select is(public.is_staff(), false, 'anon is not staff');

select pg_temp.as_user('rv');
select is(public.my_role(), 'member', 'my_role reports member');
select lives_ok($$update public.profiles set display_name = 'Rv Renamed' where handle = 'rv'$$, 'a member edits their display name');
select throws_ok($$update public.profiles set role = 'owner' where handle = 'rv'$$, '42501', null, 'a member cannot set their own role');
select throws_ok($$update public.profiles set role = 'moderator' where handle = 'rv'$$, '42501', null, 'a member cannot make themselves a moderator');
select throws_ok($$update public.profiles set banned_at = null, ban_reason = null where handle = 'zed'$$, '42501', null, 'a member cannot touch ban columns');
select throws_ok($$select public.set_user_role((select ash from ids), 'moderator')$$, '42501', null, 'a member cannot assign roles');
select throws_ok($$select public.ban_user((select ash from ids), 'no reason')$$, '42501', null, 'a member cannot ban');
select throws_ok($$select public.unban_user((select id from public.profiles where handle = 'zed'))$$, '42501', null, 'a member cannot lift a ban');
select is((select count(*)::int from public.audit_log), 0, 'a member reads no audit log');
select throws_ok($$select public.audit('x', 'user', null)$$, '42501', null, 'clients cannot write audit rows');

select pg_temp.as_user('moderator');
select is(public.my_role(), 'moderator', 'my_role reports moderator');
select throws_ok($$select public.set_user_role((select ash from ids), 'creator')$$, '42501', 'only the owner can change roles', 'a moderator cannot assign roles');
select ok((select count(*) from public.audit_log) > 0, 'a moderator reads the audit log');
select throws_ok($$select public.ban_user((select owner from ids), 'trying')$$, '42501', null, 'a moderator cannot ban the owner');
select throws_ok($$select public.ban_user((select moderator from ids), 'myself')$$, '42501', null, 'a moderator cannot ban themselves');

select pg_temp.as_user('owner');
select is(public.my_role(), 'owner', 'my_role reports owner');
select lives_ok($$select public.set_user_role((select ash from ids), 'moderator', 'trusted volunteer')$$, 'the owner makes a moderator');
select is((select role from public.profiles where handle = 'ash'), 'moderator', 'the role changed');
select throws_ok($$select public.set_user_role((select ash from ids), 'owner')$$, '23514', null, 'the owner role cannot be assigned through set_user_role');
select throws_ok($$select public.set_user_role((select owner from ids), 'member')$$, '42501', null, 'the owner''s own role cannot be changed');
select throws_ok($$select public.set_user_role((select ash from ids), 'admin')$$, '23514', null, 'unknown roles are refused');
select lives_ok($$select public.set_user_role((select ash from ids), 'member', 'back to member')$$, 'the owner demotes a moderator');
select is(
  (select count(*)::int from public.audit_log where action = 'role_change' and target_id = (select ash from ids) and actor_id = (select owner from ids)),
  2, 'both role changes are in the audit log');
select is(
  (select detail from public.audit_log where action = 'role_change' and reason = 'trusted volunteer'),
  '{"from": "member", "to": "moderator"}'::jsonb, 'the audit row records the change');

-- Bans -----------------------------------------------------------------------------
select pg_temp.as_user('rv');
insert into tok select t.token, t.id from public.create_api_token('Before ban', array['cli']) t;

select pg_temp.as_user('moderator');
select throws_ok($$select public.ban_user((select rv from ids), '  ')$$, '23514', null, 'a ban needs a reason');
select lives_ok($$select public.ban_user((select rv from ids), 'Spam uploads')$$, 'a moderator bans a member');
select is((select banned_at is not null and ban_reason = 'Spam uploads' from public.profiles where handle = 'rv'), true, 'the profile records the ban');
reset role;
select is((select banned_until from auth.users where id = (select rv from ids)), 'infinity'::timestamptz, 'sign-in is blocked');
select is((select count(*)::int from public.api_tokens where user_id = (select rv from ids) and revoked_at is null), 0, 'the banned member''s tokens are revoked');
select pg_temp.as_user('moderator');
select is((select count(*)::int from public.audit_log where action = 'ban' and target_id = (select rv from ids) and reason = 'Spam uploads'), 1, 'the ban is in the audit log');

select pg_temp.as_user('rv');
select is(public.my_role(), 'banned', 'my_role reports banned');
select is(public.is_active_user(), false, 'a banned member is not active');
select throws_ok(
  $$insert into public.likes (user_id, listing_id) select rv, ferro_listing from ids$$,
  '42501', null, 'a banned member cannot like');
select throws_ok(
  $$insert into public.comments (listing_id, user_id, body) select ferro_listing, rv, 'hello' from ids$$,
  '42501', null, 'a banned member cannot comment');
select throws_ok($$select public.record_download((select ferro_listing from ids))$$, '42501', null, 'a banned member cannot download');
select throws_ok($$select * from public.create_api_token('After ban', array['cli'])$$, '42501', null, 'a banned member cannot create tokens');
select throws_ok(
  $$insert into public.creators (owner_id, handle, display_name) select rv, 'banned-page', 'Banned' from ids$$,
  '42501', null, 'a banned member cannot make a creator page');
update public.profiles set display_name = 'Still here' where handle = 'rv';
reset role;
select is((select display_name from public.profiles where handle = 'rv'), 'Rv Renamed', 'a banned member cannot edit their profile');

-- A banned creator disappears from the library.
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where creator_id = (select id from public.creators where owner_id = (select ferro from ids))), 4, 'before the ban anon sees the creator''s 4 approved listings');
select pg_temp.as_user('moderator');
select lives_ok($$select public.ban_user((select ferro from ids), 'Stolen models')$$, 'a moderator bans a creator');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where creator_id = (select id from public.creators where owner_id = (select ferro from ids))), 0, 'a banned creator''s listings are hidden');
select is((select count(*)::int from public.creators where owner_id = (select ferro from ids)), 0, 'a banned creator''s page is hidden');
select pg_temp.as_user('ferro');
select throws_ok(
  $$insert into public.listings (creator_id, slug, title) select (select id from public.creators where owner_id = ferro), 'while-banned', 'While banned' from ids$$,
  '42501', null, 'a banned creator cannot upload');
select pg_temp.as_user('moderator');
select is((select count(*)::int from public.listings where creator_id = (select id from public.creators where owner_id = (select ferro from ids))), 5, 'staff still see the banned creator''s listings');

select lives_ok($$select public.unban_user((select ferro from ids), 'Resolved')$$, 'a moderator lifts a ban');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where creator_id = (select id from public.creators where owner_id = (select ferro from ids))), 4, 'the approved listings are back');
reset role;
select is((select banned_until from auth.users where id = (select ferro from ids)), null, 'sign-in works again');
select pg_temp.as_service();

-- The audit log is append-only ---------------------------------------------------------
select throws_ok($$update public.audit_log set reason = 'edited'$$, 'P0001', 'the audit log is append-only', 'audit rows cannot be edited, even by the service role');
select throws_ok($$delete from public.audit_log$$, 'P0001', 'the audit log is append-only', 'audit rows cannot be deleted');
select throws_ok($$truncate public.audit_log$$, 'P0001', 'the audit log is append-only', 'the audit log cannot be truncated');

-- Paired devices ----------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select count(*) from public.paired_devices$$, '42501', null, 'anon has no access to paired devices');

select pg_temp.as_user('ash');
select lives_ok(
  $$insert into public.paired_devices (user_id, device_id, name, platform, sign_pub)
    select ash, 'device-ash-phone-1', 'Ash phone', 'ios', 'MCowBQYDK2VwAyEAvB2sPZ0m9aQj7xL3kT1nY8uE5rHc4dGfWzXo6iJqNbA=' from ids$$,
  'a member pairs a device');
select is((select count(*)::int from public.paired_devices), 1, 'the member lists their device');
select throws_ok(
  $$insert into public.paired_devices (user_id, device_id, name, platform, sign_pub)
    select ash, 'device-ash-phone-1', 'Again', 'ios', 'MCowBQYDK2VwAyEAvB2sPZ0m9aQj7xL3kT1nY8uE5rHc4dGfWzXo6iJqNbA=' from ids$$,
  '23505', null, 'a device id is unique per member');
select throws_ok(
  $$insert into public.paired_devices (user_id, device_id, name, platform, sign_pub)
    select owner, 'device-not-mine-1', 'Not mine', 'ios', 'MCowBQYDK2VwAyEAvB2sPZ0m9aQj7xL3kT1nY8uE5rHc4dGfWzXo6iJqNbA=' from ids$$,
  '42501', null, 'a member cannot pair a device to someone else');
select throws_ok(
  $$insert into public.paired_devices (user_id, device_id, name, platform, sign_pub)
    select ash, 'device-bad-key-1', 'Bad key', 'ios', 'short' from ids$$,
  '23514', null, 'a malformed public key is refused');
select throws_ok(
  $$update public.paired_devices set name = 'Renamed' where device_id = 'device-ash-phone-1'$$,
  '42501', null, 'only revoked_at can be updated');
select lives_ok($$update public.paired_devices set revoked_at = now() where device_id = 'device-ash-phone-1'$$, 'the member revokes the device');
select is((select revoked_at is not null from public.paired_devices where device_id = 'device-ash-phone-1'), true, 'revoked_at is set');
select throws_ok($$update public.paired_devices set revoked_at = null where device_id = 'device-ash-phone-1'$$, 'P0001', 'the device is already revoked', 'a revoked device cannot be revived');
select lives_ok(
  $$insert into public.paired_devices (user_id, device_id, name, platform, sign_pub)
    select ash, 'device-ash-tab-' || g, 'Tablet ' || g, 'android', 'MCowBQYDK2VwAyEAvB2sPZ0m9aQj7xL3kT1nY8uE5rHc4dGfWzXo6iJqNbA=' from ids, generate_series(1, 10) g$$,
  'ten active devices fit');
select throws_ok(
  $$insert into public.paired_devices (user_id, device_id, name, platform, sign_pub)
    select ash, 'device-ash-tab-11', 'Tablet 11', 'android', 'MCowBQYDK2VwAyEAvB2sPZ0m9aQj7xL3kT1nY8uE5rHc4dGfWzXo6iJqNbA=' from ids$$,
  'P0001', 'device limit reached; revoke one first', 'an eleventh active device is refused');

select pg_temp.as_user('owner');
select is((select count(*)::int from public.paired_devices), 0, 'another account sees none of those devices');
select is(
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paired_devices'),
  1, 'paired_devices is in the Realtime publication');

select * from finish();
rollback;
