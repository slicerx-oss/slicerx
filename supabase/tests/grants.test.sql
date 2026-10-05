-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Table privileges of the api roles match the row level security policies (pgTAP). The hosted
-- project gives anon and authenticated no default privileges, the local stack gives them all,
-- and both must end the same: a role holds a command on a table exactly where a policy lets it
-- through. Run with `supabase test db`, and with tests/no-default-grants.sh for a stack
-- without default privileges.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Every command a policy allows a role is granted to it (on the table or on some columns).
create temp table wanted on commit drop as
select distinct p.tablename::text as tbl, r.role::text as role, c.cmd
from pg_policies p
cross join lateral unnest(p.roles) as r(role)
cross join lateral unnest(case p.cmd when 'ALL' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] else array[p.cmd] end) as c(cmd)
where p.schemaname = 'public' and r.role in ('anon', 'authenticated');

select is(
  (select coalesce(string_agg(format('%s %s %s', role, cmd, tbl), ', ' order by tbl, role, cmd), '')
   from wanted w
   where not case w.cmd
     when 'DELETE' then has_table_privilege(w.role, format('public.%I', w.tbl), w.cmd)
     else has_any_column_privilege(w.role, format('public.%I', w.tbl), w.cmd)
   end),
  '', 'every command a policy allows is granted');

-- And nothing beyond: a table command a role holds has a policy behind it.
select is(
  (select coalesce(string_agg(format('%s %s %s', g.grantee, g.privilege_type, g.table_name), ', ' order by g.table_name, g.grantee), '')
   from (
     select grantee, table_name, privilege_type from information_schema.role_table_grants
     where table_schema = 'public'
     union
     select grantee, table_name, privilege_type from information_schema.column_privileges
     where table_schema = 'public'
   ) g
   join pg_class t on t.relname = g.table_name and t.relnamespace = 'public'::regnamespace and t.relkind = 'r'
   where g.grantee in ('anon', 'authenticated')
     and g.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
     and not exists (select 1 from wanted w where w.tbl = g.table_name and w.role = g.grantee and w.cmd = g.privilege_type)),
  '', 'no table command is granted without a policy');

select is(
  (select coalesce(string_agg(format('%s %s', r, t), ', '), '')
   from unnest(array['anon', 'authenticated']) r,
        unnest(array['api_token_usage', 'storage_cleanup', 'download_secret', 'anon_download_usage', 'anon_downloads', 'download_grants']) t
   where has_any_column_privilege(r, format('public.%I', t), 'SELECT, INSERT, UPDATE')
      or has_table_privilege(r, format('public.%I', t), 'DELETE, TRUNCATE')),
  '', 'service tables have no client access');

select ok(not has_any_column_privilege('anon', 'public.listing_files', 'INSERT, UPDATE')
  and not has_any_column_privilege('authenticated', 'public.listing_files', 'INSERT, UPDATE')
  and not has_table_privilege('authenticated', 'public.listing_files', 'DELETE'),
  'only the scan service writes file manifests');
select ok(not has_table_privilege('authenticated', 'public.sync_profiles', 'DELETE')
  and not has_table_privilege('authenticated', 'public.sync_printers', 'DELETE')
  and not has_table_privilege('authenticated', 'public.sync_fleets', 'DELETE'),
  'synced rows are never deleted by clients');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.profiles', 'banned_at', 'UPDATE')
  and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'),
  'members edit their name, never their role or ban');
select ok(has_sequence_privilege('authenticated', 'public.sync_revision_seq', 'USAGE')
  and not has_sequence_privilege('anon', 'public.sync_revision_seq', 'USAGE'),
  'members stamp synced rows; visitors cannot');
select ok(has_function_privilege('anon', 'public.listing_stats(uuid[])', 'EXECUTE')
  and has_function_privilege('anon', 'public.creator_followers(uuid[])', 'EXECUTE')
  and has_function_privilege('anon', 'public.listing_visible(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.can_upload_quarantine(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.can_download(text)', 'EXECUTE'),
  'the store functions and policy helpers are callable');
select ok(not has_function_privilege('anon', 'public.resolve_api_token(text, inet, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_cloud_job(text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.grant_cloud_access(text, integer, integer, text)', 'EXECUTE'),
  'service functions stay with the service role');

select * from finish();
rollback;
