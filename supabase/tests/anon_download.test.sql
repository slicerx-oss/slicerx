-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Downloads without signing in (pgTAP): visitors read approved listings and
-- their files only, through short-lived grants, under a per-IP limit. Run
-- with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(62);

create temp table ids on commit drop as
select
  (select id from public.listings where slug = 'articulated-fossil-fish') as fish,
  (select id from public.listings where slug = 'wave-dish') as dish,
  (select id from public.listings where slug = 'anchor-cabinet-pull') as pending,
  (select id from public.listings where slug = 'wizard-tower-terrain') as rejected,
  (select id from public.listings where slug = 'gear-tooth-test-strip') as archived,
  (select id from public.listings where slug = 'logo-keychain') as removed;
create temp table paths on commit drop as
select
  (select storage_path from public.listing_versions where listing_id = fish and version = '1.1.0') as fish_new,
  (select storage_path from public.listing_versions where listing_id = fish and version = '1.0.0') as fish_old,
  (select v.listing_id::text || '/' || v.id::text || '/' || f.name from public.listing_files f
     join public.listing_versions v on v.id = f.version_id where v.listing_id = fish and v.version = '1.1.0' and f.role = 'image' limit 1) as fish_image,
  (select storage_path from public.listing_versions where listing_id = pending limit 1) as pending_file,
  (select storage_path from public.listing_versions where listing_id = dish) as dish_file,
  dish::text || '/77777777-0000-4000-8000-000000000001/wave-dish-9.0.0.3mf' as dish_waiting
from ids;
create temp table got (k text primary key, v jsonb) on commit drop;
grant select on ids, paths to anon, authenticated;
grant all on got to anon, authenticated;

-- A new version waiting for review on an approved listing, and storage rows
-- for every file the tests read (the bucket is empty after a reset).
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status, scanned_at, review_status)
select '77777777-0000-4000-8000-000000000001', dish, '9.0.0', (select dish_waiting from paths), repeat('a', 64), '3mf', 10, 'clean', now(), 'pending' from ids;
insert into storage.objects (bucket_id, name)
select 'listing-files', p from paths, unnest(array[fish_new, fish_old, fish_image, pending_file, dish_file, dish_waiting]) p;
insert into storage.objects (bucket_id, name) select 'uploads-quarantine', fish_new from paths;

create function pg_temp.as_visitor(p_xff text, p_grant text default null, p_op text default 'storage.object.get_authenticated') returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.headers', jsonb_strip_nulls(jsonb_build_object('x-forwarded-for', p_xff, 'x-sx-download-grant', p_grant))::text, true);
  perform set_config('request.path', '', true);
  perform set_config('storage.operation', p_op, true);
  set local role anon;
end;
$$;

-- The grant in the object URL's query instead of the header, as storage passes the URL to policies.
create function pg_temp.as_visitor_url(p_path text, p_grant text, p_op text default 'storage.object.get_authenticated') returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.1"}', true);
  perform set_config('request.path', '/object/authenticated/listing-files/' || p_path || '?sx_grant=' || coalesce(p_grant, ''), true);
  perform set_config('storage.operation', p_op, true);
  set local role anon;
end;
$$;

create function pg_temp.as_user(p_handle text) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where handle = p_handle), 'role', 'authenticated')::text, true);
  perform set_config('request.headers', '{}', true);
  set local role authenticated;
end;
$$;

create function pg_temp.visible(p_path text) returns integer language sql as $$
  select count(*)::int from storage.objects where bucket_id = 'listing-files' and name = p_path;
$$;

-- Listings ---------------------------------------------------------------------
select pg_temp.as_visitor('198.51.100.1');
select is((select count(*)::int from public.listings where status <> 'approved'), 0, 'visitors see approved listings only');
select ok((select count(*) from public.listings) > 0, 'visitors see the approved listings');
select is((select count(*)::int from public.listing_versions where listing_id in (select pending from ids union all select rejected from ids union all select archived from ids union all select removed from ids)), 0,
  'visitors see no versions of pending, rejected, archived or removed listings');
select is((select count(*)::int from public.listing_versions where review_status <> 'approved'), 0, 'visitors see no version waiting for review');

-- Private tables and helpers ------------------------------------------------------
select throws_ok('select * from public.download_grants', '42501', null, 'visitors cannot read grants');
select throws_ok('select * from public.anon_download_usage', '42501', null, 'visitors cannot read IP usage');
select throws_ok('select * from public.download_secret', '42501', null, 'visitors cannot read the salt');
select throws_ok('select * from public.anon_downloads', '42501', null, 'visitors cannot read raw anonymous counts');
select throws_ok('select public.client_ip_hash()', '42501', null, 'visitors cannot call the IP hash');
select throws_ok($$select public.public_download_path((select fish from ids))$$, '42501', null, 'visitors cannot call internal helpers');
select throws_ok($$select public.set_anon_downloads(true, 1, 1)$$, '42501', null, 'visitors cannot change limits');

