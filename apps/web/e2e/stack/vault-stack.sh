#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# A throwaway stack for e2e/vault-flow.spec.ts: Supabase with its mail catcher,
# ClamAV, and the sx-cloud scan worker, on ports of their own so it never
# touches the development stack. Run it on the build machine, which needs
# Docker, the Supabase CLI and Rust.
#
#   vault-stack.sh start [app origin]   prints the environment the spec needs
#   vault-stack.sh stop
#
# The app origin (default http://127.0.0.1:4393) is added to the auth
# redirect allow-list, so magic links come back to the app under test.
set -eu
here=$(cd "$(dirname "$0")/../../../.." && pwd)
work=${SX_VAULT_STACK_DIR:-$HOME/.cache/sx-vault-stack}
cli="npx -y supabase@2.62.10"
case "${1:-}" in
start)
  origin=${2:-http://127.0.0.1:4393}
  mkdir -p "$work"
  rm -rf "$work/supabase"
  cp -R "$here/supabase" "$work/supabase"
  # Ports 5552x and a project id of its own; the mail catcher stays on.
  sed -i.bak -e 's/^project_id = .*/project_id = "slicerx-vault-e2e"/' -e 's/= 5432\([0-9]\)/= 5552\1/' \
    -e "s|^site_url = .*|site_url = \"$origin/studio/\"|" \
    -e "s|^additional_redirect_urls = \[|additional_redirect_urls = [\n  \"$origin/**\",|" "$work/supabase/config.toml"
  (cd "$work" && $cli start -x studio,imgproxy,logflare,vector,edge-runtime,supavisor,realtime >/dev/null && $cli db reset >/dev/null)
  status=$(cd "$work" && $cli status -o env)
  value() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p"; }
  url=$(value API_URL)
  anon=$(value ANON_KEY)
  service=$(value SERVICE_ROLE_KEY)
  mail=$(value INBUCKET_URL)
  [ -n "$mail" ] || mail=$(value MAILPIT_URL)
  # ClamAV takes a few minutes to load its signatures on the first start.
  if ! docker ps --format '{{.Names}}' | grep -q '^sx-vault-clamav$'; then
    docker rm -f sx-vault-clamav >/dev/null 2>&1 || true
    docker run -d --name sx-vault-clamav -p 127.0.0.1:3311:3310 clamav/clamav:stable >/dev/null
  fi
  i=0
  until docker exec sx-vault-clamav clamdscan --ping 1 >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 120 ] && { echo "clamd did not start" >&2; exit 1; }; sleep 5
  done
  # The scan worker: sx-cloud with the library scan on and the edition's store and cloud features.
  (cd "$here" && cargo build --release -p sx-cloud >/dev/null 2>&1)
  node "$here/packages/edition-config/src/cli.ts" resolve "$here/editions/slicerx/edition.config.ts" > "$work/edition.json"
  SLICERX_CONFIG="$work/edition.json" SLICERX_FEATURES=store,cloudSlicing SLICERX_CLOUD_API_URL=http://127.0.0.1:8797 \
    SLICERX_SUPABASE_URL="$url" SLICERX_SUPABASE_ANON_KEY="$anon" SX_CLOUD_SERVICE_KEY="$service" \
    SX_CLAMD_ADDR=127.0.0.1:3311 SX_CLOUD_BIND=127.0.0.1:8797 SX_CLOUD_PURGE_INTERVAL_S=0 \
    nohup "$here/target/release/sx-cloud" > "$work/sx-cloud.log" 2>&1 &
  echo $! > "$work/sx-cloud.pid"
  printf 'SX_E2E_SUPABASE_URL=%s\nSX_E2E_ANON_KEY=%s\nSX_E2E_SERVICE_KEY=%s\nSX_E2E_MAIL_URL=%s\n' "$url" "$anon" "$service" "$mail"
  ;;
stop)
  [ -f "$work/sx-cloud.pid" ] && kill "$(cat "$work/sx-cloud.pid")" 2>/dev/null || true
  rm -f "$work/sx-cloud.pid"
  docker rm -f sx-vault-clamav >/dev/null 2>&1 || true
  [ -d "$work/supabase" ] && (cd "$work" && $cli stop --no-backup >/dev/null) || true
  ;;
*)
  echo "usage: vault-stack.sh start [app origin] | stop" >&2
  exit 2
  ;;
esac
