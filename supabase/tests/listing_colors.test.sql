-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Listing colors (pgTAP): the shape check on listing_versions.colors, who can
-- write them, who can read them, and that a color fix keeps a live listing live.
-- Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

create temp table ids on commit drop as
select
  (select id from public.profiles where handle = 'ferro') as ferro,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_live,
  (select l.id from public.listings l where l.status = 'pending' order by l.slug limit 1) as some_pending;
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

-- The shape -----------------------------------------------------------------------------------------
select has_column('public', 'listing_versions', 'colors', 'versions have colors');
select ok(public.listing_colors_ok(null), 'no colors is fine');
select ok(public.listing_colors_ok('{"colors":[{"hex":"#d4af37","name":"Silk gold"},{"hex":"#1c1c1e"}],"parts":[{"name":"Body","colors":[0,1],"ams":true}]}'), 'two colors, one AMS part');
select ok(public.listing_colors_ok('{"colors":[{"hex":"#ffffff"}],"parts":[]}'), 'a color with no parts listed');
select ok(not public.listing_colors_ok('{"colors":[],"parts":[]}'), 'at least one color');
select ok(not public.listing_colors_ok(jsonb_build_object('colors', (select jsonb_agg(jsonb_build_object('hex', '#000000')) from generate_series(1, 33)), 'parts', '[]'::jsonb)), 'at most 32 colors');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"#D4AF37"}],"parts":[]}'), 'hex is lowercase');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"red"}],"parts":[]}'), 'hex is #rrggbb');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"#000000","name":"<b>x</b>"}],"parts":[]}'), 'names hold no markup');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"#000000"}],"parts":[{"name":"Body","colors":[1],"ams":false}]}'), 'a part names only colors the model has');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"#000000"}],"parts":[{"name":"Body","colors":[0]}]}'), 'a part says whether it needs the AMS');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"#000000"}],"parts":[],"extra":1}'), 'no other keys');
select ok(not public.listing_colors_ok('{"colors":[{"hex":"#000000"}],"parts":[{"name":"Body","colors":[99999999999],"ams":false}]}'), 'a huge index is refused, not an error');

-- Writing -------------------------------------------------------------------------------------------
select pg_temp.as_user('ferro');
select lives_ok($$update public.listing_versions set colors = '{"colors":[{"hex":"#d4af37","name":"Silk gold"}],"parts":[{"name":"Body","colors":[0],"ams":false}]}' where id = (select live_v from vs)$$, 'the creator sets the colors of a live version');
select is((select colors -> 'colors' -> 0 ->> 'name' from public.listing_versions where id = (select live_v from vs)), 'Silk gold', 'and reads them back');
select throws_ok($$update public.listing_versions set colors = '{"colors":[{"hex":"gold"}],"parts":[]}' where id = (select live_v from vs)$$, '23514', null, 'a bad shape is refused');
select is((select status from public.listings where id = (select ferro_live from ids)), 'approved', 'a color fix keeps the listing live');
select is((select review_status from public.listing_versions where id = (select live_v from vs)), 'approved', 'and the version approved');
select throws_ok($$update public.listing_versions set colors = null, review_status = 'rejected' where id = (select live_v from vs)$$, '42501', null, 'colors do not open the review fields');

select pg_temp.as_user('ash');
update public.listing_versions set colors = '{"colors":[{"hex":"#ff0000"}],"parts":[]}' where id = (select live_v from vs);
select pg_temp.as_user('ferro');
select is((select colors -> 'colors' -> 0 ->> 'hex' from public.listing_versions where id = (select live_v from vs)), '#d4af37', 'another member cannot change them');

-- Reading -------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select colors -> 'colors' -> 0 ->> 'hex' from public.listing_versions where id = (select live_v from vs)), '#d4af37', 'anyone reads the colors of a live version');
select is((select count(*)::integer from public.listing_versions where id = (select pending_v from vs)), 0, 'but not of one in review');

reset role;
select lives_ok($$update public.listing_versions set colors = '{"colors":[{"hex":"#000000"}],"parts":[]}' where id = (select pending_v from vs)$$, 'the service role writes them too');
select throws_ok($$update public.listing_versions set colors = '[1,2]' where id = (select pending_v from vs)$$, '23514', null, 'with the same check');

select * from finish();
rollback;
