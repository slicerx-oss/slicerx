-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- External review (pgTAP): the listing_reviewer role reads the review queue and
-- approves or sends back uploads for an allowed actor, with the same checks as
-- the owner's buttons, and can do nothing else. Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(61);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'owner') as owner,
  (select id from public.listings where slug = 'trilobite-coaster-set') as p1,
  (select id from public.listings where slug = 'anchor-cabinet-pull') as p2,
  (select id from public.listings where slug = 'chain-link-cable-guide') as p3,
  (select c.owner_id from public.listings l join public.creators c on c.id = l.creator_id where l.slug = 'anchor-cabinet-pull') as p2_uploader;
grant select on ids to anon, authenticated, service_role, listing_reviewer;

-- The migration's role (postgres) administers listing_reviewer but may not become it; the test may, until the rollback.
grant listing_reviewer to postgres with set true;
-- pgTAP lives in extensions.
grant usage on schema extensions to listing_reviewer;

create function pg_temp.as_reviewer() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role listing_reviewer;
end;
$$;

create function pg_temp.as_user(p_handle text) returns void language plpgsql as $$
declare
  uid uuid;
begin
  reset role;
  select id into uid from public.profiles where handle = p_handle;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end;
$$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
end;
$$;

-- The role ------------------------------------------------------------------------------
select is((select rolcanlogin from pg_roles where rolname = 'listing_reviewer'), false, 'the role is created without login');
select is((select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication from pg_roles where rolname = 'listing_reviewer'), false, 'and with no special attributes');
select is((select rolinherit from pg_roles where rolname = 'listing_reviewer'), false, 'it inherits nothing');
select is((select count(*)::int from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'listing_reviewer'), 0, 'it is a member of no role');
select is(
  (select coalesce(string_agg(mr.rolname, ', '), '') from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles mr on mr.oid = m.member
   where r.rolname = 'listing_reviewer' and mr.rolname not in ('postgres', 'supabase_admin')),
  '', 'only the admin roles are members of it, so the API (authenticator) cannot switch to it');
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'auth', 'storage') and c.relkind in ('r', 'v', 'm', 'p')
     and (has_table_privilege('listing_reviewer', c.oid, 'select') or has_table_privilege('listing_reviewer', c.oid, 'insert')
       or has_table_privilege('listing_reviewer', c.oid, 'update') or has_table_privilege('listing_reviewer', c.oid, 'delete'))),
  '', 'it holds no table privileges');
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.provolatile = 'v' and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('listing_reviewer', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')),
  'external_review_closed, external_review_posted, review_listing_external',
  'beyond what anon may run, the only writing functions it may run are its own');
select ok(has_function_privilege('listing_reviewer', 'public.external_review_queue()', 'execute'), 'it may read the queue');
select ok(not has_function_privilege('listing_reviewer', 'public.approve_listing(uuid, text)', 'execute'), 'it may not run approve_listing');
select ok(not has_function_privilege('listing_reviewer', 'public.review_approve(uuid, text, jsonb)', 'execute'), 'nor the shared approve logic');

-- Nobody else runs the external functions ------------------------------------------------------
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role']) r(role)
   cross join unnest(array[
     'public.external_review_queue()', 'public.review_listing_external(uuid, text, text, text)',
     'public.external_review_posted(uuid, text)', 'public.external_review_closed(uuid)',
     'public.review_approve(uuid, text, jsonb)', 'public.review_send_back(uuid, text, jsonb)']) f(fn)
   where has_function_privilege(r.role, f.fn, 'execute')),
  0, 'the API roles cannot run any external review function or the shared logic');
select pg_temp.as_user('owner');
select throws_ok($$select * from public.external_review_queue()$$, '42501', null, 'the owner cannot read the queue through the API');
select throws_ok($$select public.review_listing_external((select p1 from ids), 'approve', null, 'discord:123456789012345678')$$, '42501', null, 'nor decide through it');
select throws_ok($$select public.review_approve((select p1 from ids), null, '{}')$$, '42501', null, 'nor call the shared logic');
select throws_ok($$select count(*) from public.external_reviewers$$, '42501', null, 'nor read the allowlist');
select pg_temp.as_anon();
select throws_ok($$select * from public.external_review_queue()$$, '42501', null, 'anon cannot read the queue');
select throws_ok($$select public.external_review_posted((select p1 from ids), 'm')$$, '42501', null, 'anon cannot record a message');
select pg_temp.as_service();
select throws_ok($$select * from public.external_review_queue()$$, '42501', null, 'the service role cannot read the queue either');

