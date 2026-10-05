-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Row level security tests (pgTAP): who sees which rows, the social tables,
-- downloads and personal API tokens. Run with `supabase test db` after
-- `supabase db reset`, which loads the seed these tests rely on.
begin;
create extension if not exists pgtap with schema extensions;
select plan(47);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.profiles where handle = 'ferro') as ferro,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'marrow')) as marrow_creator,
  (select id from public.listings where slug = 'trilobite-coaster-set') as pending_listing,
  (select id from public.listings where slug = 'wizard-tower-terrain') as rejected_listing,
  (select id from public.listings where slug = 'gear-tooth-test-strip') as archived_listing,
  (select id from public.listings where slug = 'logo-keychain') as removed_listing,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_listing,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'marrow') and l.status = 'approved' order by l.slug limit 1) as marrow_listing,
  (select id from public.comments where deleted_at is null limit 1) as any_comment;
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

-- Schema-wide -------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0, 'every public table has row level security enabled');
select is(
  (select count(*)::int from information_schema.tables where table_schema = 'public'
   and table_name in ('subscriptions', 'tiers', 'licenses', 'boosts', 'print_events', 'print_pool_ledger', 'pool_periods')),
  0, 'the pricing tables are gone');

-- Anonymous ---------------------------------------------------------------------
select pg_temp.as_anon();
select is((select count(*)::int from public.listings), 20, 'anon sees the 20 approved listings');
select is((select count(*)::int from public.listings where status <> 'approved'), 0, 'anon sees no pending, rejected, archived or removed listing');
select is((select count(*)::int from public.listing_versions where listing_id = (select pending_listing from ids)), 0, 'anon sees no versions of a pending listing');
select is((select count(*)::int from public.listing_files f join public.listing_versions v on v.id = f.version_id where v.review_status <> 'approved'), 0, 'anon sees no files of unreviewed versions');
select is((select count(*)::int from public.creators), 5, 'anon sees the 5 creator pages');
select ok((select count(*) from public.creator_links) > 0, 'anon reads creator links');
select throws_ok($$select count(*) from public.follows$$, '42501', null, 'anon has no read access to follows');
select throws_ok($$select count(*) from public.downloads$$, '42501', null, 'anon has no read access to the download rows');
select throws_ok($$select count(*) from public.audit_log$$, '42501', null, 'anon has no read access to the audit log');
select throws_ok($$select count(*) from public.moderation_queue$$, '42501', null, 'anon has no read access to the moderation queue');
select is((select moderation_mode from public.library_settings), 'owner-approves-all', 'anyone can read the moderation mode');
select throws_ok(
  $$insert into public.likes (user_id, listing_id) select rv, ferro_listing from ids$$,
  '42501', null, 'anon cannot like');
select throws_ok(
  $$select public.record_download((select ferro_listing from ids))$$,
  '42501', null, 'anon cannot download');

-- Member ------------------------------------------------------------------------
select pg_temp.as_user('rv');
select is((select role from public.profiles where handle = 'rv'), 'member', 'rv is a member');
select is((select count(*)::int from public.listings), 20, 'a member sees only approved listings');
select is((select count(*)::int from public.listings where id = (select pending_listing from ids)), 0, 'a member cannot see a pending listing');
select is((select count(*)::int from public.audit_log), 0, 'a member reads no audit log');
select is((select count(*)::int from public.moderation_queue), 0, 'a member reads no moderation queue');
select lives_ok(
  $$insert into public.likes (user_id, listing_id) select rv, ferro_listing from ids on conflict do nothing$$,
  'a member can like an approved listing');
select throws_ok(
  $$insert into public.likes (user_id, listing_id) select ash, ferro_listing from ids$$,
  '42501', null, 'a member cannot like as someone else');
select throws_ok(
  $$insert into public.likes (user_id, listing_id) select rv, pending_listing from ids$$,
  '42501', null, 'a member cannot like a listing they cannot see');
select lives_ok(
  $$insert into public.comments (listing_id, user_id, body) select ferro_listing, rv, 'Printed this over the weekend.' from ids$$,
  'a member can comment');
