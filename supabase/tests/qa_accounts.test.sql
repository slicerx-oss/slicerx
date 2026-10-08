-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- QA accounts (pgTAP): @qa.slicerx.app accounts are flagged at sign-up and by
-- the backfill; only the service role reads or changes the flag; QA accounts
-- do what members do, but their likes, makes, downloads and follows stay out of
-- everyone else's counts and rankings, and their uploads out of the Feed,
-- trending, new creators and based on your likes, except for themselves.
-- Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(76);

-- Seed activity is dated; move it a year back so the trending window sees only this test's rows.
update public.likes set created_at = created_at - interval '1 year';
update public.makes set created_at = created_at - interval '1 year';
update public.downloads set first_at = first_at - interval '1 year', last_at = last_at - interval '1 year';
update public.anon_downloads set day = day - 366;

-- Sign-ups: two QA addresses (one in capitals), three look-alikes and one that changes later.
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'qa1@qa.slicerx.app', '{"handle":"qaone"}'),
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'QA.Two@QA.SlicerX.App', '{"handle":"qatwo"}'),
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'someone@notqa.slicerx.app', '{"handle":"lookalike1"}'),
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'qa3@qa.slicerx.app.example.com', '{"handle":"lookalike2"}'),
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'qa4@sub.qa.slicerx.app', '{"handle":"lookalike3"}'),
  ('00000000-0000-0000-0000-000000000000', 'a1a1a1a1-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'later@example.com', '{"handle":"later1"}');

create temp table ids on commit drop as
select
  'a1a1a1a1-0000-4000-8000-000000000001'::uuid as qa1,
  'a1a1a1a1-0000-4000-8000-000000000002'::uuid as qa2,
  'a1a1a1a1-0000-4000-8000-000000000006'::uuid as later,
  (select id from public.profiles where handle = 'ash') as ash,
  (select id from public.profiles where handle = 'rv') as rv,
  (select id from public.profiles where handle = 'ferro') as ferro,
  (select id from public.creators where owner_id = (select id from public.profiles where handle = 'ferro')) as ferro_creator,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1) as ferro_live,
  (select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'marrow') and l.status = 'approved' order by l.slug limit 1) as marrow_live,
  -- A member other than ash who has not liked ferro_live yet.
  (select p.id from public.profiles p where p.role = 'member' and p.banned_at is null and p.handle <> 'ash' and not exists (
     select 1 from public.likes k where k.user_id = p.id and k.listing_id = (
       select l.id from public.listings l join public.creators c on c.id = l.creator_id where c.owner_id = (select id from public.profiles where handle = 'ferro') and l.status = 'approved' order by l.slug limit 1))
   order by p.handle limit 1) as fan,
  -- Tags of a design ash liked, so a design carrying them is a pick for ash.
  (select l.tags from public.likes k join public.listings l on l.id = k.listing_id
   where k.user_id = (select id from public.profiles where handle = 'ash') and cardinality(l.tags) > 0 order by l.slug limit 1) as ash_tags,
  '88888888-0000-4000-8000-000000000001'::uuid as qa_creator,
  '88888888-0000-4000-8000-000000000002'::uuid as qa_live,
  '88888888-0000-4000-8000-000000000003'::uuid as rv_creator,
  '88888888-0000-4000-8000-000000000004'::uuid as rv_live;
grant select on ids to anon, authenticated, service_role;

create function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
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

-- The flag ----------------------------------------------------------------------------------
select is((select count(*)::int from public.qa_accounts where user_id in (select qa1 from ids union select qa2 from ids)), 2,
  'a QA address is flagged at sign-up, in any letter case');
select is((select count(*)::int from public.qa_accounts where user_id in (
    'a1a1a1a1-0000-4000-8000-000000000003', 'a1a1a1a1-0000-4000-8000-000000000004', 'a1a1a1a1-0000-4000-8000-000000000005')), 0,
  'look-alike addresses are not');
select is((select count(*)::int from public.qa_accounts q join auth.users u on u.id = q.user_id where not public.is_qa_email(u.email)), 0,
  'no seeded or other account is flagged');
select is((select count(*)::int from auth.users u where public.is_qa_email(u.email) and not exists (select 1 from public.qa_accounts q where q.user_id = u.id)), 0,
  'every QA address is flagged');

