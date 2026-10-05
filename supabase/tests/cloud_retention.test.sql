-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud retention tests (pgTAP): which cloud files expire_cloud_files hands
-- the service to delete, and who may call it. Run with `supabase test db`
-- after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

create temp table ids on commit drop as
select (select id from public.profiles where handle = 'dee') as dee;
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

-- A finished job ten days old with its files, a mesh an active job still
-- needs, an old mesh nobody needs and a fresh result.
reset role;
insert into public.cloud_access (user_id) select dee from ids;
insert into public.cloud_jobs (user_id, name, request, status, finished_at, gcode_path, preview_path, created_at)
select dee, 'Old', '{}', 'succeeded', now() - interval '10 days',
  dee::text || '/old/slice.gcode', dee::text || '/old/slice.sxpv', now() - interval '10 days'
from ids;
insert into public.cloud_jobs (user_id, name, request)
select dee, 'Waiting', jsonb_build_object('plate', jsonb_build_object('objects',
  jsonb_build_array(jsonb_build_object('id', 'a', 'mesh', repeat('a', 64))))) from ids;
insert into storage.objects (bucket_id, name, created_at)
select b, dee::text || '/' || n, c from ids, (values
  ('cloud-results', 'old/slice.gcode', now() - interval '10 days'),
  ('cloud-results', 'old/slice.sxpv', now() - interval '10 days'),
  ('cloud-inputs', repeat('a', 64), now() - interval '10 days'),
  ('cloud-inputs', repeat('b', 64), now() - interval '10 days'),
  ('cloud-results', 'new/slice.gcode', now())
) as f(b, n, c);

select pg_temp.as_user('dee');
select throws_ok(
  $$select * from public.expire_cloud_files(7)$$,
  '42501', null, 'members cannot expire files');

select pg_temp.as_service();
create temp table expired on commit drop as select * from public.expire_cloud_files(7);
select is((select count(*)::int from expired), 3, 'three files are past seven days and unused');
select ok(exists (select 1 from expired where path like '%/old/slice.gcode'), 'an old result expires');
select ok(exists (select 1 from expired where path like '%/' || repeat('b', 64)), 'an old unused mesh expires');
select ok(not exists (select 1 from expired where path like '%/' || repeat('a', 64)), 'a mesh a queued job needs is kept');
select ok(not exists (select 1 from expired where path like '%/new/%'), 'a fresh result is kept');
select is(
  (select coalesce(gcode_path, 'none') || ':' || coalesce(preview_path, 'none') from public.cloud_jobs where name = 'Old'),
  'none:none', 'the old job loses its download paths');
select is(
  (select count(*)::int from public.expire_cloud_files(30)), 0, 'nothing is thirty days old');

select * from finish();
rollback;
