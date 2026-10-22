-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Listing size (pgTAP): listing_versions.size_mm comes only from a clean scan's report, clients cannot write it,
-- the backfill keeps only what a report vouches for, and anyone who can read the version reads it.
-- Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

create temp table ids on commit drop as
select
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_live,
  (select l.id from public.listings l where l.status = 'pending' order by l.slug limit 1) as some_pending,
  '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a'::uuid as l1,
  '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b'::uuid as v1,
  '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c'::uuid as v2,
  '5d5d5d5d-5d5d-4d5d-8d5d-5d5d5d5d5d5d'::uuid as v3;
create temp table vs on commit drop as
select
  (select v.id from public.listing_versions v where v.listing_id = (select ferro_live from ids) and v.review_status = 'approved' order by v.created_at desc limit 1) as live_v,
  (select v.id from public.listing_versions v where v.listing_id = (select some_pending from ids) order by v.created_at desc limit 1) as pending_v;
grant select on ids, vs to anon, authenticated, service_role;

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

-- What a report vouches for ------------------------------------------------------------------------------------
select has_column('public', 'listing_versions', 'size_mm', 'versions have a size');
select col_type_is('public', 'listing_versions', 'size_mm', 'real[]', 'three reals, mm');
select is(public.listing_size_mm('{"detectedType":"3mf","boundsMm":{"min":[5,40,-6],"max":[35,48,6]},"boundsPlate":1,"plateCount":1}'),
  '{30,8,12}'::real[], 'a 3MF report that names its plate gives max minus min');
select is(public.listing_size_mm('{"detectedType":"stl","boundsMm":{"min":[0,0,0],"max":[30,12,8]}}'),
  '{30,12,8}'::real[], 'an STL report counts without a plate: it has one and no transforms');
select is(public.listing_size_mm('{"detectedType":"3mf","boundsMm":{"min":[300,0,0],"max":[340,20,5]},"boundsPlate":2,"plateCount":2}'),
  '{40,20,5}'::real[], 'a project on several plates gives the plate the scan measured');
select is(public.listing_size_mm('{"detectedType":"3mf","boundsMm":{"min":[0,0,0],"max":[10,10,10]}}'),
  null, 'an older 3MF report, which may hold only the first of several plates, gives nothing');
select is(public.listing_size_mm('{"detectedType":"sx3mf","boundsMm":{"min":[0,0,0],"max":[10,10,10]},"plateCount":3}'),
  null, 'nor does one that does not name the plate it measured');
select is(public.listing_size_mm('{"detectedType":"stl","triangleCount":12,"boundsPlate":1}'), null, 'no bounds, no size');
select is(public.listing_size_mm(null), null, 'no report, no size');
select is(public.listing_size_mm('[1,2,3]'), null, 'a report that is not an object gives nothing');
select is(public.listing_size_mm('{"detectedType":"stl","boundsMm":{"min":[0,0],"max":[30,12]}}'), null, 'two axes are not a size');
select is(public.listing_size_mm('{"detectedType":"stl","boundsMm":{"min":[0,0,"0"],"max":[30,12,8]}}'), null, 'every coordinate is a number');
select is(public.listing_size_mm('{"detectedType":"stl","boundsMm":{"min":[0,0,9],"max":[30,12,8]}}'), null, 'inside out is not a size');
select is(public.listing_size_mm('{"detectedType":"stl","boundsMm":{"min":[0,0,0],"max":[1e40,12,8]}}'), null, 'nor is one past what a real holds');
select is(public.listing_size_mm('{"detectedType":"3mf","boundsMm":{"min":[0,0,0],"max":[30.0000019,12.0004,8]},"boundsPlate":1}'),
  '{30,12,8}'::real[], 'float dust from a rotation is rounded to a thousandth of a mm');

-- Clients never write it ---------------------------------------------------------------------------------------
select pg_temp.as_user('ferro');
insert into public.listings (id, creator_id, slug, title) select l1, ferro_creator, 'size-test-piece', 'Size test piece' from ids;
select lives_ok(
  $$insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, size_mm)
    select v1, l1, '1.0.0', l1::text || '/' || v1::text || '/piece.3mf', repeat('a', 64), '3mf', 4096, '{1,2,3}' from ids$$,
  'a creator inserts a version row with a size');
