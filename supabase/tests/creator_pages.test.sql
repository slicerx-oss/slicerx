-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Creator pages and library rows (pgTAP): banners, the creator-media bucket,
-- the private Saved list, trending, new creators and picks based on likes.
-- Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(72);

-- Seed activity is dated; move it a year back so the windows below see only this test's rows.
update public.likes set created_at = created_at - interval '1 year';
update public.makes set created_at = created_at - interval '1 year';
update public.downloads set first_at = first_at - interval '1 year', last_at = last_at - interval '1 year';
update public.anon_downloads set day = day - 366;

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.profiles where handle = 'ferro') as ferro,
  (select id from public.profiles where handle = 'moderator') as moderator,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_live,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'marrow') and l.status = 'approved' order by l.slug limit 1) as marrow_live,
  (select id from public.listings where status = 'pending' order by slug limit 1) as some_pending,
  (select id from public.listings where status = 'archived' order by slug limit 1) as some_archived,
  '44444444-4444-4444-8444-444444444444'::uuid as rv_creator,
  '55555555-5555-4555-8555-555555555555'::uuid as rv_live;
grant select on ids to anon, authenticated, service_role;

create function pg_temp.as_user(p_handle text) returns void language plpgsql as $$
declare
  uid uuid;
begin
  reset role;
  select id into uid from public.profiles where handle = p_handle;
  if uid is null then raise exception 'no profile %', p_handle; end if;
  -- The issuer a local stack signs with; creator images must come from its creator-media bucket.
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'iss', 'http://127.0.0.1:54321/auth/v1')::text, true);
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

-- Banner --------------------------------------------------------------------------------------
select pg_temp.as_user('ferro');
select lives_ok($$update public.creators set banner_url = 'http://127.0.0.1:54321/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/banner-1a2b.webp' where owner_id = (select ferro from ids)$$, 'a creator sets a banner from their creator-media folder');
select throws_ok($$update public.creators set banner_url = 'javascript:alert(1)' where owner_id = (select ferro from ids)$$, '23514', null, 'a banner must be an https URL');
select pg_temp.as_user('ash');
update public.creators set banner_url = 'https://evil.example.com/x.png' where owner_id = (select ferro from ids);
select pg_temp.as_anon();
select is((select banner_url from public.creators where owner_id = (select ferro from ids)), 'http://127.0.0.1:54321/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/banner-1a2b.webp', 'anon reads the banner and nobody else changed it');

-- Images only from this project's creator-media -----------------------------------------------------
select pg_temp.as_user('ferro');
select throws_ok($$update public.creators set banner_url = 'https://cdn.example.com/ferro/banner.webp' where owner_id = (select ferro from ids)$$, '23514', 'upload the banner to your creator page first', 'an outside banner is refused');
select throws_ok($$update public.creators set logo_url = 'https://cdn.example.com/ferro/logo.png' where owner_id = (select ferro from ids)$$, '23514', 'upload the logo to your creator page first', 'so is an outside logo');
select throws_ok($$update public.creators set logo_url = 'http://127.0.0.1:54321/storage/v1/object/public/creator-media/' || (select ash from ids)::text || '/logo.png' where owner_id = (select ferro from ids)$$, '23514', null, 'and an image in someone else''s folder');
select throws_ok($$update public.creators set logo_url = 'http://127.0.0.1:9999/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/logo.png' where owner_id = (select ferro from ids)$$, '23514', null, 'and one from another server');
select throws_ok($$update public.creators set logo_url = 'http://127.0.0.1:54321/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/../x/logo.png' where owner_id = (select ferro from ids)$$, '23514', null, 'and a path that climbs out of the folder');
select lives_ok($$update public.creators set tagline = 'Still editable' where owner_id = (select ferro from ids)$$, 'a page with an older outside logo still saves its other fields');
select set_config('request.jwt.claims', json_build_object('sub', (select ferro from ids), 'role', 'authenticated', 'iss', 'https://abcdefgh.supabase.co/auth/v1')::text, true);
select lives_ok($$update public.creators set logo_url = 'https://abcdefgh.supabase.co/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/logo-9.png' where owner_id = (select ferro from ids)$$, 'a hosted project takes its own https creator-media URL');
select throws_ok($$update public.creators set logo_url = 'http://abcdefgh.supabase.co/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/logo-8.png' where owner_id = (select ferro from ids)$$, '23514', null, 'but not over http');
select set_config('request.jwt.claims', json_build_object('sub', (select ferro from ids), 'role', 'authenticated')::text, true);
select throws_ok($$update public.creators set logo_url = 'http://127.0.0.1:54321/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/logo-7.png' where owner_id = (select ferro from ids)$$, '23514', null, 'without an issuer no image is taken');
select pg_temp.as_user('ferro');
select throws_ok($$update public.creators set bio = repeat('b', 501) where owner_id = (select ferro from ids)$$, '23514', null, 'a bio is at most 500 characters');
select lives_ok($$update public.creators set bio = repeat('b', 500) where owner_id = (select ferro from ids)$$, '500 is fine');
reset role;
select lives_ok($$update public.creators set logo_url = 'https://cdn.example.com/any.png' where owner_id = (select ferro from ids)$$, 'the service role may set any https image');

