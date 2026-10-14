#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# One package's `test` script, for the pull request job: a vitest package runs with one retry and the reporter that
# names tests which passed only on the retry and tests which failed on every try; any other runner (jest, node --test)
# runs as its script says. Run it from every package:  pnpm -r exec bash scripts/ci/pr-test.sh
# A failing vitest run passes only when the reporter named every failure as a test and each one counts as quarantined
# (`flaky-check.sh failed`). A failure it cannot name, or an error outside any test, stays a failure.
# See "Flaky tests" in scripts/ci/README.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
script=$(node -p "require('./package.json').scripts?.test ?? ''")
case $script in
  '') exit 0 ;;
  'vitest run'*) ;;
  *) exec pnpm run test ;;
esac

failed=$(mktemp)
trap 'rm -f "$failed"' EXIT
failed_out=$failed
command -v cygpath > /dev/null 2>&1 && failed_out=$(cygpath -w "$failed")
rc=0
# shellcheck disable=SC2086
SX_FAILED_OUT=$failed_out pnpm exec $script --retry=1 --reporter=default --reporter="$here/vitest-flaky-reporter.mjs" || rc=$?
[ "$rc" -eq 0 ] && exit 0
if [ ! -s "$failed" ]; then
  echo "pr-test: vitest failed (exit $rc) and named no failed test, so no list can excuse it" >&2
  exit "$rc"
fi
if bash "$here/flaky-check.sh" failed "$failed"; then
  echo "pr-test: every failure is quarantined; counted, not failed on (vitest exit $rc)"
  exit 0
fi
exit "$rc"
