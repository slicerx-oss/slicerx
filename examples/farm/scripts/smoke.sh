#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Smoke test: slices the CLI test cube with the farm tool (through sx) and with the C example
# (through libslicerx), checks that each wrote G-code, a preview and a result, and that both agree.
# Usage: examples/farm/scripts/smoke.sh   (builds sx and libslicerx in release mode first)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
cargo build -q --release -p sx-cli
farm_slice=$(sh "$here/c/build.sh")
work=$(mktemp -d "${TMPDIR:-/tmp}/sx-farm-smoke.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/models" "$work/c-out"
cp packages/core/cli/tests/fixtures/cube.stl "$work/models/test-cube.stl"
printf '{"layer_height": 0.2, "wall_loops": 2, "sparse_infill_density": 15}\n' > "$work/config.json"

node "$here/src/farm.ts" "$work/models" --out "$work/out" --config "$work/config.json" --sx "$root/target/release/sx"
"$farm_slice" "$work/models/test-cube.stl" "$work/c-out" "$work/config.json"

for d in "$work/out/test-cube" "$work/c-out"; do
  for f in slice.gcode slice.sxpv result.json; do
    test -s "$d/$f" || { echo "missing $d/$f"; exit 1; }
  done
  head -c 4 "$d/slice.sxpv" | grep -q SXPV || { echo "$d/slice.sxpv is not an SXPV preview"; exit 1; }
done
node -e '
const fs = require("node:fs")
const [a, b] = process.argv.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
if (!(a.layerCount > 0) || a.layerCount !== b.layerCount) {
  console.error(`layer counts differ: CLI ${a.layerCount}, C ABI ${b.layerCount}`)
  process.exit(1)
}
console.log(`smoke ok: ${a.layerCount} layers from the CLI and from the C ABI`)
' "$work/out/test-cube/result.json" "$work/c-out/result.json"
