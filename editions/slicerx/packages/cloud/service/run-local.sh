#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs sx-cloud for development. Heavy work belongs on the build machine, so
# run this there next to the stack.
#   run-local.sh            against the Supabase stack
#   run-local.sh --memory   no database; nothing is saved
# The edition config comes from SLICERX_CONFIG, or is resolved from
# editions/slicerx/edition.config.ts with cloud slicing switched on. The stack
# URL comes from SLICERX_SUPABASE_URL, or from `supabase status` when the stack
# runs on this machine. The service role key comes from SX_CLOUD_SERVICE_KEY,
# or from SERVICE_ROLE_KEY in ~/slicerx-db/.env.local on the build machine.
set -eu
root=$(cd "$(dirname "$0")/../../../../.." && pwd)
cd "$root"

if [ -z "${SLICERX_CONFIG:-}" ]; then
  SLICERX_CONFIG="${TMPDIR:-/tmp}/sx-cloud-edition.json"
  node packages/edition-config/src/cli.ts resolve editions/slicerx/edition.config.ts > "$SLICERX_CONFIG"
  export SLICERX_CONFIG
  export SLICERX_FEATURES="${SLICERX_FEATURES:-store,cloudSlicing}"
  export SLICERX_CLOUD_API_URL="${SLICERX_CLOUD_API_URL:-http://127.0.0.1:8787}"
fi

if [ "${1:-}" = "--memory" ]; then
  export SX_CLOUD_BACKEND=memory
  export SX_CLOUD_DEV_TOKEN="${SX_CLOUD_DEV_TOKEN:-sxk_local_dev}"
  echo "run-local: memory backend, token $SX_CLOUD_DEV_TOKEN" >&2
else
  if [ -f "$HOME/slicerx-db/.env.local" ]; then
    set -a
    . "$HOME/slicerx-db/.env.local"
    set +a
  fi
  if [ -z "${SLICERX_SUPABASE_URL:-}" ]; then
    dir="$root/editions/slicerx"
    [ -d "$dir/supabase" ] || dir="$root"
    status=$(cd "$dir" && supabase status -o env 2>/dev/null) || {
      echo "run-local: no stack found; set SLICERX_SUPABASE_URL, SLICERX_SUPABASE_ANON_KEY and SX_CLOUD_SERVICE_KEY" >&2
      exit 1
    }
    value() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p"; }
    SLICERX_SUPABASE_URL=$(value API_URL)
    SLICERX_SUPABASE_ANON_KEY=$(value ANON_KEY)
    SERVICE_ROLE_KEY=$(value SERVICE_ROLE_KEY)
    export SLICERX_SUPABASE_URL SLICERX_SUPABASE_ANON_KEY
  fi
  export SX_CLOUD_SERVICE_KEY="${SX_CLOUD_SERVICE_KEY:-${SERVICE_ROLE_KEY:-}}"
fi

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
exec nice -n 19 cargo run --release -p sx-cloud
