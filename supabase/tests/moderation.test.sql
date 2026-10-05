-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Upload moderation (pgTAP): listings start pending, staff approve or reject
-- through functions that write the audit log, edits return to review, and
-- only the owner approves in the default mode. Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(87);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'owner') as owner,
  (select id from public.profiles where handle = 'moderator') as moderator,
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.listings where slug = 'trilobite-coaster-set') as p1,
  (select id from public.listings where slug = 'anchor-cabinet-pull') as p2,
  (select id from public.listings where slug = 'chain-link-cable-guide') as p3,
  (select id from public.listings where slug = 'wizard-tower-terrain') as rejected,
  (select id from public.listings where slug = 'gear-tooth-test-strip') as archived,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as live,
  (select l.slug from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as live_slug,
  (select c.id from public.creators c where c.owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select id from public.comments where deleted_at is null limit 1) as any_comment;
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

-- Uploads start pending ----------------------------------------------------------------
select pg_temp.as_user('ferro');
select lives_ok(
  $$insert into public.listings (creator_id, slug, title, status, published_at, reviewed_by, review_note)
    select ferro_creator, 'fresh-upload', 'Fresh upload', 'approved', now(), owner, 'self approved' from ids$$,
  'a creator can insert a listing');
select is((select status from public.listings where slug = 'fresh-upload'), 'pending', 'it starts pending whatever the client asks for');
select is((select reviewed_by is null and review_note is null and published_at is null from public.listings where slug = 'fresh-upload'), true, 'and the review fields are cleared');
select is((select count(*)::int from public.listings where slug = 'fresh-upload'), 1, 'the uploader sees it');

select pg_temp.as_anon();
select is((select count(*)::int from public.listings where slug = 'fresh-upload'), 0, 'anon cannot see a pending upload');
select pg_temp.as_user('rv');
select is((select count(*)::int from public.listings where slug = 'fresh-upload'), 0, 'another member cannot see it');
select pg_temp.as_user('moderator');
select is((select count(*)::int from public.listings where slug = 'fresh-upload'), 1, 'staff see it');

-- The uploader cannot approve their own work ------------------------------------------------
select pg_temp.as_user('ferro');
select throws_ok($$update public.listings set status = 'approved' where slug = 'fresh-upload'$$, '42501', null, 'a creator cannot approve their own listing');
select throws_ok($$update public.listings set review_note = 'looks great' where slug = 'fresh-upload'$$, '42501', 'review fields are set by moderation', 'a creator cannot write the review note');
select throws_ok($$update public.listings set published_at = now() where slug = 'fresh-upload'$$, '42501', null, 'a creator cannot set published_at');
select throws_ok(
  $$update public.listings set creator_id = (select id from public.creators where owner_id = (select id from public.profiles where handle = 'marrow')) where slug = 'fresh-upload'$$,
  'P0001', null, 'a listing cannot move to another creator');
select lives_ok($$update public.listings set title = 'Fresh upload v2' where slug = 'fresh-upload'$$, 'a creator edits a pending listing');

-- The queue ------------------------------------------------------------------------------
select is((select count(*)::int from public.moderation_queue), 0, 'a creator reads no queue');
select pg_temp.as_user('moderator');
select ok((select count(*) from public.moderation_queue where status = 'pending') >= 4, 'staff read the queue');
select is((select count(*)::int from public.moderation_queue where listing_id = (select rejected from ids)), 0, 'a rejected listing is not in the queue');
select is((select ready from public.moderation_queue where listing_id = (select p1 from ids)), true, 'a listing whose files passed the scan is ready');
select is((select ready from public.moderation_queue where slug = 'fresh-upload'), false, 'a listing without a scanned file is not ready');

-- Mode owner: only the owner approves --------------------------------------------------------
select throws_ok($$select public.approve_listing((select p1 from ids))$$, '42501', null, 'a moderator cannot approve while the mode is owner-approves-all');
select throws_ok($$select public.reject_listing((select p1 from ids), 'nope')$$, '42501', null, 'a moderator cannot reject while the mode is owner-approves-all');
select throws_ok($$select public.set_moderation_mode('moderators')$$, '42501', 'only the owner can change the moderation mode', 'a moderator cannot change the mode');

select pg_temp.as_user('owner');
select throws_ok($$select public.approve_listing((select id from public.listings where slug = 'fresh-upload'))$$, 'P0001', 'nothing is waiting for review', 'a listing with no version cannot be approved');
select lives_ok($$select public.approve_listing((select p1 from ids), 'Looks good')$$, 'the owner approves a listing');
select is((select status from public.listings where id = (select p1 from ids)), 'approved', 'the listing is approved');
select is((select reviewed_by = (select owner from ids) and reviewed_at is not null and published_at is not null from public.listings where id = (select p1 from ids)), true, 'the reviewer and dates are recorded');
select is((select count(*)::int from public.listing_versions where listing_id = (select p1 from ids) and review_status <> 'approved'), 0, 'its versions are approved');
select is((select count(*)::int from public.audit_log where action = 'approve' and target_id = (select p1 from ids) and actor_id = (select owner from ids) and reason = 'Looks good'), 1, 'the approval is in the audit log');
select throws_ok($$select public.approve_listing((select p1 from ids))$$, 'P0001', 'nothing is waiting for review', 'a listing cannot be approved twice');
select is((select count(*)::int from public.moderation_queue where listing_id = (select p1 from ids)), 0, 'it leaves the queue');

select pg_temp.as_anon();
select is((select count(*)::int from public.listings where id = (select p1 from ids)), 1, 'anon now sees it');
select ok((select count(*) from public.listing_versions where listing_id = (select p1 from ids)) >= 1, 'and its versions');

-- Rejecting ---------------------------------------------------------------------------------
select pg_temp.as_user('owner');
select throws_ok($$select public.reject_listing((select p2 from ids), '')$$, '23514', 'give the creator a reason', 'a rejection needs a reason');
select throws_ok($$select public.reject_listing((select p2 from ids), '  ')$$, '23514', null, 'a blank reason does not count');
select lives_ok($$select public.reject_listing((select p2 from ids), 'The file is a duplicate of an existing model.')$$, 'the owner rejects with a reason');
select is((select status from public.listings where id = (select p2 from ids)), 'rejected', 'the listing is rejected');
select is((select review_note from public.listings where id = (select p2 from ids)), 'The file is a duplicate of an existing model.', 'the note is stored');
select is((select count(*)::int from public.listing_versions where listing_id = (select p2 from ids) and review_status = 'rejected'), 1, 'its version is rejected');
select is((select count(*)::int from public.audit_log where action = 'reject' and target_id = (select p2 from ids) and reason like 'The file is a duplicate%'), 1, 'the rejection and reason are in the audit log');
select throws_ok($$select public.reject_listing((select p2 from ids), 'again please')$$, 'P0001', null, 'a rejected listing cannot be rejected again');

select pg_temp.as_uploader('anchor-cabinet-pull');
select is((select review_note from public.listings where slug = 'anchor-cabinet-pull'), 'The file is a duplicate of an existing model.', 'the uploader reads the reason');
select lives_ok($$update public.listings set status = 'pending' where slug = 'anchor-cabinet-pull'$$, 'the uploader resubmits a rejected listing');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where id = (select p2 from ids)), 0, 'a rejected listing is not public');