select is((select size_mm from public.listing_versions where id = (select v1 from ids)), null, 'the size is dropped');
select throws_ok($$update public.listing_versions set size_mm = '{1,2,3}' where id = (select v1 from ids)$$,
  '42501', null, 'a creator cannot set the size of their own version');
select throws_ok($$update public.listing_versions set size_mm = '{1,2,3}' where id = (select live_v from vs)$$,
  '42501', null, 'nor of a live one');

-- finish_scan keeps it --------------------------------------------------------------------------------------------
reset role;
insert into public.listing_versions (id, listing_id, version, storage_path, sha256, format, size_bytes, scan_status, scan_started_at)
select v, l1, ver, l1::text || '/' || v::text || '/piece.3mf', repeat('a', 64), '3mf', 4096, 'scanning', now()
from ids cross join lateral (values (ids.v2, '1.0.1'), (ids.v3, '1.0.2')) as x(v, ver);
update public.listing_versions set scan_status = 'scanning', scan_started_at = now() where id = (select v1 from ids);
select pg_temp.as_service();
select lives_ok(
  $$select public.finish_scan((select v1 from ids), true,
    '{"verdict":"clean","detectedType":"3mf","boundsMm":{"min":[5,40,-6],"max":[35,48,6]},"boundsPlate":1,"plateCount":1}')$$,
  'the service records a clean scan');
select is((select size_mm from public.listing_versions where id = (select v1 from ids)), '{30,8,12}'::real[], 'and the version has the placed size');
select lives_ok(
  $$select public.finish_scan((select v2 from ids), true, '{"verdict":"clean","detectedType":"3mf","boundsMm":{"min":[0,0,0],"max":[10,10,10]}}')$$,
  'a report from an older scan is recorded');
select is((select size_mm from public.listing_versions where id = (select v2 from ids)), null, 'without a size');
select lives_ok(
  $$select public.finish_scan((select v3 from ids), false,
    '{"verdict":"rejected","reason":"too big","detectedType":"stl","boundsMm":{"min":[0,0,0],"max":[30,12,8]}}')$$,
  'a rejection is recorded');
select is((select size_mm from public.listing_versions where id = (select v3 from ids)), null, 'and a rejected version has no size');
select throws_ok($$update public.listing_versions set size_mm = '{1,2}' where id = (select v2 from ids)$$,
  '23514', null, 'a stored size has three axes');
select throws_ok($$update public.listing_versions set size_mm = '{1,2,-3}' where id = (select v2 from ids)$$,
  '23514', null, 'none of them negative');

-- The backfill, as 0030_listing_size.sql runs it -------------------------------------------------------------------
reset role;
update public.listing_versions set size_mm = null,
  scan_report = '{"verdict":"clean","detectedType":"stl","boundsMm":{"min":[0,0,0],"max":[30,12,8]}}'
where id = (select live_v from vs);
update public.listing_versions set size_mm = null where id = (select v1 from ids);
update public.listing_versions
set size_mm = public.listing_size_mm(scan_report)
where scan_status = 'clean' and size_mm is null and public.listing_size_mm(scan_report) is not null;
select is((select size_mm from public.listing_versions where id = (select live_v from vs)), '{30,12,8}'::real[], 'the backfill keeps an STL report''s size');
select is((select size_mm from public.listing_versions where id = (select v1 from ids)), '{30,8,12}'::real[], 'and a placed 3MF report''s');
select is((select size_mm from public.listing_versions where id = (select v2 from ids)), null, 'and leaves an older 3MF report without one');
select is(
  (select count(*)::integer from public.listing_versions where size_mm is distinct from case when scan_status = 'clean' then public.listing_size_mm(scan_report) end and size_mm is not null),
  0, 'every stored size is the one its report gives');

-- Reading ------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select size_mm from public.listing_versions where id = (select live_v from vs)), '{30,12,8}'::real[], 'anyone reads the size of a live version');
select is((select count(*)::integer from public.listing_versions where id = (select pending_v from vs)), 0, 'but not of one in review');

select * from finish();
rollback;
