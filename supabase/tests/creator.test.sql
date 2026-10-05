-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Creator pages (pgTAP): handles, validated links, featured models, the
-- dashboard, deleting listings and the trusted flag. Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'owner') as owner,
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'marrow')) as marrow_creator,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_live,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'marrow') and l.status = 'approved' order by l.slug limit 1) as marrow_live,
  '33333333-3333-4333-8333-333333333333'::uuid as ferro_pending;
grant select on ids to anon, authenticated, service_role;

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



-- Acts as the member who owns the creator page of the listing with this slug.
create function pg_temp.as_uploader(p_slug text) returns void language plpgsql as $$
declare
  h text;
begin
  reset role;
  select p.handle into h from public.listings l join public.creators c on c.id = l.creator_id join public.profiles p on p.id = c.owner_id where l.slug = p_slug;
  perform pg_temp.as_user(h);
end;
$$;


-- Making a creator page --------------------------------------------------------------
select pg_temp.as_user('rv');
select is((select count(*)::int from public.creators where owner_id = (select rv from ids)), 0, 'rv has no creator page yet');
select throws_ok(
  $$insert into public.creators (owner_id, handle, display_name) select ash, 'stolen-page', 'Stolen' from ids$$,
  '42501', null, 'a member cannot make a page for someone else');
select throws_ok(
  $$insert into public.creators (owner_id, handle, display_name) select rv, 'admin', 'Admin' from ids$$,
  '23514', null, 'reserved handles are refused');
select throws_ok(
  $$insert into public.creators (owner_id, handle, display_name) select rv, 'Bad Handle', 'Bad' from ids$$,
  '23514', null, 'handles are lowercase letters, digits and hyphens');
select throws_ok(
  $$insert into public.creators (owner_id, handle, display_name) select rv, 'marrow-works', 'Copy' from ids$$,
  '23505', null, 'handles are unique');
select lives_ok(
  $$insert into public.creators (owner_id, handle, display_name, tagline, bio, logo_url, trusted)
    select rv, 'rv-prints', 'RV Prints', 'Small useful prints', 'I print things for my workshop.', 'https://example.com/rv.png', true from ids$$,
  'a member makes a creator page');
select is((select trusted from public.creators where handle = 'rv-prints'), false, 'a client cannot make themselves trusted on insert');
select is((select role from public.profiles where handle = 'rv'), 'creator', 'the member became a creator');
select throws_ok(
  $$insert into public.creators (owner_id, handle, display_name) select rv, 'second-page', 'Second' from ids$$,
  '23505', null, 'one page per member');
select throws_ok($$update public.creators set trusted = true where handle = 'rv-prints'$$, '42501', 'only the owner marks a creator trusted', 'a creator cannot mark themselves trusted');
select throws_ok($$update public.creators set owner_id = (select ash from ids) where handle = 'rv-prints'$$, '42501', null, 'a page cannot change owner');
select throws_ok($$update public.creators set logo_url = 'javascript:alert(1)' where handle = 'rv-prints'$$, '23514', null, 'a logo must be an https URL');
select lives_ok($$update public.creators set display_name = 'RV Prints Studio', bio = 'Updated bio.' where handle = 'rv-prints'$$, 'a creator edits their page');
select pg_temp.as_user('ash');
update public.creators set display_name = 'Hijacked' where handle = 'rv-prints';
select pg_temp.as_anon();
select is((select display_name from public.creators where handle = 'rv-prints'), 'RV Prints Studio', 'another member cannot edit the page');

-- Links -------------------------------------------------------------------------------------
select pg_temp.as_user('rv');
select lives_ok(
  $$insert into public.creator_links (creator_id, kind, label, url, position)
    select c.id, v.kind, v.label, v.url, v.pos from public.creators c, (values
      ('patreon', 'Patreon', 'https://www.patreon.com/rvprints', 1),
      ('website', 'My site', 'https://rvprints.example.org/about?ref=slicerx', 2),
      ('youtube', 'Channel', 'https://youtu.be/abc123', 3),
      ('makerworld', null, 'https://makerworld.com/en/@rvprints', 4),
      ('printables', null, 'https://www.printables.com/@rvprints', 5),
      ('thingiverse', null, 'https://www.thingiverse.com/rvprints', 6),
      ('instagram', null, 'https://instagram.com/rvprints', 7)
    ) as v(kind, label, url, pos) where c.handle = 'rv-prints'$$,
  'a creator adds links to the services they use');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'patreon', 'https://patreon.com.evil.example/rvprints' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'a Patreon link cannot point to a look-alike domain');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'patreon', 'https://example.com/patreon.com' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'a service name in the path does not count');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'youtube', 'https://notyoutube.com/x' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'a YouTube link must be on youtube.com or youtu.be');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'website', 'http://rvprints.example.org' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'plain http links are refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'website', 'javascript:alert(1)' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'script links are refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'website', 'https://patreon.com@evil.example/x' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'credentials in a URL are refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'website', 'https://localhost/admin' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'hosts without a public domain are refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'website', 'https://10.0.0.1/admin' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'IP addresses are refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'website', 'https://example.com/a b' from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'URLs with spaces are refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'other', 'https://example.com/' || repeat('a', 300) from public.creators where handle = 'rv-prints'$$,
  '23514', null, 'very long URLs are refused');
select throws_ok(
  $$update public.creator_links set url = 'https://example.com/moved' where kind = 'patreon' and creator_id = (select id from public.creators where handle = 'rv-prints')$$,
  '23514', null, 'the domain rule also applies to edits');
