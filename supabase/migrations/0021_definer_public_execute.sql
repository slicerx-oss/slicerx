-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Postgres lets PUBLIC execute every new function, so each narrow role the project adds
-- (listing_reviewer, mimir_session_reader) could call every security definer function that
-- never revoked it. This takes PUBLIC off them. The api roles keep exactly what they could
-- run before: a role that reached a function only through PUBLIC gets its own grant first.
-- New definer functions revoke PUBLIC themselves; tests/definer_public_execute.test.sql
-- fails on any that does not.
do $$
declare
  f regprocedure;
  r text;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        execute format('grant execute on function %s to %I', f, r);
      end if;
    end loop;
    execute format('revoke execute on function %s from public', f);
  end loop;
end;
$$;