-- Staff tags --------------------------------------------------------------------------------------
select pg_temp.as_user('ferro');
select throws_ok($$update public.creators set badges = array['N3D team'] where owner_id = (select ferro from ids)$$, '42501', null, 'a creator cannot set their own tags');
select throws_ok($$select public.set_creator_badges((select ferro_creator from ids), array['Builds SlicerX'])$$, '42501', null, 'nor through the function');
select pg_temp.as_user('owner');
select lives_ok($$select public.set_creator_badges((select ferro_creator from ids), array['Builds SlicerX', 'N3D team'])$$, 'the owner sets them');
select throws_ok($$select public.set_creator_badges((select ferro_creator from ids), array[''])$$, '22023', null, 'an empty tag is refused');
select pg_temp.as_anon();
select is((select badges from public.creators where id = (select ferro_creator from ids)), array['Builds SlicerX', 'N3D team'], 'anyone reads the tags');

-- Handle lock ----------------------------------------------------------------------------------------
reset role;
create temp table ferro_handle on commit drop as select handle from public.creators where owner_id = (select ferro from ids);
select pg_temp.as_user('ferro');
select throws_ok($$update public.creators set handle = 'ferro-two' where owner_id = (select ferro from ids)$$, '42501', null, 'a creator cannot change the handle after the first save');
select lives_ok($$update public.creators set display_name = 'Ferro Works', handle = handle where owner_id = (select ferro from ids)$$, 'other fields still save, with the same handle');
reset role;
insert into public.creators (owner_id, handle, display_name) values ((select moderator from ids), 'mod-page', 'Mod page');
select pg_temp.as_user('moderator');
select lives_ok($$update public.creators set handle = 'mod-page-two' where owner_id = (select moderator from ids)$$, 'staff may change a handle');
select is((select handle from public.creators where owner_id = (select moderator from ids)), 'mod-page-two', 'and it changed');
reset role;
select lives_ok($$update public.creators set handle = 'ferro-renamed' where owner_id = (select ferro from ids)$$, 'so may the service role');
select is((select handle from public.creators where owner_id = (select ferro from ids)), 'ferro-renamed', 'and that changed too');
update public.creators set handle = (select handle from ferro_handle) where owner_id = (select ferro from ids);

-- creator-media bucket ------------------------------------------------------------------------
reset role;
select is((select public from storage.buckets where id = 'creator-media'), true, 'creator-media is public to read');
select is((select file_size_limit from storage.buckets where id = 'creator-media'), 5242880::bigint, 'with a 5 MB limit');
select is((select allowed_mime_types from storage.buckets where id = 'creator-media'), array['image/png', 'image/jpeg', 'image/webp'], 'and only PNG, JPEG and WebP');
select pg_temp.as_user('ferro');
select is(public.can_write_creator_media((select ferro from ids)::text || '/banner-1a2b.webp'), true, 'a creator writes under their own id');
select is(public.can_write_creator_media((select ash from ids)::text || '/banner.webp'), false, 'not under someone else''s');
select is(public.can_write_creator_media((select ferro from ids)::text || '/logo.svg'), false, 'not an SVG');
select is(public.can_write_creator_media((select ferro from ids)::text || '/../x.png'), false, 'not a path that climbs out');
select pg_temp.as_user('ash');
select is(public.can_write_creator_media((select ash from ids)::text || '/banner.png'), false, 'a member without a creator page writes nothing');