update auth.users set email = 'later@qa.slicerx.app' where id = (select later from ids);
select is((select count(*)::int from public.qa_accounts where user_id = (select later from ids)), 1, 'an address changed to a QA one is flagged');
update auth.users set email = 'later@example.com' where id = (select later from ids);
select is((select count(*)::int from public.qa_accounts where user_id = (select later from ids)), 1, 'changing it away does not clear the flag');
delete from public.qa_accounts where user_id = (select later from ids);

delete from public.qa_accounts where user_id = (select qa1 from ids);
select is(public.backfill_qa_accounts(), 1, 'the backfill flags a QA account that is not flagged');
select is((select count(*)::int from public.qa_accounts where user_id = (select qa1 from ids)), 1, 'and it is flagged again');
select is(public.backfill_qa_accounts(), 0, 'running it again changes nothing');

-- Who may read, set or clear it ------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select count(*) from public.qa_accounts$$, '42501', null, 'a visitor cannot read the flags');
select throws_ok($$insert into public.qa_accounts (user_id) select ash from ids$$, '42501', null, 'nor set one');
select throws_ok($$delete from public.qa_accounts$$, '42501', null, 'nor clear one');
select throws_ok($$select public.qa_hidden((select qa1 from ids))$$, '42501', null, 'nor ask the internal helper');
select throws_ok($$select public.backfill_qa_accounts()$$, '42501', null, 'nor run the backfill');

select pg_temp.as_user((select ash from ids));
select throws_ok($$select count(*) from public.qa_accounts$$, '42501', null, 'a member cannot read the flags');
select throws_ok($$insert into public.qa_accounts (user_id) select ash from ids$$, '42501', null, 'nor flag themselves');
select throws_ok($$select public.backfill_qa_accounts()$$, '42501', null, 'nor run the backfill');

select pg_temp.as_user((select qa1 from ids));
select throws_ok($$select count(*) from public.qa_accounts$$, '42501', null, 'a QA account cannot read its flag');
select throws_ok($$delete from public.qa_accounts where user_id = (select qa1 from ids)$$, '42501', null, 'nor clear it');
select throws_ok($$update public.qa_accounts set flagged_at = now()$$, '42501', null, 'nor change it');

select pg_temp.as_user((select ferro from ids));
select throws_ok($$insert into public.qa_accounts (user_id) select ash from ids$$, '42501', null, 'another creator cannot flag a member');
select throws_ok($$delete from public.qa_accounts where user_id = (select qa1 from ids)$$, '42501', null, 'nor clear a QA account''s flag');

select pg_temp.as_user((select id from public.profiles where handle = 'owner'));
select throws_ok($$insert into public.qa_accounts (user_id) select ash from ids$$, '42501', null, 'not even the owner, from a client');

select pg_temp.as_service();
select lives_ok($$insert into public.qa_accounts (user_id) select ash from ids$$, 'the service role sets a flag');
select is((select count(*)::int from public.qa_accounts where user_id = (select ash from ids)), 1, 'and reads it');
select lives_ok($$delete from public.qa_accounts where user_id = (select ash from ids)$$, 'and clears it');
select is((select count(*)::int from public.qa_accounts where user_id = (select ash from ids)), 0, 'and it is gone');
select is(public.backfill_qa_accounts(), 0, 'and runs the backfill');

-- Before any QA activity, counts are the plain totals ---------------------------------------
reset role;
select set_config('request.jwt.claims', '', true);
create temp table base on commit drop as
select l.id,
  (select count(*) from public.likes x where x.listing_id = l.id) as likes,
  (select count(*) from public.makes x where x.listing_id = l.id) as makes,
  (select coalesce(sum(x.count), 0) from public.downloads x where x.listing_id = l.id)
    + (select coalesce(sum(x.count), 0) from public.anon_downloads x where x.listing_id = l.id) as downloads
from public.listings l;
create temp table base_followers on commit drop as
select c.id, (select count(*) from public.follows f where f.creator_id = c.id) as followers from public.creators c;
grant select on base, base_followers to anon, authenticated;

select pg_temp.as_anon();
select is(
  (select count(*)::int from public.listing_stats((select array_agg(id) from base)) s join base b on b.id = s.listing_id
   where (s.likes, s.makes, s.downloads) is distinct from (b.likes, b.makes, b.downloads)),
  0, 'with only members active, every listing count is the plain total');