-- The reviewer cannot touch tables ------------------------------------------------------------
select pg_temp.as_reviewer();
select throws_ok($$select count(*) from public.listings$$, '42501', null, 'the reviewer cannot read listings');
select throws_ok($$select count(*) from public.profiles$$, '42501', null, 'nor profiles');
select throws_ok($$select count(*) from public.audit_log$$, '42501', null, 'nor the audit log');
select throws_ok($$insert into public.external_reviewers (actor) values ('discord:1')$$, '42501', null, 'nor add itself to the allowlist');
select throws_ok($$select public.approve_listing((select p1 from ids))$$, '42501', null, 'nor run the owner''s approve');

-- The allowlist, filled by the service role --------------------------------------------------
select pg_temp.as_service();
select lives_ok($$insert into public.external_reviewers (actor, note) values ('discord:123456789012345678', 'the owner')$$, 'the service role adds an actor');
select throws_ok($$insert into public.external_reviewers (actor) values ('Discord 1')$$, '23514', null, 'an actor is kind:id');

-- QA uploads are marked; a third listing gets a file still waiting for the scan.
reset role;
insert into public.qa_accounts (user_id) select p2_uploader from ids on conflict do nothing;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status)
select v, p3, '1.0.0', p3 || '/' || v || '/later.stl', repeat('a', 64), 'stl', 1000, 'queued' from ids, gen_random_uuid() v;

-- The queue -----------------------------------------------------------------------------------
select pg_temp.as_reviewer();
select is((select kind from public.external_review_queue() where listing_id = (select p1 from ids)), 'new', 'a pending upload with a clean scan is in the queue');
select is((select jsonb_array_length(versions) from public.external_review_queue() where listing_id = (select p1 from ids)), 1, 'with its waiting file');
select ok((select versions -> 0 ?& array['format', 'size_bytes', 'parts', 'plates', 'scan_report'] from public.external_review_queue() where listing_id = (select p1 from ids)), 'carrying format, size, parts, plates and the scan report');
select is((select is_qa from public.external_review_queue() where listing_id = (select p1 from ids)), false, 'a member''s upload is not QA');
select is((select is_qa from public.external_review_queue() where listing_id = (select p2 from ids)), true, 'a QA account''s upload is marked');
select is((select count(*)::int from public.external_review_queue() where listing_id = (select p3 from ids)), 0, 'a listing with a file still waiting for the scan is not');
select is((select count(*)::int from public.external_review_queue() where status not in ('pending', 'approved')), 0, 'nothing rejected, archived or removed is in it');
select is((select message_id from public.external_review_queue() where listing_id = (select p1 from ids)), null, 'nothing is posted yet');
select lives_ok($$select public.external_review_posted((select p1 from ids), 'm1')$$, 'the reviewer records its message');
select is((select message_id from public.external_review_queue() where listing_id = (select p1 from ids)), 'm1', 'the queue returns it');

-- Refusals -------------------------------------------------------------------------------------
select throws_ok($$select public.review_listing_external((select p1 from ids), 'approve', null, 'discord:999999999999999999')$$, '42501', 'this reviewer is not allowed', 'an actor outside the allowlist is refused');
select throws_ok($$select public.review_listing_external((select p1 from ids), 'delete', null, 'discord:123456789012345678')$$, '23514', null, 'an unknown decision is refused');
select throws_ok($$select public.review_listing_external((select p3 from ids), 'approve', null, 'discord:123456789012345678')$$, 'P0001', 'a file has not passed the upload scan yet', 'an unscanned file cannot be approved');
select throws_ok($$select public.review_listing_external(gen_random_uuid(), 'approve', null, 'discord:123456789012345678')$$, 'P0002', null, 'an unknown listing is refused');
select throws_ok($$select public.review_listing_external((select p2 from ids), 'send_back', ' ', 'discord:123456789012345678')$$, '23514', 'give the creator a reason', 'a send back needs a reason');