-- Saved ---------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select public.set_saved((select ferro_live from ids), true)$$, '42501', null, 'saving needs a sign-in');
select pg_temp.as_user('ash');
select is(public.set_saved((select ferro_live from ids), true), true, 'a member saves a design');
select lives_ok($$select public.set_saved((select ferro_live from ids), true)$$, 'saving twice is fine');
select is((select count(*)::int from public.saved_listings()), 1, 'the design is saved once');
select is((select listing_id from public.saved_listings()), (select ferro_live from ids), 'and it is the one saved');
select throws_ok($$select public.set_saved((select some_pending from ids), true)$$, 'P0002', null, 'a design the member cannot see cannot be saved');
select throws_ok($$update public.collections set is_public = true where kind = 'saved'$$, '23514', null, 'the Saved list cannot be made public');
select pg_temp.as_user('rv');
select is((select count(*)::int from public.saved_listings()), 0, 'another member does not see it');
select is((select count(*)::int from public.collections where owner_id = (select ash from ids) and kind = 'saved'), 0, 'nor the Saved list itself');
select pg_temp.as_anon();
select is((select count(*)::int from public.collection_items i join public.collections c on c.id = i.collection_id where c.kind = 'saved'), 0, 'anon sees no saved items');
select pg_temp.as_user('ash');
select is(public.set_saved((select ferro_live from ids), false), false, 'a member unsaves a design');
select is((select count(*)::int from public.saved_listings()), 0, 'and it is gone');

-- Trending ------------------------------------------------------------------------------------
reset role;
insert into public.likes (user_id, listing_id) select rv, ferro_live from ids
  on conflict (user_id, listing_id) do update set created_at = now();
insert into public.likes (user_id, listing_id) select ash, ferro_live from ids
  on conflict (user_id, listing_id) do update set created_at = now();
insert into public.likes (user_id, listing_id, created_at) select moderator, marrow_live, now() - interval '20 days' from ids
  on conflict (user_id, listing_id) do update set created_at = excluded.created_at;
insert into public.downloads (user_id, listing_id) select rv, marrow_live from ids
  on conflict (user_id, listing_id) do update set last_at = now();
select pg_temp.as_anon();
select is((select listing_id from public.trending_listings(7, 10) limit 1), (select ferro_live from ids), 'two likes this week rank first');
select is((select score from public.trending_listings(7, 10) where listing_id = (select ferro_live from ids)), 6::bigint, 'a like counts 3');
select is((select score from public.trending_listings(7, 10) where listing_id = (select marrow_live from ids)), 1::bigint, 'a download this week counts 1, an older like nothing');
select is((select count(*)::int from public.trending_listings(7, 10)), 2, 'designs with nothing this week are left out');
select is((select count(*)::int from public.trending_listings(30, 10) where listing_id = (select marrow_live from ids) and score = 4), 1, 'a wider window counts the older like');

-- New creators --------------------------------------------------------------------------------
reset role;
insert into public.creators (id, owner_id, handle, display_name) select rv_creator, rv, 'rv-prints', 'RV Prints' from ids;
insert into public.listings (id, creator_id, slug, title, status, published_at) select rv_live, rv_creator, 'rv-first-print', 'First print', 'approved', now() - interval '2 days' from ids;
select pg_temp.as_anon();
select is((select count(*)::int from public.new_creators(30, 12) where creator_id = (select rv_creator from ids)), 1, 'a creator whose first design went live this month is new');
select is((select count(*)::int from public.new_creators(30, 12) where creator_id = (select ferro_creator from ids)), 0, 'a creator from months ago is not');
reset role;
update public.creators set status = 'paused' where id = (select rv_creator from ids);
select pg_temp.as_anon();
select is((select count(*)::int from public.new_creators(30, 12) where creator_id = (select rv_creator from ids)), 0, 'a paused creator is not shown');