select throws_ok(
  $$insert into public.comments (listing_id, user_id, body) select pending_listing, rv, 'Sneaky' from ids$$,
  '42501', null, 'a member cannot comment on a pending listing');
select lives_ok(
  $$insert into public.collections (owner_id, name) select rv, 'Weekend queue' from ids$$,
  'a member can make a collection');
select lives_ok(
  $$insert into public.collection_items (collection_id, listing_id)
    select (select id from public.collections where name = 'Weekend queue' and owner_id = (select rv from ids)), ferro_listing from ids$$,
  'a member can collect an approved listing');
reset role;
delete from public.downloads where user_id = (select rv from ids);
select pg_temp.as_user('rv');
select lives_ok($$select public.record_download((select ferro_listing from ids))$$, 'a member can download an approved listing');
select is((select count from public.downloads where listing_id = (select ferro_listing from ids) and user_id = (select rv from ids)), 1, 'the download is counted');
select lives_ok($$select public.record_download((select ferro_listing from ids))$$, 'a second download counts again');
select is((select count from public.downloads where listing_id = (select ferro_listing from ids) and user_id = (select rv from ids)), 2, 'the count is now 2');
select throws_ok(
  $$select public.record_download((select pending_listing from ids))$$,
  'P0002', null, 'a member cannot download a pending listing');
select throws_ok(
  $$insert into public.downloads (user_id, listing_id) select rv, ferro_listing from ids$$,
  '42501', null, 'a member cannot write download rows directly');
select throws_ok(
  $$insert into public.listing_files (version_id, name, role, size_bytes, sha256)
    select v.id, 'x.stl', 'model', 1, repeat('a', 64) from public.listing_versions v limit 1$$,
  '42501', null, 'a member cannot write file manifest rows');
select throws_ok(
  $$select public.approve_listing((select pending_listing from ids))$$,
  '42501', null, 'a member cannot approve');
update public.comments set deleted_at = now() where id = (select any_comment from ids) and user_id is distinct from (select rv from ids);
reset role;
select is((select deleted_at is null from public.comments where id = (select any_comment from ids)), true, 'a member cannot soft-delete someone else''s comment');
select pg_temp.as_user('rv');

-- Personal API tokens (auth module) ------------------------------------------------
select pg_temp.as_anon();
select throws_ok(
  $$select * from public.create_api_token('x', array['cli'])$$,
  '42501', null, 'anon cannot create an API token');

select pg_temp.as_user('rv');
insert into tok select t.token, t.id from public.create_api_token('Laptop CLI', array['cli', 'mcp'], 30) t;
select ok((select token ~ '^sxk_[0-9a-f]{64}$' from tok), 'member creates an API token and sees it once');
select is((select count(*)::int from public.api_tokens where id = (select id from tok)), 1, 'member lists their own token');
select throws_ok(
  $$select token_hash from public.api_tokens$$,
  '42501', null, 'the token hash column is not readable by clients');
select throws_ok(
  $$select * from public.create_api_token('bad', array['admin'])$$,
  '23514', null, 'unknown scopes are rejected');
select throws_ok(
  $$select * from public.resolve_api_token((select token from tok))$$,
  '42501', null, 'members cannot resolve tokens');

select pg_temp.as_user('ash');
select is((select count(*)::int from public.api_tokens where id = (select id from tok)), 0, 'another member cannot see the token');
select is(
  (select count(*)::int from public.collections where owner_id = (select rv from ids) and not is_public),
  0, 'another member cannot see a private collection');

select pg_temp.as_service();
select is(
  (select user_id from public.resolve_api_token((select token from tok))),
  (select rv from ids), 'the service role resolves a token to its user');

select pg_temp.as_user('rv');
select ok(public.revoke_api_token((select id from tok)), 'member revokes their token');
select pg_temp.as_service();
select is((select count(*)::int from public.resolve_api_token((select token from tok))), 0, 'a revoked token no longer resolves');

select * from finish();
rollback;