-- Approved listings: edits go back to review, archive, takedown -----------------------------------
select pg_temp.as_uploader((select live_slug from ids));
select lives_ok($$update public.listings set status = 'archived' where id = (select live from ids)$$, 'a creator archives their listing');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where id = (select live from ids)), 0, 'an archived listing is hidden');
select pg_temp.as_uploader((select live_slug from ids));
select lives_ok($$update public.listings set status = 'approved' where id = (select live from ids)$$, 'and restored without changes');
select is((select status from public.listings where id = (select live from ids)), 'approved', 'it is public again');
select lives_ok($$update public.listings set description = 'Now with a different description.' where id = (select live from ids)$$, 'a creator edits an approved listing');
select is((select status from public.listings where id = (select live from ids)), 'pending', 'the edit sends it back to review');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where id = (select live from ids)), 0, 'and hides it until it is approved again');
select pg_temp.as_uploader((select live_slug from ids));
select throws_ok($$update public.listings set status = 'removed' where id = (select live from ids)$$, '42501', null, 'a creator cannot mark a listing removed');

select pg_temp.as_user('owner');
select lives_ok($$select public.approve_listing((select live from ids))$$, 'a listing with only content edits can be approved again');
select is((select status from public.listings where id = (select live from ids)), 'approved', 'approved once more');
select throws_ok($$select public.remove_listing((select live from ids), '')$$, '23514', null, 'a takedown needs a reason');
select lives_ok($$select public.remove_listing((select live from ids), 'Contains a trademarked logo.')$$, 'the owner takes a listing down');
select is((select status from public.listings where id = (select live from ids)), 'removed', 'it is removed');
select pg_temp.as_anon();
select is((select count(*)::int from public.listings where id = (select live from ids)), 0, 'a removed listing is hidden');
select pg_temp.as_uploader((select live_slug from ids));
select is((select review_note from public.listings where id = (select live from ids)), 'Contains a trademarked logo.', 'the creator reads the takedown reason');
select throws_ok($$update public.listings set status = 'approved' where id = (select live from ids)$$, '42501', null, 'a creator cannot restore a removed listing');
select throws_ok($$update public.listings set status = 'pending' where id = (select live from ids)$$, '42501', null, 'or resubmit it');