-- Based on your likes ---------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select count(*)::int from public.recommended_listings(24)), 0, 'nothing for a signed-out visitor');
reset role;
delete from public.likes where user_id = (select moderator from ids);
select pg_temp.as_user('moderator');
select is((select count(*)::int from public.recommended_listings(24)), 0, 'nothing for a member without likes');
select pg_temp.as_user('ash');
select ok((select count(*) from public.recommended_listings(24)) > 0, 'a member with likes gets picks');
select is(
  (select count(*)::int from public.recommended_listings(24) r join public.likes k on k.listing_id = r.listing_id and k.user_id = (select ash from ids)),
  0, 'picks leave out what the member already liked');
select is(
  (select count(*)::int from public.recommended_listings(24) r join public.listings l on l.id = r.listing_id
   where not exists (
     select 1 from public.likes k join public.listings x on x.id = k.listing_id
     where k.user_id = (select ash from ids) and (x.creator_id = l.creator_id or x.tags && l.tags)
   )),
  0, 'every pick shares a tag or a creator with a like');
select is((select count(*)::int from public.recommended_listings(24) r join public.listings l on l.id = r.listing_id where l.status <> 'approved'), 0, 'picks are approved designs only');

-- Vault files leave only as .sx3mf ----------------------------------------------------------------
select is(public.is_sealed_path('a/b/model.sx3mf'), true, 'an .sx3mf path is sealed');
select is(public.is_sealed_path('a/b/model.3mf'), false, 'a 3MF path is not');
reset role;
create temp table raw on commit drop as
select ferro_live as listing, ferro_live::text || '/66666666-6666-4666-8666-666666666666/raw-original.3mf' as path,
  (select storage_path from public.listing_versions where listing_id = ferro_live and review_status = 'approved' and scan_status = 'clean' order by string_to_array(version, '.')::int[] desc limit 1) as sealed
from ids;
grant select on raw to anon, authenticated;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status, scanned_at, review_status)
select '66666666-6666-4666-8666-666666666666', listing, '9.9.9', path, repeat('f', 64), '3mf', 4096, 'clean', now(), 'approved' from raw;
select pg_temp.as_user('ash');
select is(public.request_download((select listing from raw)) ->> 'path', (select sealed from raw), 'a member is handed the newest .sx3mf, not a newer raw 3MF');
select is(public.can_download((select path from raw)), false, 'a member cannot read the raw 3MF from storage');
select is(public.can_download((select sealed from raw)), true, 'a member reads the .sx3mf');
reset role;
select is(public.is_public_file((select path from raw)), false, 'a visitor grant never covers a raw 3MF');
select is(public.is_public_file((select sealed from raw)), true, 'it covers the .sx3mf');
select pg_temp.as_user('ferro');
select is(public.request_download((select listing from raw)) ->> 'path', (select path from raw), 'the creator is handed their own newest file in any format');
select is(public.can_download((select path from raw)), true, 'and can read it from storage');

-- Cleanup -------------------------------------------------------------------------------------
reset role;
delete from public.creators where id = (select rv_creator from ids);
select is(
  (select count(*)::int from public.storage_cleanup where bucket = 'creator-media' and prefix = (select rv from ids)::text || '/' and done_at is null),
  1, 'a deleted creator page queues its images for removal');

-- Covers last: changing one sends the listing back to review.
select pg_temp.as_user('ferro');
select throws_ok($$update public.listings set cover_url = 'https://cdn.example.com/cover.png' where id = (select ferro_live from ids)$$, '23514', 'upload the cover to your creator page first', 'an outside cover is refused');
select lives_ok($$update public.listings set cover_url = 'http://127.0.0.1:54321/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/cover-1.jpg' where id = (select ferro_live from ids)$$, 'a cover from the creator''s folder is taken');

select * from finish();
rollback;
