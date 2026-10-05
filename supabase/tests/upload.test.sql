-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- The upload pipeline (pgTAP): version rows, the quarantine bucket, the scan
-- service functions, approval gating and download rules. Run with
-- `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(79);

create temp table ids on commit drop as
select
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'kestrel')) as kestrel_creator,
  (select id from public.listings where slug = 'anchor-cabinet-pull') as other_pending,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid as l1,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid as v1,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid as l2,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid as v2,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid as l3,
  'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid as v3,
  '99999999-9999-4999-8999-999999999999'::uuid as l4,
  '88888888-8888-4888-8888-888888888888'::uuid as v4;
grant select on ids to anon, authenticated, service_role;
create temp table claimed (id uuid) on commit drop;
grant all on claimed to service_role;

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



-- The client makes the listing and the version row ------------------------------------------------
select pg_temp.as_user('ferro');
insert into public.listings (id, creator_id, slug, title) select l1, ferro_creator, 'scan-test-piece', 'Scan test piece' from ids;
select lives_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status, review_status, scanned_at)
    select v1, l1, '1.0.0', l1::text || '/' || v1::text || '/piece.3mf', repeat('a', 64), '3mf', 4096, 'clean', 'approved', now() from ids$$,
  'a creator inserts a version row');
select is((select scan_status || '/' || review_status from public.listing_versions where id = (select v1 from ids)), 'uploading/pending', 'the client cannot pre-set scan or review status');
select throws_ok(
  $$insert into public.listing_versions (listing_id, version, storage_path, sha256, format, size_bytes)
    select l1, '1.0.1', 'wrong/path/piece.3mf', repeat('a', 64), '3mf', 10 from ids$$,
  '23514', null, 'the storage path must match <listing>/<version>/<file>');
select throws_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    select 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', l1, '1.0.2', l1::text || '/a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1/run.exe', repeat('a', 64), '3mf', 10 from ids$$,
  '23514', null, 'only 3mf, sx3mf and stl file names are accepted');
select throws_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    select 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2', l1, '1.0.3', l1::text || '/a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2/big.stl', repeat('a', 64), 'stl', 157286401 from ids$$,
  '23514', null, 'files over the size setting are refused');
select throws_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    select 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3', l1, '1.0.4', l1::text || '/a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3/x.stl', repeat('a', 64), 'obj', 10 from ids$$,
  '23514', null, 'the declared format must be allowed');
select throws_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    select 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', other_pending, '1.0.0', other_pending::text || '/a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4/x.stl', repeat('a', 64), 'stl', 10 from ids$$,
  '42501', null, 'a creator cannot add a version to someone else''s listing');
select throws_ok($$select public.submit_version((select v1 from ids))$$, 'P0001', 'upload the file to uploads-quarantine first', 'a version cannot be submitted before its file is uploaded');

-- Quarantine uploads -----------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l1::text || '/' || v1::text || '/piece.3mf', (select auth.uid()) from ids$$,
  'the creator uploads the file to quarantine');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l1::text || '/' || v1::text || '/other.3mf', (select auth.uid()) from ids$$,
  '42501', null, 'the object name must be the version''s path');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', other_pending::text || '/' || gen_random_uuid()::text || '/x.stl', (select auth.uid()) from ids$$,
  '42501', null, 'a creator cannot upload for someone else''s listing');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner) select 'listing-files', l1::text || '/' || v1::text || '/piece.3mf', (select auth.uid()) from ids$$,
  '42501', null, 'clients cannot write to the approved bucket');
select pg_temp.as_user('ash');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l1::text || '/' || v1::text || '/piece.3mf', (select auth.uid()) from ids$$,
  '42501', null, 'another member cannot upload to that path');
select is((select count(*)::int from storage.objects where bucket_id = 'uploads-quarantine'), 0, 'members cannot list quarantine');

-- Submitting -----------------------------------------------------------------------------------------------------
select throws_ok($$select public.submit_version((select v1 from ids))$$, 'P0002', null, 'another member cannot submit the version');
select pg_temp.as_user('ferro');
select lives_ok($$select public.submit_version((select v1 from ids))$$, 'the creator submits the version');
select is((select scan_status from public.listing_versions where id = (select v1 from ids)), 'queued', 'it is queued for the scan');
select throws_ok($$select public.submit_version((select v1 from ids))$$, 'P0001', 'this version was already submitted', 'a version is submitted once');
select throws_ok(
  $$update public.listing_versions set scan_status = 'clean' where id = (select v1 from ids)$$,
  '42501', null, 'a client cannot mark their own file clean');
select throws_ok(
  $$update public.listing_versions set review_status = 'approved' where id = (select v1 from ids)$$,
  '42501', null, 'or approved');
select lives_ok($$update public.listing_versions set changelog = 'First release' where id = (select v1 from ids)$$, 'the changelog stays editable');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l1::text || '/' || v1::text || '/piece.3mf', (select auth.uid()) from ids$$,
  '42501', null, 'nothing can be added to quarantine once the version is queued');
select throws_ok($$select * from public.claim_scan('worker-1')$$, '42501', null, 'a creator cannot claim scans');

-- The scan service ---------------------------------------------------------------------------------------------------
select pg_temp.as_service();
insert into claimed select id from public.claim_scan('worker-1');
select is((select id from claimed), (select v1 from ids), 'the service claims the queued version');
select is((select scan_status || '/' || scan_worker from public.listing_versions where id = (select v1 from ids)), 'scanning/worker-1', 'it is marked scanning');
select is((select count(*)::int from public.claim_scan('worker-2')), 0, 'no one else can claim it');
select is(public.requeue_stale_scans(interval '1 hour'), 0, 'a recent scan is not requeued');
select is(public.requeue_stale_scans(interval '-1 second'), 1, 'a stale scan goes back to the queue');
select is((select count(*)::int from public.claim_scan('worker-2')), 1, 'and can be claimed again');
select pg_temp.as_user('ferro');
select throws_ok(
  $$select public.finish_scan((select v1 from ids), true, '{}'::jsonb)$$,
  '42501', null, 'a creator cannot record a scan result');
select pg_temp.as_service();
select lives_ok(
  $$select public.finish_scan((select v1 from ids), true, '{"checks": ["type", "size", "archive", "malware", "mesh"], "engine": "test"}'::jsonb,
    repeat('d', 64), 4100,
    jsonb_build_array(
      jsonb_build_object('name', 'piece.3mf', 'role', 'model', 'format', '3mf', 'size_bytes', 4100, 'sha256', repeat('d', 64)),
      jsonb_build_object('name', 'thumbnail.png', 'role', 'image', 'size_bytes', 900, 'sha256', repeat('e', 64))))$$,
  'the service records a clean result');
select is((select scan_status || '/' || review_status || '/' || sha256 from public.listing_versions where id = (select v1 from ids)), 'clean/pending/' || repeat('d', 64), 'the version is clean and still waits for review, with the measured hash');
select is((select count(*)::int from public.listing_files where version_id = (select v1 from ids)), 2, 'the verified manifest is stored');
select throws_ok($$select public.finish_scan((select v1 from ids), true, '{}'::jsonb)$$, 'P0001', 'this version is not being scanned', 'a result is recorded once');
select throws_ok(
  $$update public.listing_versions set size_bytes = 1 where id = (select v1 from ids)$$,
  'P0001', 'a scanned version cannot change; publish a new version', 'a scanned version is frozen');
select is((select status from public.listings where id = (select l1 from ids)), 'pending', 'a clean scan does not publish under moderation mode owner-approves-all');

select pg_temp.as_user('ferro');
select ok(public.version_scan_report((select v1 from ids)) ->> 'engine' = 'test', 'the creator reads the scan report');
select pg_temp.as_user('ash');
select is(public.version_scan_report((select v1 from ids)), null, 'another member does not');
select is(public.can_download((select l1::text || '/' || v1::text || '/piece.3mf' from ids)), false, 'an unapproved file cannot be downloaded by members');
select pg_temp.as_user('ferro');
select is(public.can_download((select l1::text || '/' || v1::text || '/piece.3mf' from ids)), true, 'the creator can download their own file');
select pg_temp.as_user('owner');
select is(public.can_download((select l1::text || '/' || v1::text || '/piece.3mf' from ids)), true, 'staff can download it for review');
select lives_ok($$select public.approve_listing((select l1 from ids))$$, 'the owner approves the scanned upload');
select pg_temp.as_user('ash');
select is(public.can_download((select l1::text || '/' || v1::text || '/piece.3mf' from ids)), true, 'members can download it once approved');
select pg_temp.as_anon();
select is(public.can_download((select l1::text || '/' || v1::text || '/piece.3mf' from ids)), false, 'signed-out visitors cannot');
select is((select count(*)::int from public.listing_files where version_id = (select v1 from ids)), 2, 'anyone can read the file manifest of an approved version');

-- A failed scan --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ferro');
insert into public.listings (id, creator_id, slug, title) select l2, ferro_creator, 'bad-upload', 'Bad upload' from ids;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
  select v2, l2, '1.0.0', l2::text || '/' || v2::text || '/bad.stl', repeat('1', 64), 'stl', 100 from ids;
insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l2::text || '/' || v2::text || '/bad.stl', (select auth.uid()) from ids;
select public.submit_version((select v2 from ids));
select pg_temp.as_service();
select id from public.claim_scan('worker-1');
select lives_ok(
  $$select public.finish_scan((select v2 from ids), false, '{"reason": "archive contains an executable", "engine": "test"}'::jsonb)$$,
  'the service records a failed scan');
select is((select scan_status || '/' || review_status from public.listing_versions where id = (select v2 from ids)), 'rejected/rejected', 'the version is rejected');
select is((select status from public.listings where id = (select l2 from ids)), 'rejected', 'a pending listing with no usable file is rejected too');
select ok((select review_note from public.listings where id = (select l2 from ids)) like 'A file failed the upload checks%', 'the creator gets a note');
select is((select count(*)::int from public.audit_log where action = 'scan_reject' and target_id = (select v2 from ids) and reason = 'archive contains an executable'), 1, 'the failure is in the audit log');
select is((select count(*)::int from public.listing_files where version_id = (select v2 from ids)), 0, 'no file manifest is stored');

-- Trusted mode ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('owner');
select lives_ok($$select public.set_moderation_mode('trusted-creators')$$, 'the owner switches to trusted mode');
select lives_ok($$select public.set_creator_trusted((select ferro_creator from ids), true)$$, 'and trusts one creator');

select pg_temp.as_user('ferro');
insert into public.listings (id, creator_id, slug, title) select l3, ferro_creator, 'trusted-upload', 'Trusted upload' from ids;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
  select v3, l3, '1.0.0', l3::text || '/' || v3::text || '/ok.stl', repeat('2', 64), 'stl', 100 from ids;
insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l3::text || '/' || v3::text || '/ok.stl', (select auth.uid()) from ids;
select public.submit_version((select v3 from ids));

select pg_temp.as_user('kestrel');
insert into public.listings (id, creator_id, slug, title) select l4, kestrel_creator, 'untrusted-upload', 'Untrusted upload' from ids;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
  select v4, l4, '1.0.0', l4::text || '/' || v4::text || '/ok.stl', repeat('3', 64), 'stl', 100 from ids;
insert into storage.objects (bucket_id, name, owner) select 'uploads-quarantine', l4::text || '/' || v4::text || '/ok.stl', (select auth.uid()) from ids;
select public.submit_version((select v4 from ids));

select pg_temp.as_service();
select id from public.claim_scan('w');
select public.finish_scan((select v3 from ids), true, '{}'::jsonb, null, null, '[]'::jsonb);
select id from public.claim_scan('w');
select public.finish_scan((select v4 from ids), true, '{}'::jsonb, null, null, '[]'::jsonb);
select is((select status from public.listings where id = (select l3 from ids)), 'approved', 'a clean upload from a trusted creator is approved at once');
select is((select review_status from public.listing_versions where id = (select v3 from ids)), 'approved', 'with its version');
select is((select count(*)::int from public.audit_log where action = 'auto_approve' and target_id = (select l3 from ids) and actor_id is null), 1, 'the automatic approval is logged with no actor');
select is((select status from public.listings where id = (select l4 from ids)), 'pending', 'an upload from an untrusted creator still waits');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where id = (select l3 from ids)), 1, 'the auto-approved listing is public');

-- Scanner errors are retried ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kestrel');
insert into public.listings (id, creator_id, slug, title) values ('77777777-7777-4777-8777-777777777777', (select kestrel_creator from ids), 'retry-piece', 'Retry piece');
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
  values ('66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '1.0.0', '77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/r.stl', repeat('5', 64), 'stl', 100);
insert into storage.objects (bucket_id, name, owner) values ('uploads-quarantine', '77777777-7777-4777-8777-777777777777/66666666-6666-4666-8666-666666666666/r.stl', (select auth.uid()));
select public.submit_version('66666666-6666-4666-8666-666666666666');
select pg_temp.as_user('rv');
select throws_ok($$select public.retry_scan('66666666-6666-4666-8666-666666666666', 'boom')$$, '42501', null, 'members cannot report scanner errors');
select pg_temp.as_service();
select id from public.claim_scan('w');
select lives_ok($$select public.retry_scan('66666666-6666-4666-8666-666666666666', 'clamd timed out')$$, 'the service reports a scanner error');
select is((select scan_status || '/' || scan_attempts::text from public.listing_versions where id = '66666666-6666-4666-8666-666666666666'), 'queued/1', 'the version is queued again');
select id from public.claim_scan('w');
select public.retry_scan('66666666-6666-4666-8666-666666666666', 'clamd timed out');
select id from public.claim_scan('w');
select public.retry_scan('66666666-6666-4666-8666-666666666666', 'clamd timed out');
select is((select scan_status from public.listing_versions where id = '66666666-6666-4666-8666-666666666666'), 'rejected', 'the third error rejects the version');
select is((select scan_report ->> 'verdict' from public.listing_versions where id = '66666666-6666-4666-8666-666666666666'), 'error', 'and records that it was a scanner error');
select is((select status from public.listings where id = '77777777-7777-4777-8777-777777777777'), 'rejected', 'the listing is rejected with it');

-- Library settings ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select throws_ok($$select public.apply_library_settings('nonsense', 100, array['stl'])$$, '23514', null, 'an unknown mode is refused');
select lives_ok($$select public.apply_library_settings('owner-approves-all', 1, array['stl'])$$, 'the service applies edition settings');
select is((select file_size_limit from storage.buckets where id = 'uploads-quarantine'), 1048576::bigint, 'the bucket limit follows the setting');
select is((select max_file_mb from public.library_settings), 1, 'and the table');
select pg_temp.as_user('kestrel');
select throws_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    values ('12121212-1212-4121-8121-121212121212', '77777777-7777-4777-8777-777777777777', '1.0.1', '77777777-7777-4777-8777-777777777777/12121212-1212-4121-8121-121212121212/big.stl', repeat('6', 64), 'stl', 1048577)$$,
  '23514', 'files can be at most 1 MB', 'an upload over the size setting is refused');
select throws_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    values ('13131313-1313-4131-8131-131313131313', '77777777-7777-4777-8777-777777777777', '1.0.2', '77777777-7777-4777-8777-777777777777/13131313-1313-4131-8131-131313131313/x.3mf', repeat('6', 64), '3mf', 100)$$,
  '23514', 'this format is not accepted here', 'a format outside the allowed list is refused');
select lives_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    values ('14141414-1414-4141-8141-141414141414', '77777777-7777-4777-8777-777777777777', '1.0.3', '77777777-7777-4777-8777-777777777777/14141414-1414-4141-8141-141414141414/ok.stl', repeat('6', 64), 'stl', 1048576)$$,
  'an allowed upload at the limit is accepted');
select pg_temp.as_service();
select public.apply_library_settings('auto-after-scan', 100, array['3mf', 'sx3mf', 'stl']);

-- auto-after-scan publishes any clean upload ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('rv');
insert into public.creators (owner_id, handle, display_name) select (select auth.uid()), 'auto-rv', 'Auto rv';
insert into public.listings (id, creator_id, slug, title) values ('15151515-1515-4151-8151-151515151515', (select id from public.creators where handle = 'auto-rv'), 'auto-piece', 'Auto piece');
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
  values ('16161616-1616-4161-8161-161616161616', '15151515-1515-4151-8151-151515151515', '1.0.0', '15151515-1515-4151-8151-151515151515/16161616-1616-4161-8161-161616161616/a.stl', repeat('7', 64), 'stl', 100);
insert into storage.objects (bucket_id, name, owner) values ('uploads-quarantine', '15151515-1515-4151-8151-151515151515/16161616-1616-4161-8161-161616161616/a.stl', (select auth.uid()));
select public.submit_version('16161616-1616-4161-8161-161616161616');
select pg_temp.as_service();
select id from public.claim_scan('w');
select public.finish_scan('16161616-1616-4161-8161-161616161616', true, '{"verdict": "clean"}'::jsonb, null, null, '[]'::jsonb);
select is((select status from public.listings where id = '15151515-1515-4151-8151-151515151515'), 'approved', 'in auto-after-scan a clean upload from any member is approved at once');
select pg_temp.as_user('moderator');
select lives_ok($$select public.remove_listing('15151515-1515-4151-8151-151515151515', 'Removed after review.')$$, 'staff can remove it afterwards');

-- Converted files and previews -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select public.apply_library_settings('owner-approves-all', 100, array['3mf', 'sx3mf', 'stl']);
select pg_temp.as_user('ferro');
insert into public.listings (id, creator_id, slug, title) select 'abababab-abab-4bab-8bab-abababababab', ferro_creator, 'converted-piece', 'Converted piece' from ids;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
  values ('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', 'abababab-abab-4bab-8bab-abababababab', '1.0.0', 'abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/c.stl', repeat('8', 64), 'stl', 100);
insert into storage.objects (bucket_id, name, owner) values ('uploads-quarantine', 'abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/c.stl', (select auth.uid()));
select public.submit_version('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc');
select pg_temp.as_service();
select id from public.claim_scan('w');
select throws_ok(
  $$select public.finish_scan('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', true, '{}'::jsonb, null, null, '[]'::jsonb, 'abababab-abab-4bab-8bab-abababababab/other-version/c.sx3mf', 'sx3mf')$$,
  'P0001', null, 'a converted file must stay under the version''s own prefix');
select lives_ok(
  $$select public.finish_scan('bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc', true, '{}'::jsonb, repeat('9', 64), 90, 
    jsonb_build_array(jsonb_build_object('name', 'preview.png', 'role', 'image', 'size_bytes', 10, 'sha256', repeat('a', 64))),
    'abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/c.sx3mf', 'sx3mf')$$,
  'the scan stores a converted file under a new name and format');
select is((select format || ' ' || storage_path from public.listing_versions where id = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc'), 'sx3mf abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/c.sx3mf', 'the row follows');
select pg_temp.as_user('ash');
select is(public.can_download('abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/preview.png'), false, 'a preview is private until the listing is approved');
select pg_temp.as_user('owner');
select public.approve_listing('abababab-abab-4bab-8bab-abababababab');
select pg_temp.as_user('ash');
select is(public.can_download('abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/preview.png'), true, 'members load the preview once approved');
select is(public.can_download('abababab-abab-4bab-8bab-abababababab/bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc/other.png'), false, 'but not arbitrary names');

select * from finish();
rollback;