-- Approve ----------------------------------------------------------------------------------------
select is(public.review_listing_external((select p1 from ids), 'approve', null, 'discord:123456789012345678'), 'approved', 'an allowed actor approves');
reset role;
select is((select reviewed_by is null and reviewed_at is not null and published_at is not null from public.listings where id = (select p1 from ids)), true, 'the listing is live with no profile as reviewer');
select is((select count(*)::int from public.listing_versions where listing_id = (select p1 from ids) and review_status <> 'approved'), 0, 'its versions are approved');
select is(
  (select count(*)::int from public.audit_log where action = 'approve' and target_id = (select p1 from ids) and actor_id is null
     and detail ->> 'actor' = 'discord:123456789012345678' and detail ->> 'via' = 'external_review'),
  1, 'the audit log names the actor');
select pg_temp.as_reviewer();
select throws_ok($$select public.review_listing_external((select p1 from ids), 'approve', null, 'discord:123456789012345678')$$, 'P0001', 'nothing is waiting for review', 'a second press is refused');
select is((select kind || ' ' || decided_by from public.external_review_queue() where listing_id = (select p1 from ids)), 'decided discord:123456789012345678', 'the open message comes back as decided, with who decided');
select lives_ok($$select public.external_review_closed((select p1 from ids))$$, 'the reviewer closes it');
select is((select count(*)::int from public.external_review_queue() where listing_id = (select p1 from ids)), 0, 'and it leaves the queue');

-- A new version of a live design, with a session that pretends to be the owner -------------------
reset role;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status, scanned_at, scan_report)
select v, p1, '1.1.0', p1 || '/' || v || '/v2.3mf', repeat('b', 64), '3mf', 2000, 'clean', now(), '{"verdict":"clean","checks":[]}' from ids, gen_random_uuid() v;
select pg_temp.as_reviewer();
select is((select kind || ' ' || coalesce(message_id, 'none') from public.external_review_queue() where listing_id = (select p1 from ids)), 'version none', 'a new version starts a new round');
select set_config('request.jwt.claims', json_build_object('sub', (select owner from ids), 'role', 'authenticated')::text, true);
select is(public.review_listing_external((select p1 from ids), 'approve', 'ok', 'discord:123456789012345678'), 'approved', 'the version is approved');
reset role;
select is((select reviewed_by from public.listings where id = (select p1 from ids)), null, 'request settings cannot make it look like a profile decided');
select is((select count(*)::int from public.audit_log where action = 'approve' and target_id = (select p1 from ids) and actor_id is null and reason = 'ok'), 1, 'and the audit row has no profile actor');

-- Send back ------------------------------------------------------------------------------------
select pg_temp.as_reviewer();
select is(public.review_listing_external((select p2 from ids), 'send_back', 'The cover shows a different model.', 'discord:123456789012345678'), 'rejected', 'an allowed actor sends a listing back');
reset role;
select is((select review_note from public.listings where id = (select p2 from ids)), 'The cover shows a different model.', 'the creator sees the reason');
select is(
  (select count(*)::int from public.audit_log where action = 'reject' and target_id = (select p2 from ids) and actor_id is null
     and detail ->> 'actor' = 'discord:123456789012345678' and reason = 'The cover shows a different model.'),
  1, 'the audit log has the reason and the actor');

-- Decided in the app while the message was open -----------------------------------------------
select pg_temp.as_reviewer();
select lives_ok($$select public.external_review_posted((select p3 from ids), 'm3')$$, 'a message for a listing');
select pg_temp.as_user('owner');
select lives_ok($$select public.reject_listing((select p3 from ids), 'Please add a plate.')$$, 'the owner sends it back in the app');
select pg_temp.as_reviewer();
select is((select kind || ' ' || decided_by || ' ' || review_note from public.external_review_queue() where listing_id = (select p3 from ids)),
  'decided profile:owner Please add a plate.', 'the queue says who decided in the app and why');

-- The owner's own functions still work the same ---------------------------------------------------
select pg_temp.as_user('owner');
select is((select count(*)::int from public.audit_log where action = 'reject' and target_id = (select p3 from ids) and actor_id = (select owner from ids)), 1, 'reject_listing still records the owner as actor');

-- Kill switch -----------------------------------------------------------------------------------------
reset role;
select lives_ok($$revoke execute on function public.review_listing_external(uuid, text, text, text) from listing_reviewer$$, 'decisions can be switched off');
select ok(not has_function_privilege('listing_reviewer', 'public.review_listing_external(uuid, text, text, text)', 'execute'), 'and the reviewer can no longer decide');

select * from finish();
rollback;
