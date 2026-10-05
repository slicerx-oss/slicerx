-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- projects created without "automatically expose new tables" give the api roles no
-- table privileges. the cloud service talks to the database as service_role, which
-- bypasses rls but still needs plain grants. anon and authenticated keep only the
-- grants the earlier migrations give them.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
