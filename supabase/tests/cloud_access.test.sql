-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud access tests (pgTAP): the invite list for hosted cloud slicing, the
-- per-account limits and who may change them. Run with `supabase test db`
-- after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'bo') as bo,
  (select id from public.profiles where handle = 'cam') as cam,
  (select id from public.profiles where handle = 'zed') as zed;
grant select on ids to anon, authenticated, service_role;

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

-- Schema ---------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.cloud_access'::regclass),
  'cloud_access has row level security enabled');

-- Nobody but the service role manages the list ------------------------------------------
select pg_temp.as_user('bo');
select throws_ok(
  $$insert into public.cloud_access (user_id) select bo from ids$$,
  '42501', null, 'a member cannot add themselves to the list');
select throws_ok(
  $$select public.grant_cloud_access('bo@example.com')$$,
  '42501', null, 'a member cannot call grant_cloud_access');
select throws_ok(
  $$select * from public.cloud_quota((select bo from ids))$$,
  '42501', null, 'a member cannot read another account''s quota');
select pg_temp.as_anon();
select throws_ok(
  $$select * from public.my_cloud_quota()$$,
  '42501', null, 'visitors cannot ask for a quota');
select throws_ok(
  $$select count(*) from public.cloud_access$$,
  '42501', null, 'visitors cannot read the list');

-- Without access ---------------------------------------------------------------------
select pg_temp.as_service();
select is(public.has_cloud_access((select bo from ids)), false, 'a member starts without cloud access');
select is((select count(*)::int from public.cloud_quota((select bo from ids))), 0, 'no quota without access');
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'x', '{}' from ids$$,
  '42501', null, 'the database refuses a job for an account not on the list');

-- Granting ---------------------------------------------------------------------------
select is(
  public.grant_cloud_access('BO@example.com ', 2, 10, 'first tester'),
  (select bo from ids), 'grant_cloud_access finds the account by email, ignoring case and spaces');
select throws_ok(
  $$select public.grant_cloud_access('nobody@example.com')$$,
  '22023', null, 'granting an email with no account fails');
select throws_ok(
  $$select public.grant_cloud_access('cam@example.com', 5, 51)$$,
  '23514', null, 'the upload limit cannot pass the 50 MB bucket limit');
select is(
  (select jobs_per_day || ':' || jobs_today || ':' || max_upload_bytes from public.cloud_quota((select bo from ids))),
  '2:0:10485760', 'the quota reports the limits and today''s use');
select is(
  (select count(*)::int from public.audit_log where action = 'cloud.grant' and target_id = (select bo from ids)),
  1, 'granting is audited');

-- Daily limit ------------------------------------------------------------------------
insert into public.cloud_jobs (user_id, name, request) select bo, 'One', '{}' from ids;
insert into public.cloud_jobs (user_id, name, request, status) select bo, 'Two', '{}', 'canceled' from ids;
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'Three', '{}' from ids$$,
  'P0001', null, 'a third job in 24 hours is refused, canceled jobs included');
update public.cloud_jobs set created_at = now() - interval '25 hours'
where user_id = (select bo from ids) and name = 'Two';
select lives_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'Three', '{}' from ids$$,
  'jobs older than 24 hours no longer count');

-- Members see their own row and quota ----------------------------------------------------
select pg_temp.as_user('bo');
select is(
  (select jobs_per_day || ':' || jobs_today from public.my_cloud_quota()),
  '2:2', 'a member reads their own quota');
select is((select count(*)::int from public.cloud_access), 1, 'a member reads their own row');
select pg_temp.as_user('cam');
select is((select count(*)::int from public.cloud_access), 0, 'a member cannot read other rows');
select is((select count(*)::int from public.my_cloud_quota()), 0, 'a member without access has no quota');

-- Banned accounts and storage ----------------------------------------------------------
select pg_temp.as_service();
insert into public.cloud_access (user_id) select zed from ids;
select is(public.has_cloud_access((select zed from ids)), false, 'a banned account has no access even when listed');

reset role;
insert into storage.objects (bucket_id, name)
select 'cloud-results', bo::text || '/job/slice.gcode' from ids;

-- Revoking ---------------------------------------------------------------------------
select pg_temp.as_service();
update public.cloud_access set jobs_per_day = 10 where user_id = (select bo from ids);
insert into public.cloud_jobs (user_id, name, request)
select bo, 'Queued', '{}' from ids;
select pg_temp.as_user('bo');
select is((select count(*)::int from storage.objects where bucket_id = 'cloud-results'), 1, 'a listed member reads their results');
select pg_temp.as_service();
select is(public.revoke_cloud_access('bo@example.com'), true, 'revoke_cloud_access removes the account');
select is(
  (select count(*)::int from public.cloud_jobs where user_id = (select bo from ids) and status = 'queued'),
  0, 'revoking cancels the account''s queued jobs');
select pg_temp.as_user('bo');
select is((select count(*)::int from storage.objects where bucket_id = 'cloud-results'), 0, 'a revoked member cannot read their results');

select * from finish();
rollback;