-- Grants only for public files -----------------------------------------------------
select throws_ok($$select public.request_download((select pending from ids))$$, 'P0002', 'no such listing', 'no grant for a pending listing');
select throws_ok($$select public.request_download((select rejected from ids))$$, 'P0002', 'no such listing', 'no grant for a rejected listing');
select throws_ok($$select public.request_download((select archived from ids))$$, 'P0002', 'no such listing', 'no grant for an archived listing');
select throws_ok($$select public.request_download((select removed from ids))$$, 'P0002', 'no such listing', 'no grant for a removed listing');
select throws_ok($$select public.request_download(gen_random_uuid())$$, 'P0002', 'no such listing', 'no grant for an unknown listing');

insert into got values ('fish', public.request_download((select fish from ids)));
select is((select v ->> 'path' from got where k = 'fish'), (select fish_new from paths), 'the grant is for the newest approved version');
select is((select v ->> 'version' from got where k = 'fish'), '1.1.0', 'the version is returned');
select ok((select v ->> 'grant' from got where k = 'fish') ~ '^sxg_[0-9a-f]{48}$', 'the grant is a random token');
select ok((select (v ->> 'expires_at')::timestamptz from got where k = 'fish') between now() + interval '10 seconds' and now() + interval '15 minutes', 'the grant expires within minutes');
insert into got values ('dish', public.request_download((select dish from ids)));
select is((select v ->> 'path' from got where k = 'dish'), (select dish_file from paths), 'a version waiting for review is never handed out');

-- Storage reads ------------------------------------------------------------------
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'));
select is(pg_temp.visible((select fish_new from paths)), 1, 'a visitor with a grant reads the file');
select is(pg_temp.visible((select fish_old from paths)), 0, 'the grant opens no other file, even of the same listing');
select is(pg_temp.visible((select dish_file from paths)), 0, 'the grant opens no other listing');
select is((select count(*)::int from storage.objects where bucket_id = 'uploads-quarantine'), 0, 'visitors never see quarantine');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), 'storage.object.sign');
select is(pg_temp.visible((select fish_new from paths)), 0, 'a grant cannot sign a long-lived URL');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), '');
select is(pg_temp.visible((select fish_new from paths)), 0, 'an unknown storage operation is refused');
select pg_temp.as_visitor('198.51.100.1');
select is(pg_temp.visible((select fish_new from paths)), 0, 'no grant, no file');
select pg_temp.as_visitor('198.51.100.1', 'sxg_' || repeat('0', 48));
select is(pg_temp.visible((select fish_new from paths)), 0, 'a made-up grant is refused');
select is(pg_temp.visible((select fish_image from paths)), 1, 'preview images of public versions need no grant');
select is(pg_temp.visible((select dish_waiting from paths)), 0, 'files waiting for review stay private');

-- The same grant in the URL's query (where the hosted project's storage sees it).
select pg_temp.as_visitor_url((select fish_new from paths), (select v ->> 'grant' from got where k = 'fish'));
select is(pg_temp.visible((select fish_new from paths)), 1, 'a grant in the URL reads the file');
select is(pg_temp.visible((select fish_old from paths)), 0, 'a grant in the URL opens no other file');
select pg_temp.as_visitor_url((select fish_new from paths), (select v ->> 'grant' from got where k = 'fish'), 'storage.object.sign');
select is(pg_temp.visible((select fish_new from paths)), 0, 'a grant in the URL cannot sign a long-lived URL');
select pg_temp.as_visitor_url((select fish_new from paths), 'sxg_' || repeat('0', 48));
select is(pg_temp.visible((select fish_new from paths)), 0, 'a made-up grant in the URL is refused');
select pg_temp.as_visitor_url((select fish_new from paths), (select v ->> 'grant' from got where k = 'fish') || 'x');
select is(pg_temp.visible((select fish_new from paths)), 0, 'a grant with extra characters is refused');
select pg_temp.as_visitor_url((select fish_new from paths), upper((select v ->> 'grant' from got where k = 'fish')));
select is(pg_temp.visible((select fish_new from paths)), 0, 'only the exact token shape is read from the URL');

-- The hosted storage service names the direct read without the 'storage.' prefix.
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), 'object.get_authenticated_info');
select is(pg_temp.visible((select fish_new from paths)), 1, 'a grant reads the file under the hosted name of the read');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), 'object.head_authenticated_info');
select is(pg_temp.visible((select fish_new from paths)), 1, 'a grant answers an info lookup under its hosted name');
select pg_temp.as_visitor_url((select fish_new from paths), (select v ->> 'grant' from got where k = 'fish'), 'object.get_authenticated_info');
select is(pg_temp.visible((select fish_new from paths)), 1, 'a grant in the URL reads the file under the hosted name');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), 'storage.object.sign_many');
select is(pg_temp.visible((select fish_new from paths)), 0, 'a grant cannot sign many URLs');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), 'object.sign');
select is(pg_temp.visible((select fish_new from paths)), 0, 'a grant cannot sign under a legacy name either');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'), 'storage.object.list');
select is(pg_temp.visible((select fish_new from paths)), 0, 'a grant cannot list the bucket');
select pg_temp.as_visitor('198.51.100.1', null, 'object.get_authenticated_info');
select is(pg_temp.visible((select fish_new from paths)), 0, 'the hosted read name without a grant opens nothing');