-- Staff cannot edit listings directly ---------------------------------------------------------------------
select pg_temp.as_user('owner');
update public.listings set title = 'Edited by staff' where id = (select p1 from ids);
select isnt((select title from public.listings where id = (select p1 from ids)), 'Edited by staff', 'a direct update by staff changes nothing');

-- Files that have not passed the scan block approval ------------------------------------------------------------
select pg_temp.as_uploader('trilobite-coaster-set');
select lives_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes)
    select '11111111-1111-4111-8111-111111111111', p1, '2.0.0', p1::text || '/11111111-1111-4111-8111-111111111111/coaster.3mf', repeat('c', 64), '3mf', 2048 from ids$$,
  'the creator adds a version to an approved listing');
select is((select scan_status || '/' || review_status from public.listing_versions where id = '11111111-1111-4111-8111-111111111111'), 'uploading/pending', 'it starts uploading and pending');
select pg_temp.as_user('moderator');
select is((select status || '/' || waiting_versions::text || '/' || ready::text from public.moderation_queue where listing_id = (select p1 from ids)), 'approved/1/false', 'an approved listing with a waiting version is back in the queue, not ready');
select pg_temp.as_user('owner');
select throws_ok($$select public.approve_listing((select p1 from ids))$$, 'P0001', 'a file has not passed the upload scan yet', 'a version that has not passed the scan cannot be approved');
select lives_ok($$select public.reject_listing((select p1 from ids), 'Wrong file.')$$, 'the waiting version can be rejected');
select is((select status from public.listings where id = (select p1 from ids)), 'approved', 'rejecting a new version leaves the approved listing public');
select is((select review_status from public.listing_versions where id = '11111111-1111-4111-8111-111111111111'), 'rejected', 'and rejects the version');
select pg_temp.as_anon();
select is((select count(*)::int from public.listing_versions where id = '11111111-1111-4111-8111-111111111111'), 0, 'anon never sees an unreviewed version');

