#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# The test files that replay recorded geometry engine replies (useGeomEngine), run with no engine: SX_GEOM_REPLAY=1
# makes every test replay its fixture and the live-only ones skip. The web job builds the engine and runs these tests
# live, so it never reads the fixtures; a change that alters the engine calls a test makes without recording it again
# fails here instead of on the next machine without an engine. Run it from the repository root:
#   bash scripts/ci/replay-fixtures.sh
set -euo pipefail
root=$(git rev-parse --show-toplevel)
export SX_GEOM_REPLAY=1
rc=0
for pkg in packages/app packages/mcp; do
  # shellcheck disable=SC2207
  files=($(cd "$root/$pkg" && git grep -l 'useGeomEngine(' -- 'test/*.test.ts' 'test/*.test.tsx' || true))
  [ ${#files[@]} -eq 0 ] && continue
  echo "replay-fixtures: $pkg, ${#files[@]} files"
  (cd "$root/$pkg" && bash "$root/scripts/ci/pr-test.sh" "${files[@]}") || rc=1
done
exit "$rc"
