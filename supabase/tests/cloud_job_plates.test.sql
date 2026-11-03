-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud job plates tests (pgTAP): a job that names its plates counts each of
-- them against the daily limit, a job past what is left is refused before it
-- runs, and the plate count comes from the request whoever inserts the row.
-- Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

create temp table ids on commit drop as
select (select id from public.profiles where handle = 'bo') as bo;
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

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end;
$$;

-- Schema ---------------------------------------------------------------------------
select has_column('public', 'cloud_jobs', 'plate_count', 'cloud_jobs has plate_count');
select has_column('public', 'cloud_jobs', 'plate_index', 'cloud_jobs has plate_index');

select pg_temp.as_service();
select is(public.grant_cloud_access('bo@example.com', 6, 25), (select bo from ids), 'bo is invited with 6 slices a day');

-- The plate count is the request's -------------------------------------------------
insert into public.cloud_jobs (user_id, name, request, plate_count)
select bo, 'Three plates', '{"options":{"plates":[1,2,3]}}', 1 from ids;
select is(
  (select plate_count from public.cloud_jobs where name = 'Three plates'),
  3, 'plate_count is the number of plates the request names, whatever the insert says');
insert into public.cloud_jobs (user_id, name, request, plate_count)
select bo, 'One plate', '{"options":{}}', 9 from ids;
select is(
  (select plate_count from public.cloud_jobs where name = 'One plate'),
  1, 'a request that names no plates counts once');
select is(
  (select jobs_per_day || ':' || jobs_today from public.cloud_quota((select bo from ids))),
  '6:4', 'today''s use counts every plate');

-- Past what is left ------------------------------------------------------------------
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'Too many', '{"options":{"plates":[1,2,3]}}' from ids$$,
  'P0001', 'this job slices 3 plates, and this account can slice 2 more plates today',
  'a job whose plates are more than the slices left is refused, naming what is left');
select lives_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'Two plates', '{"options":{"plates":[4,5]}}' from ids$$,
  'a job that fits what is left is queued');
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'Spent', '{}' from ids$$,
  'P0001', 'this account has used its 6 cloud slices for the last 24 hours',
  'with nothing left, a job is refused as before');
update public.cloud_jobs set created_at = now() - interval '25 hours'
where user_id = (select bo from ids) and name = 'Three plates';
select lives_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select bo, 'Later', '{"options":{"plates":[1,2]}}' from ids$$,
  'plates of jobs older than 24 hours no longer count');
update public.cloud_jobs set status = 'canceled', finished_at = now() where user_id = (select bo from ids);

-- Plate count bounds and progress ------------------------------------------------------
update public.cloud_access set jobs_per_day = 1000 where user_id = (select bo from ids);
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request)
    select bo, 'Big', jsonb_build_object('options', jsonb_build_object('plates', (select jsonb_agg(n) from generate_series(1, 33) n))) from ids$$,
  '23514', null, 'a job cannot name more than 32 plates');
update public.cloud_jobs set plate_index = 2 where name = 'Later';
select is((select plate_index from public.cloud_jobs where name = 'Later'), 2, 'the worker records the plate it slices');
select throws_ok(
  $$update public.cloud_jobs set plate_index = 0 where name = 'Later'$$,
  '23514', null, 'plate numbers start at 1');

-- Members read their plates and cannot write them ---------------------------------------
select pg_temp.as_user('bo');
select throws_ok(
  $$update public.cloud_jobs set plate_count = 1 where name = 'Later'$$,
  '42501', null, 'a member cannot change a job''s plate count');

select * from finish();
rollback;
