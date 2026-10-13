#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs integration.mjs: the local stack with the edge runtime, the mimir function served
# against a fake provider, then stops what it started. Needs the supabase CLI, docker
# and node. MOCK_PORT moves the fake provider.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
cd "$root"
port=${MOCK_PORT:-54399}
env_file=$(mktemp)
trap 'rm -f "$env_file"; [ -n "${serve_pid:-}" ] && kill "$serve_pid" 2>/dev/null || true' EXIT
cat > "$env_file" <<ENV
ANTHROPIC_API_KEY=sk-ant-integration
MIMIR_UPSTREAM=${MIMIR_UPSTREAM:-http://host.docker.internal:$port}
ENV
supabase start -x studio,imgproxy,logflare,vector,supavisor,realtime,mailpit,postgres-meta > /dev/null
supabase functions serve mimir --env-file "$env_file" > "${TMPDIR:-/tmp}/mimir-serve.log" 2>&1 &
serve_pid=$!
api=$(supabase status -o env | sed -n 's/^API_URL="\(.*\)"$/\1/p')
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$api/functions/v1/mimir/nope" || true)
  [ "$code" = 404 ] && break
  sleep 1
done
MIMIR_FN="$api/functions/v1/mimir" MOCK_PORT=$port node "$here/integration.mjs"
