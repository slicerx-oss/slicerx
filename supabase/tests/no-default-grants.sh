#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs the database tests on a stack that gives the api roles no default privileges, like a
# hosted project created with "automatically expose new tables" off. The local stack grants
# anon, authenticated and service_role everything by default, which hides a missing grant.
#
# Usage: supabase/tests/no-default-grants.sh [work dir]
# Starts a second stack (project id slicerx-nogrants, ports 55320 to 55329) from a copy of
# supabase/ with one extra migration that runs first and takes the default privileges away,
# resets it, runs `supabase test db`, and stops it. Needs Docker and npx.
#
# SX_SUPABASE_CLI runs another Supabase CLI (CI passes the one it installed). SX_NOGRANTS_PROJECT and
# SX_NOGRANTS_PORTS (the first four digits of every port, default 5532) move the stack beside others.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=${1:-$(mktemp -d)}
cli=${SX_SUPABASE_CLI:-npx -y supabase@2.62.10}
project=${SX_NOGRANTS_PROJECT:-slicerx-nogrants}
ports=${SX_NOGRANTS_PORTS:-5532}
mkdir -p "$work"
rm -rf "$work/supabase"
cp -R "$here" "$work/supabase"
sed -i.bak -e "s/^project_id = .*/project_id = \"$project\"/" -e "s/= 5432\([0-9]\)/= $ports\1/" "$work/supabase/config.toml"
cat > "$work/supabase/migrations/0000_no_default_grants.sql" <<'SQL'
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
SQL
cd "$work"
$cli start -x studio,imgproxy,logflare,vector,edge-runtime,supavisor,realtime,inbucket >/dev/null
status=0
$cli db reset >/dev/null && $cli test db || status=$?
$cli stop --no-backup >/dev/null || true
exit $status
