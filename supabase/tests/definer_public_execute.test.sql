-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- No security definer function in public is open to PUBLIC, so the narrow roles reach only
-- the functions granted to them (pgTAP). Run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '') from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
     and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))),
  '', 'no security definer function lets PUBLIC execute it');

select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '') from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and has_function_privilege('listing_reviewer', p.oid, 'EXECUTE') and p.proname not like 'external\_review\_%' and p.proname <> 'review_listing_external'),
  '', 'the listing reviewer can run only the external review functions');

select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '') from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and has_function_privilege('mimir_session_reader', p.oid, 'EXECUTE') and p.proname not like 'mimir\_reader\_%'),
  '', 'the mimir session reader can run only the reader functions');

-- the api roles still reach what they use
select ok(has_function_privilege('anon', 'public.listing_visible(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.my_role()', 'EXECUTE'),
  'anon and authenticated keep the functions they use');

select * from finish();
rollback;