select lives_ok(
  $$insert into public.creator_links (creator_id, kind, url)
    select c.id, 'other', 'https://example.com/l' || g from public.creators c, generate_series(1, 5) g where c.handle = 'rv-prints'$$,
  'twelve links fit');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select id, 'other', 'https://example.com/one-too-many' from public.creators where handle = 'rv-prints'$$,
  'P0001', 'a creator page has at most 12 links', 'a thirteenth link is refused');
select throws_ok(
  $$insert into public.creator_links (creator_id, kind, url) select marrow_creator, 'other', 'https://example.com/not-mine' from ids$$,
  '42501', null, 'a creator cannot add links to someone else''s page');
select pg_temp.as_user('ash');
delete from public.creator_links where creator_id = (select id from public.creators where handle = 'rv-prints');
select pg_temp.as_anon();
select is((select count(*)::int from public.creator_links where creator_id = (select id from public.creators where handle = 'rv-prints')), 12, 'anon reads the links and no one else could delete them');
select pg_temp.as_user('rv');
select lives_ok($$delete from public.creator_links where kind = 'other' and creator_id = (select id from public.creators where handle = 'rv-prints')$$, 'a creator removes links');
select is((select count(*)::int from public.creator_links where creator_id = (select id from public.creators where handle = 'rv-prints')), 7, 'seven links remain');

-- Featured models -----------------------------------------------------------------------------
reset role;
delete from public.creator_featured where creator_id = (select ferro_creator from ids);
select pg_temp.as_user('ferro');
insert into public.listings (id, creator_id, slug, title) select ferro_pending, ferro_creator, 'ferro-pending-piece', 'Pending piece' from ids;
select lives_ok($$insert into public.creator_featured (creator_id, listing_id, position) select ferro_creator, ferro_live, 1 from ids$$, 'a creator features an approved model of their own');
select throws_ok($$insert into public.creator_featured (creator_id, listing_id, position) select ferro_creator, marrow_live, 2 from ids$$, '23514', 'feature only your own approved models', 'a creator cannot feature someone else''s model');
select throws_ok($$insert into public.creator_featured (creator_id, listing_id, position) select ferro_creator, ferro_pending, 2 from ids$$, '23514', null, 'a pending model cannot be featured');
select throws_ok($$insert into public.creator_featured (creator_id, listing_id, position) select ferro_creator, ferro_live, 7 from ids$$, '23514', null, 'at most six positions');
select throws_ok($$insert into public.creator_featured (creator_id, listing_id, position) select marrow_creator, marrow_live, 1 from ids$$, '42501', null, 'a creator cannot feature on someone else''s page');
select pg_temp.as_anon();
select is((select count(*)::int from public.creator_featured where creator_id = (select ferro_creator from ids)), 1, 'anon sees the featured model');
select pg_temp.as_user('ferro');
select lives_ok($$update public.listings set status = 'archived' where id = (select ferro_live from ids)$$, 'archiving a featured model');
select is((select count(*)::int from public.creator_featured where creator_id = (select ferro_creator from ids)), 0, 'takes it off the page');

-- Creator dashboard -----------------------------------------------------------------------------
select is((select count(*)::int from public.creator_dashboard()), (select count(*)::int from public.listings where creator_id = (select ferro_creator from ids)), 'the dashboard lists the creator''s own listings');
select is((select count(*)::int from public.creator_dashboard() d where d.listing_id = (select marrow_live from ids)), 0, 'and nobody else''s');
select pg_temp.as_anon();
select throws_ok($$select * from public.creator_dashboard()$$, '42501', null, 'anon has no dashboard');

-- Deleting listings -------------------------------------------------------------------------------
select pg_temp.as_user('marrow');
delete from public.listings where id = (select marrow_live from ids);
select pg_temp.as_service();
select is((select count(*)::int from public.listings where id = (select marrow_live from ids)), 1, 'a creator cannot delete an approved listing');
select pg_temp.as_user('ferro');
select lives_ok($$delete from public.listings where id = (select ferro_pending from ids)$$, 'a creator deletes a pending listing');
reset role;
select is(
  (select count(*)::int from public.storage_cleanup where prefix = (select ferro_pending from ids)::text || '/' and done_at is null),
  2, 'its files in both buckets are queued for removal');
select pg_temp.as_user('ferro');
select throws_ok($$select count(*) from public.storage_cleanup$$, '42501', null, 'clients cannot read the cleanup queue');

-- Trust and pausing --------------------------------------------------------------------------------
select pg_temp.as_user('moderator');
select throws_ok($$select public.set_creator_trusted((select marrow_creator from ids), true)$$, '42501', null, 'a moderator cannot mark a creator trusted');
select pg_temp.as_user('owner');
select lives_ok($$select public.set_creator_trusted((select ferro_creator from ids), true)$$, 'the owner marks a creator trusted');
select is((select trusted from public.creators where id = (select ferro_creator from ids)), true, 'the flag is set');
select is((select count(*)::int from public.audit_log where action = 'trust' and target_id = (select ferro_creator from ids) and at = now()), 1, 'and logged');
select pg_temp.as_user('marrow');
update public.creators set status = 'paused' where id = (select marrow_creator from ids);
select pg_temp.as_anon();
select is((select count(*)::int from public.creators where id = (select marrow_creator from ids)), 0, 'a paused page is hidden');
select is((select count(*)::int from public.listings where creator_id = (select marrow_creator from ids)), 0, 'and so are its listings');

select * from finish();
rollback;