-- Moderation modes -----------------------------------------------------------------------------------------------
select pg_temp.as_user('owner');
select throws_ok($$select public.set_moderation_mode('everyone')$$, '23514', null, 'unknown modes are refused');
select lives_ok($$select public.set_moderation_mode('moderators')$$, 'the owner lets moderators approve');
select is((select moderation_mode from public.library_settings), 'moderators', 'the mode changed');
select is((select count(*)::int from public.audit_log where action = 'set_moderation_mode' and at = now() and detail = '{"from": "owner-approves-all", "to": "moderators"}'), 1, 'the change is in the audit log');
select pg_temp.as_user('moderator');
select lives_ok($$select public.approve_listing((select p3 from ids))$$, 'a moderator approves in moderators mode');
select pg_temp.as_user('moderator');
insert into public.creators (owner_id, handle, display_name) select moderator, 'mod-prints', 'Mod prints' from ids;
insert into public.listings (id, creator_id, slug, title) select '44444444-4444-4444-8444-444444444444', (select id from public.creators where handle = 'mod-prints'), 'mod-own-upload', 'Mod own upload' from ids;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status, review_status, scanned_at)
  values ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', '1.0.0', '44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555/m.stl', repeat('4', 64), 'stl', 10, 'uploading', 'pending', null);
reset role;
update public.listing_versions set scan_status = 'clean', scanned_at = now() where id = '55555555-5555-4555-8555-555555555555';
select pg_temp.as_user('moderator');
select throws_ok($$select public.approve_listing('44444444-4444-4444-8444-444444444444')$$, '42501', 'another staff member has to review your own upload', 'a moderator cannot approve their own upload');
select throws_ok($$select public.reject_listing('44444444-4444-4444-8444-444444444444', 'my own')$$, '42501', null, 'or reject it');
select pg_temp.as_user('owner');
select lives_ok($$select public.approve_listing('44444444-4444-4444-8444-444444444444')$$, 'the owner can review a moderator''s upload');
select pg_temp.as_user('rv');
select throws_ok($$select public.approve_listing((select p1 from ids))$$, '42501', null, 'a member still cannot');
select throws_ok($$update public.library_settings set moderation_mode = 'auto-after-scan'$$, '42501', null, 'the mode cannot be written directly');

-- Comment moderation --------------------------------------------------------------------------------------------------
select pg_temp.as_user('moderator');
update public.comments set deleted_at = now(), body = 'edited by staff' where id = (select any_comment from ids);
select is((select count(*)::int from public.comments where id = (select any_comment from ids) and body <> 'edited by staff'), 1, 'staff cannot change a comment by updating the row');
select lives_ok($$select public.delete_comment((select any_comment from ids))$$, 'staff delete a comment');
select is((select count(*)::int from public.comments where id = (select any_comment from ids)), 0, 'the comment leaves the thread');
select is((select count(*)::int from public.audit_log where action = 'delete_comment' and target_id = (select any_comment from ids) and at = now()), 1, 'the deletion is in the audit log');

select pg_temp.as_user('rv');
insert into public.comments (id, listing_id, user_id, body) select '22222222-2222-4222-8222-222222222222', p3, rv, 'My own remark' from ids;
select throws_ok($$update public.comments set user_id = null where id = '22222222-2222-4222-8222-222222222222'$$, '42501', null, 'an author cannot change who wrote a comment');
select lives_ok($$update public.comments set body = 'My edited remark' where id = '22222222-2222-4222-8222-222222222222'$$, 'an author edits their comment');
select is((select edited_at is not null from public.comments where id = '22222222-2222-4222-8222-222222222222'), true, 'the edit is stamped');
select pg_temp.as_user('ash');
select throws_ok($$select public.delete_comment('22222222-2222-4222-8222-222222222222')$$, '42501', null, 'another member cannot delete it');
select pg_temp.as_user('rv');
select lives_ok($$select public.delete_comment('22222222-2222-4222-8222-222222222222')$$, 'the author deletes it');
select is((select count(*)::int from public.comments where id = '22222222-2222-4222-8222-222222222222'), 0, 'it is gone from the thread');

select * from finish();
rollback;
