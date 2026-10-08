-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Animated banners (pgTAP): creator-media takes a GIF only as a banner, in the
-- creator's own folder, and only banner_url may point at one. Logos and covers
-- stay still images. Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.profiles where handle = 'ferro') as ferro,
  (select id from public.profiles where handle = 'marrow') as marrow,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_live,
  'http://127.0.0.1:54321/storage/v1/object/public/creator-media/'::text as media;
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

-- The bucket -----------------------------------------------------------------------------------
select ok((select 'image/gif' = any(allowed_mime_types) from storage.buckets where id = 'creator-media'), 'creator-media takes GIF');
select is((select file_size_limit from storage.buckets where id = 'creator-media'), 5242880::bigint, 'and keeps the 5 MB limit');

-- Writing a GIF --------------------------------------------------------------------------------
select pg_temp.as_user('ferro');
select is(public.can_write_creator_media((select ferro from ids)::text || '/banner-1a2b3c.gif'), true, 'a creator writes a banner GIF in their own folder');
select is(public.can_write_creator_media((select ferro from ids)::text || '/logo-1a2b3c.gif'), false, 'but not a logo GIF');
select is(public.can_write_creator_media((select ferro from ids)::text || '/cover-1a2b3c.gif'), false, 'nor a cover GIF');
select is(public.can_write_creator_media((select ash from ids)::text || '/banner-1a2b3c.gif'), false, 'nor a banner GIF in someone else''s folder');
select is(public.can_write_creator_media((select ferro from ids)::text || '/banner-../../x.gif'), false, 'nor a path that climbs out');
select is(public.can_write_creator_media((select ferro from ids)::text || '/banner-1a2b3c.png'), true, 'still images still go in');
select pg_temp.as_user('ash');
select is(public.can_write_creator_media((select ash from ids)::text || '/banner-1a2b3c.gif'), false, 'a member without a creator page writes no GIF');
select pg_temp.as_user('ferro');
select is(public.can_write_creator_media((select ferro from ids)::text || '/banner-1a2b3c.GIF'), false, 'and names stay lower case, as the app writes them');

-- Pointing at a GIF ----------------------------------------------------------------------------
select pg_temp.as_user('ferro');
select lives_ok($$update public.creators set banner_url = (select media from ids) || (select ferro from ids)::text || '/banner-1a2b3c.gif' where owner_id = (select ferro from ids)$$, 'a creator sets a GIF banner from their folder');
select is((select banner_url from public.creators where owner_id = (select ferro from ids)), (select media from ids) || (select ferro from ids)::text || '/banner-1a2b3c.gif', 'and it is stored as is');
select throws_ok($$update public.creators set banner_url = (select media from ids) || (select ferro from ids)::text || '/logo-1a2b3c.gif' where owner_id = (select ferro from ids)$$, '23514', 'upload the banner to your creator page first', 'a GIF not uploaded as a banner is refused');
select throws_ok($$update public.creators set banner_url = (select media from ids) || (select marrow from ids)::text || '/banner-1a2b3c.gif' where owner_id = (select ferro from ids)$$, '23514', 'upload the banner to your creator page first', 'and one in another creator''s folder');
select throws_ok($$update public.creators set banner_url = 'https://cdn.example.com/banner-1.gif' where owner_id = (select ferro from ids)$$, '23514', 'upload the banner to your creator page first', 'and an outside GIF');
select throws_ok($$update public.creators set logo_url = (select media from ids) || (select ferro from ids)::text || '/banner-1a2b3c.gif' where owner_id = (select ferro from ids)$$, '23514', 'upload the logo to your creator page first', 'a logo stays a still image, even a banner GIF');
select throws_ok($$update public.listings set cover_url = (select media from ids) || (select ferro from ids)::text || '/banner-1a2b3c.gif' where id = (select ferro_live from ids)$$, '23514', 'upload the cover to your creator page first', 'and so does a cover');
select lives_ok($$update public.creators set banner_url = (select media from ids) || (select ferro from ids)::text || '/banner-9f.webp' where owner_id = (select ferro from ids)$$, 'a still banner is still taken');

-- Trusted callers ------------------------------------------------------------------------------
reset role;
select lives_ok($$update public.creators set banner_url = 'https://abcdefgh.supabase.co/storage/v1/object/public/creator-media/' || (select ferro from ids)::text || '/banner-seed.gif' where owner_id = (select ferro from ids)$$, 'SQL and the service role are trusted, as the seed script needs');
select is(public.is_creator_banner_url('https://abcdefgh.supabase.co/storage/v1/object/public/creator-media/x/banner.gif', (select ferro from ids)), false, 'a GIF on another project is no banner here');

select * from finish();
rollback;