-- A grant row for a private file (as if issued before a takedown) opens nothing.
reset role;
insert into public.download_grants (token_hash, storage_path, listing_id, expires_at)
select encode(extensions.digest('sxg_forged', 'sha256'), 'hex'), pending_file, (select pending from ids), now() + interval '1 minute' from paths;
select pg_temp.as_visitor('198.51.100.1', 'sxg_forged');
select is(pg_temp.visible((select pending_file from paths)), 0, 'a grant never opens a pending file');

reset role;
update public.download_grants set expires_at = now() - interval '1 second'
where token_hash = encode(extensions.digest((select v ->> 'grant' from got where k = 'fish'), 'sha256'), 'hex');
select pg_temp.as_visitor('198.51.100.1', (select v ->> 'grant' from got where k = 'fish'));
select is(pg_temp.visible((select fish_new from paths)), 0, 'an expired grant is refused');

-- Rate limit ----------------------------------------------------------------------
reset role;
update public.library_settings set anon_per_hour = 3, anon_per_day = 5;
select pg_temp.as_visitor('203.0.113.9');
select lives_ok($$select public.request_download((select fish from ids)); select public.request_download((select fish from ids)); select public.request_download((select dish from ids))$$,
  'three downloads an hour pass');
select throws_ok($$select public.request_download((select fish from ids))$$, 'P0001', 'too many downloads from this network; try again later or sign in', 'the fourth is refused');
select pg_temp.as_visitor('1.2.3.4, 203.0.113.9');
select throws_ok($$select public.request_download((select fish from ids))$$, 'P0001', null, 'a client-set first hop does not escape the limit');
select pg_temp.as_visitor('203.0.113.10');
select lives_ok($$select public.request_download((select fish from ids))$$, 'another address has its own limit');

reset role;
insert into public.anon_download_usage (ip_hash, hour)
select ip_hash, date_trunc('hour', now()) - interval '1 hour' from public.anon_download_usage where count = 1 limit 1;
update public.anon_download_usage set count = 4 where hour = date_trunc('hour', now()) - interval '1 hour';
select pg_temp.as_visitor('203.0.113.10');
select throws_ok($$select public.request_download((select fish from ids))$$, 'P0001', null, 'the daily limit counts earlier hours');

reset role;
select is((select count(*)::int from public.anon_download_usage where ip_hash !~ '^[0-9a-f]{64}$' or ip_hash like '%203.0.113%'), 0, 'no address is stored, only hashes');

-- Counts ----------------------------------------------------------------------------
select ok((select count from public.anon_downloads where listing_id = (select fish from ids) and day = current_date) >= 3, 'anonymous downloads are counted per listing and day');
create temp table expected on commit drop as
select (select coalesce(sum(count), 0) from public.downloads where listing_id = i.fish) + (select coalesce(sum(count), 0) from public.anon_downloads where listing_id = i.fish) as n from ids i;
grant select on expected to anon, authenticated;
select pg_temp.as_visitor('198.51.100.1');
select is((select downloads from public.listing_stats(array[(select fish from ids)])), (select n from expected), 'listing cards include anonymous downloads');
select pg_temp.as_user('marrow');
select is((select downloads from public.creator_dashboard() where listing_id = (select fish from ids)), (select n from expected), 'the creator dashboard includes anonymous downloads');

-- Members ---------------------------------------------------------------------------
select pg_temp.as_user('eli');
insert into got values ('eli', public.request_download((select fish from ids)));
select ok((select v -> 'grant' = 'null'::jsonb from got where k = 'eli'), 'members get no grant and read with their session');
select is((select count from public.downloads where listing_id = (select fish from ids) and user_id = (select auth.uid())) >= 1, true, 'member downloads are counted as before');
select pg_temp.as_user('zed');
select throws_ok($$select public.request_download((select fish from ids))$$, '42501', null, 'banned members cannot download');

-- Owner switch -------------------------------------------------------------------
select pg_temp.as_user('eli');
select throws_ok($$select public.set_anon_downloads(false, 1, 1)$$, '42501', null, 'members cannot change limits');
select pg_temp.as_user('owner');
select lives_ok($$select public.set_anon_downloads(false, 20, 60)$$, 'the owner turns anonymous downloads off');
select pg_temp.as_visitor('198.51.100.77');
select throws_ok($$select public.request_download((select fish from ids))$$, '42501', 'sign in to download', 'with downloads off, visitors are asked to sign in');
select is(pg_temp.visible((select fish_image from paths)), 0, 'with downloads off, files stay closed to visitors');

select * from finish();
rollback;