select ok((select count(*) from public.listing_stats((select array_agg(id) from base))) > 0, 'over every public listing');
select is(
  (select count(*)::int from public.creator_followers((select array_agg(id) from base_followers)) s join base_followers b on b.id = s.creator_id
   where s.followers <> b.followers),
  0, 'and every follower count');

-- QA accounts do what members do ---------------------------------------------------------------
select pg_temp.as_user((select qa1 from ids));
select lives_ok($$insert into public.likes (user_id, listing_id) select qa1, ferro_live from ids$$, 'a QA account likes a design');
select lives_ok($$insert into public.likes (user_id, listing_id) select qa1, marrow_live from ids$$, 'and another');
select lives_ok($$select public.request_download((select ferro_live from ids))$$, 'downloads it');
select lives_ok($$insert into public.makes (listing_id, user_id) select ferro_live, qa1 from ids$$, 'posts a make');
select lives_ok($$insert into public.follows (user_id, creator_id) select qa1, ferro_creator from ids$$, 'follows its creator');
select is(public.set_saved((select ferro_live from ids), true), true, 'and saves it');

select pg_temp.as_user((select qa2 from ids));
select lives_ok($$insert into public.creators (id, owner_id, handle, display_name) select qa_creator, qa2, 'qa-two', 'QA two' from ids$$,
  'a QA account makes a creator page');
reset role;
insert into public.listings (id, creator_id, slug, title, status, published_at, tags)
select qa_live, qa_creator, 'qa-release-check', 'QA release check', 'approved', now() - interval '1 day', ash_tags from ids;
insert into public.creators (id, owner_id, handle, display_name) select rv_creator, rv, 'rv-prints', 'RV Prints' from ids;
insert into public.listings (id, creator_id, slug, title, status, published_at, tags)
select rv_live, rv_creator, 'rv-first-print', 'First print', 'approved', now() - interval '2 days', ash_tags from ids;

-- A member's activity, for comparison.
select pg_temp.as_user((select fan from ids));
select lives_ok($$insert into public.likes (user_id, listing_id) select fan, ferro_live from ids$$, 'a member likes the same design');
select lives_ok($$select public.request_download((select ferro_live from ids))$$, 'and downloads it');
select lives_ok($$insert into public.likes (user_id, listing_id) select fan, qa_live from ids$$, 'and likes the QA account''s design');

-- Counts ---------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select likes from public.listing_stats(array[(select ferro_live from ids)])), (select likes + 1 from base where id = (select ferro_live from ids)),
  'a visitor counts the member''s like, not the QA account''s');
select is((select downloads from public.listing_stats(array[(select ferro_live from ids)])), (select downloads + 1 from base where id = (select ferro_live from ids)),
  'and the member''s download, not the QA account''s');
select is((select makes from public.listing_stats(array[(select ferro_live from ids)])), (select makes from base where id = (select ferro_live from ids)),
  'a QA make is not counted');
select is((select likes from public.listing_stats(array[(select marrow_live from ids)])), (select likes from base where id = (select marrow_live from ids)),
  'a design only a QA account liked keeps its count');
select is((select followers from public.creator_followers(array[(select ferro_creator from ids)])), (select followers from base_followers where id = (select ferro_creator from ids)),
  'a QA follow is not counted');

select pg_temp.as_user((select ash from ids));
select is((select likes from public.listing_stats(array[(select ferro_live from ids)])), (select likes + 1 from base where id = (select ferro_live from ids)),
  'nor by another member');

select pg_temp.as_user((select ferro from ids));
select is((select likes from public.creator_dashboard() where listing_id = (select ferro_live from ids)), (select likes + 1 from base where id = (select ferro_live from ids)),
  'nor on the creator''s dashboard');
select is((select downloads from public.creator_dashboard() where listing_id = (select ferro_live from ids)), (select downloads + 1 from base where id = (select ferro_live from ids)),
  'downloads there too');

select pg_temp.as_user((select qa1 from ids));
select is((select likes from public.listing_stats(array[(select ferro_live from ids)])), (select likes + 2 from base where id = (select ferro_live from ids)),
  'the QA account sees its own like counted, as a member would');
select is((select downloads from public.listing_stats(array[(select ferro_live from ids)])), (select downloads + 2 from base where id = (select ferro_live from ids)),
  'and its own download');
select is((select makes from public.listing_stats(array[(select ferro_live from ids)])), (select makes + 1 from base where id = (select ferro_live from ids)),
  'and its own make');
