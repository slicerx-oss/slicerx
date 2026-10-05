#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Smoke test for a deployed sx-cloud: health, about, the caller's invite,
# then a 20 mm cube uploaded, sliced and its G-code fetched and checked
# against the hash the service reports.
#
#   SX_CLOUD_TOKEN="$(security find-generic-password -s slicerx-cloud-smoke -w)" \
#     editions/slicerx/packages/cloud/service/smoke.sh https://slicerx-cloud.fly.dev
#
# The token (an sxk_ token with the cloud_slice scope, for an invited account)
# comes from the environment and reaches curl on stdin, so it never shows in
# the process list and is never written to disk. Needs curl, python3, shasum.
set -eu
base=${1:?usage: SX_CLOUD_TOKEN=... smoke.sh <service url>}
base=${base%/}
: "${SX_CLOUD_TOKEN:?set SX_CLOUD_TOKEN to an sxk_ token with the cloud_slice scope}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# curl with the bearer header passed as a config on stdin.
call() {
  printf 'header = "Authorization: Bearer %s"\n' "$SX_CLOUD_TOKEN" | curl -sS -K - "$@"
}
field() {
  python3 -c 'import json,sys; v=json.load(sys.stdin)
for k in sys.argv[1].split("."): v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else v)' "$1"
}
step() { printf '%s\n' "smoke: $*"; }
fail() { printf '%s\n' "smoke: FAILED: $*" >&2; exit 1; }

[ "$(curl -sS "$base/healthz")" = ok ] || fail "/healthz did not answer ok"
step "healthz ok"
about=$(curl -sS "$base/v1/about")
step "about: $(printf '%s' "$about" | field name) $(printf '%s' "$about" | field version), source $(printf '%s' "$about" | field sourceUrl)"

access=$(call "$base/v1/access")
[ "$(printf '%s' "$access" | field invited)" = True ] || fail "this account is not invited: $access"
step "invited: $(printf '%s' "$access" | field jobsToday) of $(printf '%s' "$access" | field jobsPerDay) jobs used today, uploads up to $(printf '%s' "$access" | field maxUploadBytes) bytes"

# A 20 mm cube as binary STL.
python3 - "$tmp/cube.stl" <<'EOF'
import struct, sys
s = 20.0
v = [(0,0,0),(s,0,0),(s,s,0),(0,s,0),(0,0,s),(s,0,s),(s,s,s),(0,s,s)]
faces = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]
with open(sys.argv[1], 'wb') as f:
    f.write(b'smoke cube'.ljust(80, b' '))
    f.write(struct.pack('<I', len(faces)))
    for a, b, c in faces:
        f.write(struct.pack('<3f', 0, 0, 0))
        for i in (a, b, c):
            f.write(struct.pack('<3f', *v[i]))
        f.write(b'\0\0')
EOF
sha=$(shasum -a 256 "$tmp/cube.stl" | cut -d' ' -f1)
code=$(call -o "$tmp/up.json" -w '%{http_code}' -X PUT --data-binary "@$tmp/cube.stl" "$base/v1/meshes/$sha")
[ "$code" = 201 ] || fail "mesh upload answered $code: $(cat "$tmp/up.json")"
step "uploaded mesh $sha"

cat > "$tmp/job.json" <<EOF
{"name":"Smoke test","request":{"schemaVersion":1,"plate":{"objects":[{"id":"cube","name":"Cube","mesh":"$sha"}]},"config":{"layer_height":0.2}}}
EOF
job=$(call -X POST -H 'content-type: application/json' --data-binary "@$tmp/job.json" "$base/v1/jobs")
id=$(printf '%s' "$job" | field id)
[ -n "$id" ] || fail "the job was not queued: $job"
step "queued job $id"

started=$(date +%s)
while :; do
  job=$(call "$base/v1/jobs/$id")
  status=$(printf '%s' "$job" | field status)
  case $status in
    succeeded) break ;;
    failed | canceled) fail "job $status: $(printf '%s' "$job" | field error)" ;;
  esac
  [ $(( $(date +%s) - started )) -lt 600 ] || fail "job still $status after 10 minutes"
  sleep 2
done
step "sliced in $(( $(date +%s) - started )) s"

want=$(printf '%s' "$job" | field result.gcodeSha256)
code=$(call -o "$tmp/slice.gcode" -w '%{http_code}' "$base/v1/jobs/$id/gcode")
[ "$code" = 200 ] || fail "G-code download answered $code"
got=$(shasum -a 256 "$tmp/slice.gcode" | cut -d' ' -f1)
[ -z "$want" ] || [ "$got" = "$want" ] || fail "G-code hash $got does not match the reported $want"
step "G-code $(wc -c < "$tmp/slice.gcode" | tr -d ' ') bytes, hash checked"
step "all passed"
