#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# One package's `test` script, for the pull request job: a vitest package runs with one retry and the reporter that
# names tests which passed only on the retry; any other runner (jest, node --test) runs as its script says. Run it
# from every package:  pnpm -r exec bash scripts/ci/pr-test.sh   (see "Flaky tests" in scripts/ci/README.md)
set -euo pipefail
here=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
script=$(node -p "require('./package.json').scripts?.test ?? ''")
case $script in
  '') exit 0 ;;
  'vitest run'*) exec pnpm exec $script --retry=1 --reporter=default --reporter="$here/vitest-flaky-reporter.mjs" ;;
  *) exec pnpm run test ;;
esac
