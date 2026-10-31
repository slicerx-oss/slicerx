#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Notes how a Playwright run step ended, so the step goes on to the results step, or fails here when the results step
# would have nothing to read.
#   bash scripts/ci/run-exit.sh <exit status> <report.json>
# Status 75 is heavy.sh giving up on the machine's heavy lock (SX_HEAVY_WAIT) before the run started: no tests ran and
# no report was written. It leaves <report.json>.gave-up, which playwright-results.mjs reads to fail with that reason
# instead of a missing report.
# Status 124 is the run's own time limit (timeout SX_RUN_TIMEOUT, or heavy.sh's max hold): the run was stopped before
# Playwright wrote its report, so the step fails here with that reason, and the results step is not left to fail later
# on a missing report.
rc=$1
report=$2
echo "playwright exited $rc"
if [ "$rc" = 75 ]; then
  echo "::error title=Heavy lock::Gave up waiting for the heavy lock after ${SX_HEAVY_WAIT:-?} s; no tests ran."
  [ -n "$report" ] && echo 75 > "$report.gave-up"
elif [ "$rc" = 124 ]; then
  echo "::error title=Timed out::The run timed out${SX_RUN_TIMEOUT:+ after $SX_RUN_TIMEOUT s} and was stopped before it wrote its report. The tests that finished are in the log above."
  exit 124
fi
exit 0
