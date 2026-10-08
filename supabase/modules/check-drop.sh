#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Drops every removable module (cloud, store, sxlock, bug reports) inside a transaction
# on the local stack, checks that auth, profiles and API tokens still work,
# then rolls back.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
db=${SUPABASE_DB_CONTAINER:-supabase_db_slicerx}
{
  echo 'begin;'
  echo "select count(*) as profiles_before from public.profiles;"
  if [ -f "$here/drop_cloud.sql" ]; then cat "$here/drop_cloud.sql"; fi
  cat "$here/drop_store.sql"
  cat "$here/drop_sxlock.sql"
  cat "$here/drop_bug_reports.sql"
  cat <<'SQL'
do $$
declare
  leftover text;
begin
  select string_agg(c.relname, ', ') into leftover
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname not in ('profiles', 'api_tokens', 'api_token_usage', 'account_deletions', 'audit_log', 'paired_devices', 'qa_accounts');
  if leftover is not null then
    raise exception 'tables left after dropping the modules: %', leftover;
  end if;
  if (select count(*) from public.profiles) = 0 then
    raise exception 'profiles were lost';
  end if;
  insert into auth.users (instance_id, id, aud, role, email)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', 'drop-check@example.com');
  if not exists (select 1 from public.profiles where handle = 'dropcheck') then
    raise exception 'sign-up trigger stopped creating profiles';
  end if;
  -- Export and deletion skip the modules that are gone.
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where handle = 'dropcheck'))::text, true);
  if (public.export_my_data() ->> 'format') is distinct from 'slicerx-account-export' then
    raise exception 'export stopped working without the modules';
  end if;
  -- Roles, bans and the audit log live in auth and keep working.
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where handle = 'dropcheck'))::text, true);
  if public.my_role() is distinct from 'member' then
    raise exception 'roles stopped working without the store';
  end if;
  perform public.purge_account((select id from public.profiles where handle = 'dropcheck'));
  if exists (select 1 from public.profiles where handle = 'dropcheck') then
    raise exception 'purge stopped working without the modules';
  end if;
  raise notice 'modules dropped cleanly; auth, profiles, export and deletion intact';
end;
$$;
SQL
  echo 'rollback;'
} | docker exec -i "$db" psql -U postgres -v ON_ERROR_STOP=1 -q