select is((select followers from public.creator_followers(array[(select ferro_creator from ids)])), (select followers + 1 from base_followers where id = (select ferro_creator from ids)),
  'and its own follow');
select is((select count(*)::int from public.likes where user_id = (select qa1 from ids) and listing_id = (select ferro_live from ids)), 1, 'it reads its like');
select is((select count(*)::int from public.saved_listings() where listing_id = (select ferro_live from ids)), 1, 'and its save');

-- Trending ---------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select score from public.trending_listings(7, 100) where listing_id = (select ferro_live from ids)), 4::bigint,
  'trending counts the member''s like and download, not the QA account''s');
select is((select count(*)::int from public.trending_listings(7, 100) where listing_id = (select marrow_live from ids)), 0,
  'a design with only QA activity does not trend');
select is((select count(*)::int from public.trending_listings(7, 100) where listing_id = (select qa_live from ids)), 0,
  'a QA creator''s design does not trend, even with a member''s like');
select pg_temp.as_user((select qa1 from ids));
select is((select score from public.trending_listings(7, 100) where listing_id = (select ferro_live from ids)), 13::bigint,
  'the QA account sees its own activity ranked');
select is((select count(*)::int from public.trending_listings(7, 100) where listing_id = (select qa_live from ids)), 0,
  'another QA account does not see the QA design trend');
select pg_temp.as_user((select qa2 from ids));
select is((select score from public.trending_listings(7, 100) where listing_id = (select qa_live from ids)), 3::bigint,
  'its owner does');

-- The Library's featured design is the top of trending, else of most popular (the Feed's popular sort).
select pg_temp.as_anon();
select is((select count(*)::int from public.trending_listings(7, 100) t where not public.creator_listed((select creator_id from public.listings where id = t.listing_id))), 0,
  'nothing from a QA creator can be featured');

-- New creators ---------------------------------------------------------------------------------
select is((select count(*)::int from public.new_creators(30, 50) where creator_id = (select qa_creator from ids)), 0, 'a QA creator is not a new creator');
select is((select count(*)::int from public.new_creators(30, 50) where creator_id = (select rv_creator from ids)), 1, 'a member''s first design still makes them one');
select pg_temp.as_user((select qa2 from ids));
select is((select count(*)::int from public.new_creators(30, 50) where creator_id = (select qa_creator from ids)), 1, 'the QA creator sees itself there');

-- Based on your likes ------------------------------------------------------------------------------
select pg_temp.as_user((select ash from ids));
select is((select count(*)::int from public.recommended_listings(100) where listing_id = (select rv_live from ids)), 1, 'a design with tags ash liked is a pick');
select is((select count(*)::int from public.recommended_listings(100) where listing_id = (select qa_live from ids)), 0, 'the QA design with the same tags is not');

-- The Feed ----------------------------------------------------------------------------------------
select pg_temp.as_anon();
select is((select count(*)::int from public.library_listings where id = (select qa_live from ids)), 0, 'the Feed leaves out a QA creator''s design');
select is((select count(*)::int from public.library_listings where status = 'approved'), (select count(*)::int - 1 from public.listings where status = 'approved'),
  'and nothing else');
select is((select count(*)::int from public.listings where id = (select qa_live from ids)), 1, 'the design still opens by its address');
select is(public.listing_visible((select qa_live from ids)), true, 'and is public');
select pg_temp.as_user((select ash from ids));
select is((select count(*)::int from public.library_listings where id = (select qa_live from ids)), 0, 'a member does not see it in the Feed');
select pg_temp.as_user((select qa1 from ids));
select is((select count(*)::int from public.library_listings where id = (select qa_live from ids)), 0, 'nor does another QA account');
select pg_temp.as_user((select qa2 from ids));
select is((select count(*)::int from public.library_listings where id = (select qa_live from ids)), 1, 'its owner does');
select pg_temp.as_user((select ferro from ids));
select is((select count(*)::int from public.library_listings where creator_id = (select ferro_creator from ids)),
  (select count(*)::int from public.listings where creator_id = (select ferro_creator from ids)),
  'the Feed reads listings with the table''s visibility (a creator''s own pending ones too)');

-- Deleting the account removes the flag ------------------------------------------------------------
reset role;
delete from auth.users where id = (select qa1 from ids);
select is((select count(*)::int from public.qa_accounts where user_id = (select qa1 from ids)), 0, 'deleting a QA account removes its flag');

select * from finish();
rollback;
