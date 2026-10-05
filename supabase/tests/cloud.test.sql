-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Cloud module tests (pgTAP): profile sync, the slicing queue, deliveries and
-- storage access. Run with `supabase test db` after `supabase db reset`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ash') as ash;
create temp table t (k text primary key, v text) on commit drop;
grant select on ids to anon, authenticated, service_role;
grant all on t to anon, authenticated, service_role;

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

create function pg_temp.v(p_k text) returns text language sql as $$ select v from t where k = p_k $$;

-- Schema -----------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     and c.relname in ('cloud_devices', 'sync_profiles', 'sync_printers', 'sync_fleets', 'cloud_jobs', 'cloud_deliveries')),
  0, 'every cloud table has row level security enabled');

-- Devices ----------------------------------------------------------------------------
select pg_temp.as_user('rv');
with d as (insert into public.cloud_devices (kind, name) values ('link', 'Workshop bridge') returning id)
insert into t select 'rv_device', id::text from d;
select is((select count(*)::int from public.cloud_devices), 1, 'rv registers a device');
select pg_temp.as_user('ash');
select is((select count(*)::int from public.cloud_devices), 0, 'ash cannot see rv''s devices');
select throws_ok(
  $$insert into public.cloud_devices (user_id, kind, name) select rv, 'link', 'Not mine' from ids$$,
  '42501', null, 'ash cannot register a device for rv');

-- Profile sync -------------------------------------------------------------------------
select pg_temp.as_user('rv');
insert into t select 'p1', row_data ->> 'id' from public.sync_push(
  jsonb_build_array(jsonb_build_object('entity', 'profile', 'row', jsonb_build_object(
    'kind', 'process', 'name', '0.20 mm Standard', 'settings', jsonb_build_object('layer_height', 0.2)))),
  pg_temp.v('rv_device')::uuid);
insert into t select 'p1_rev', revision::text from public.sync_profiles where id = pg_temp.v('p1')::uuid;
select isnt(pg_temp.v('p1'), null, 'rv creates a process profile through sync_push');
select cmp_ok(pg_temp.v('p1_rev')::bigint, '>', 0::bigint, 'the new profile gets a revision');
select is(
  (select updated_by::text from public.sync_profiles where id = pg_temp.v('p1')::uuid),
  pg_temp.v('rv_device'), 'the profile records the device that wrote it');

select is(
  (select status from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'profile', 'baseRevision', pg_temp.v('p1_rev')::bigint,
    'row', jsonb_build_object('id', pg_temp.v('p1'), 'settings', jsonb_build_object('layer_height', 0.16)))))),
  'applied', 'an update at the current revision applies');
select cmp_ok(
  (select revision from public.sync_profiles where id = pg_temp.v('p1')::uuid),
  '>', pg_temp.v('p1_rev')::bigint, 'an update raises the revision');
select is(
  (select row_data -> 'settings' ->> 'layer_height' from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'profile', 'baseRevision', pg_temp.v('p1_rev')::bigint,
    'row', jsonb_build_object('id', pg_temp.v('p1'), 'settings', jsonb_build_object('layer_height', 0.28)))))
   where status = 'conflict'),
  '0.16', 'a stale update is a conflict and returns the current row');
select is(
  (select status from public.sync_push(jsonb_build_array(
    jsonb_build_object('entity', 'profile', 'row', jsonb_build_object('kind', 'bogus', 'name', 'x'))))),
  'rejected', 'a change that breaks a rule is rejected');
select is(
  (select count(*)::int from public.sync_push(jsonb_build_array(
    jsonb_build_object('entity', 'profile', 'row', jsonb_build_object('kind', 'bogus', 'name', 'x')),
    jsonb_build_object('entity', 'profile', 'row', jsonb_build_object('kind', 'filament', 'name', 'Generic PLA'))))
   where status = 'applied'),
  1, 'a rejected change does not stop the rest of the batch');
select throws_ok(
  $$delete from public.sync_profiles$$,
  '42501', null, 'members cannot delete synced rows, only mark them deleted');
select is(
  (select array_agg(revision order by revision) = array_agg(revision) from public.sync_pull(0)),
  true, 'sync_pull returns rows in revision order');
select is(
  (select count(*)::int from public.sync_pull(pg_temp.v('p1_rev')::bigint) where entity = 'profile'),
  2, 'sync_pull returns only rows above the given revision');

select pg_temp.as_user('ash');
select is((select count(*)::int from public.sync_pull(0)), 0, 'ash pulls none of rv''s rows');
select is(
  (select status || ':' || coalesce(row_data::text, 'null') from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'profile', 'baseRevision', 1, 'row', jsonb_build_object('id', pg_temp.v('p1'), 'name', 'mine now'))))),
  'conflict:null', 'ash cannot update rv''s profile and learns nothing about it');
select is(
  (select status from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'profile', 'row', jsonb_build_object('id', pg_temp.v('p1'), 'kind', 'process', 'name', 'taken'))))),
  'conflict', 'ash cannot take over rv''s profile id');
select is(
  (select status from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'profile', 'row', jsonb_build_object('kind', 'process', 'name', 'x'))), pg_temp.v('rv_device')::uuid)),
  'rejected', 'ash cannot write through rv''s device');

select pg_temp.as_anon();
select throws_ok($$select * from public.sync_pull(0)$$, '42501', null, 'anon cannot pull');

-- Printers and fleets --------------------------------------------------------------------
select pg_temp.as_user('rv');
select is(
  (select row_data ->> 'code' from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'printer', 'row', jsonb_build_object('name', 'Bay 9', 'settings', jsonb_build_object('access_code', '12345678')))))),
  '23514', 'printer rows refuse credentials');
insert into public.sync_printers (name, driver, model, device_id, local_id)
values ('Bay 1', 'moonraker', 'Example Core XY', pg_temp.v('rv_device')::uuid, 'bay-1');
insert into t select 'rv_printer', id::text from public.sync_printers where local_id = 'bay-1';
select is(
  (select status from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'fleet', 'row', jsonb_build_object('name', 'Workshop', 'printer_ids', jsonb_build_array(pg_temp.v('rv_printer'))))))),
  'applied', 'rv groups a printer into a fleet');

select pg_temp.as_user('ash');
insert into public.sync_printers (name) values ('Ash printer');
insert into t select 'ash_printer', id::text from public.sync_printers where name = 'Ash printer';
select is(
  (select status from public.sync_push(jsonb_build_array(jsonb_build_object(
    'entity', 'fleet', 'row', jsonb_build_object('name', 'Mixed', 'printer_ids', jsonb_build_array(pg_temp.v('rv_printer'))))))),
  'rejected', 'a fleet cannot hold another member''s printer');

-- Queue -----------------------------------------------------------------------------
select pg_temp.as_user('rv');
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select rv, 'x', '{}' from ids$$,
  '42501', null, 'members cannot insert jobs directly');
select throws_ok(
  $$select * from public.claim_cloud_job('w')$$,
  '42501', null, 'members cannot claim jobs');

select pg_temp.as_service();
-- Cloud slicing is invite only (0006_cloud_access.sql, cloud_access.test.sql).
insert into public.cloud_access (user_id) select rv from ids union all select ash from ids;
with j as (
  insert into public.cloud_jobs (user_id, name, request, target_printer_id)
  select rv, 'Bracket', '{"plate":{"objects":[]}}', pg_temp.v('rv_printer')::uuid from ids returning id
)
insert into t select 'job', id::text from j;
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request, target_printer_id)
    select ash, 'x', '{}', pg_temp.v('rv_printer')::uuid from ids$$,
  '23503', null, 'a job cannot target another member''s printer');
insert into public.cloud_jobs (user_id, name, request) select rv, 'Filler ' || g, '{}' from ids, generate_series(1, 4) g;
select throws_ok(
  $$insert into public.cloud_jobs (user_id, name, request) select rv, 'One too many', '{}' from ids$$,
  'P0001', null, 'a member can have at most five active jobs');
select is(
  (select id::text || ':' || status || ':' || attempts from public.claim_cloud_job('worker-a')),
  pg_temp.v('job') || ':running:1', 'the service claims the oldest queued job');

select pg_temp.as_user('rv');
select is((select count(*)::int from public.cloud_jobs), 5, 'rv reads their jobs');
select pg_temp.as_user('ash');
select is((select count(*)::int from public.cloud_jobs), 0, 'ash reads none of rv''s jobs');
select is(public.cancel_cloud_job(pg_temp.v('job')::uuid), false, 'ash cannot cancel rv''s job');

-- Deliveries --------------------------------------------------------------------------
select pg_temp.as_service();
update public.cloud_jobs set status = 'succeeded', progress = 1, finished_at = now() where id = pg_temp.v('job')::uuid;
insert into t select 'delivery', id::text from public.cloud_deliveries where job_id = pg_temp.v('job')::uuid;
select is(
  (select state || ':' || device_id::text from public.cloud_deliveries where id = pg_temp.v('delivery')::uuid),
  'offered:' || pg_temp.v('rv_device'), 'a finished job with a target is offered to the printer''s bridge');
select throws_ok(
  $$update public.cloud_jobs set status = 'running' where id = pg_temp.v('job')::uuid$$,
  '23514', null, 'a finished job cannot be reopened by a late worker');
select throws_ok(
  $$update public.cloud_deliveries set state = 'printing' where id = pg_temp.v('delivery')::uuid$$,
  '23514', null, 'a delivery cannot skip the approval states');
update public.cloud_deliveries set state = 'downloaded' where id = pg_temp.v('delivery')::uuid;
update public.cloud_deliveries set state = 'awaiting_approval' where id = pg_temp.v('delivery')::uuid;

select pg_temp.as_user('ash');
select is(public.cancel_cloud_delivery(pg_temp.v('delivery')::uuid), false, 'ash cannot cancel rv''s delivery');
select pg_temp.as_user('rv');
select is(public.cancel_cloud_delivery(pg_temp.v('delivery')::uuid), true, 'rv cancels a delivery waiting for approval');
select throws_ok(
  $$update public.cloud_deliveries set state = 'approved'$$,
  '42501', null, 'members cannot move deliveries themselves');

-- Storage ---------------------------------------------------------------------------
reset role;
insert into storage.objects (bucket_id, name)
select 'cloud-results', rv::text || '/' || pg_temp.v('job') || '/slice.gcode' from ids;
select pg_temp.as_user('rv');
select is((select count(*)::int from storage.objects where bucket_id = 'cloud-results'), 1, 'rv reads their results');
select pg_temp.as_user('ash');
select is((select count(*)::int from storage.objects where bucket_id = 'cloud-results'), 0, 'ash cannot read rv''s results');

select * from finish();
rollback;
