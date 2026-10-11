#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# cargo test for a CI job, under the flaky rule the machine runs keep (see "Flaky tests" in scripts/ci/README.md):
#
#   scripts/ci/cargo-retry.sh <cargo test arguments...>
#
# Runs `cargo test --no-fail-fast <arguments>`. A passing run is done. A failing one gets a second look, as run.sh gives
# it: the failing tests that are not quarantined run once more by exact name, with the same arguments. A test that
# passes on the rerun is flaky: it is annotated and its name appended to the file in SX_FLAKY_OUT, and the job's
# `flaky-check.sh retried` step fails unless scripts/ci/flaky.d or quarantine.d lists it. A test that fails again fails
# the step. Quarantined failures (and flaky entries past their deadline) are not rerun and not failed on.
#
# Anything a rerun cannot tell apart from a real failure stays one: a compile error, a failure that is not a named test
# (a doc test, a crashed test binary, output that broke the "test <name> ... FAILED" line), or more than 15 failures.
# --no-fail-fast runs every test binary even after one fails, so a rerun by name never leaves another binary unrun; it
# changes nothing on a passing run.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${SX_FLAKY_OUT:-}
log=$(mktemp) rlog=$(mktemp)
trap 'rm -f "$log" "$rlog"' EXIT

cargo test --no-fail-fast "$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] && exit 0

names=$(sed -nE 's/^test ([^ ]+) \.\.\. FAILED\r?$/\1/p' "$log" | awk '!seen[$0]++')
count=$(sed -nE 's/^test result: FAILED\. [0-9]+ passed; ([0-9]+) failed;.*/\1/p' "$log" | awk '{ s += $1 } END { print s + 0 }')
n=0
[ -z "$names" ] || n=$(wc -l <<< "$names" | tr -d ' ')
if [ "$n" -eq 0 ] || [ "$n" -ne "$count" ] || [ "$n" -gt 15 ]; then
  echo "cargo-retry: $n named failing test(s) against $count counted failure(s): a real failure, not rerun" >&2
  exit "$rc"
fi

status() { bash "$here/flaky-check.sh" status "$1" 2> /dev/null || echo none; }
tried=()
while IFS= read -r t; do
  if [ "$(status "$t")" = quarantined ]; then echo "cargo-retry: quarantined, not rerun: $t" >&2
  else tried+=("$t"); fi
done <<< "$names"
[ "${#tried[@]}" -gt 0 ] || { echo "cargo-retry: every failure is quarantined" >&2; exit 0; }

# The test binaries' own arguments go after the first "--"; the exact names join them there.
sep=--
for a in "$@"; do [ "$a" = -- ] && sep=; done
echo "cargo-retry: rerunning ${#tried[@]} failing test(s) once by exact name: ${tried[*]}" >&2
cargo test --no-fail-fast "$@" $sep --exact "${tried[@]}" 2>&1 | tee "$rlog"
rrc=${PIPESTATUS[0]}
again=0
for t in "${tried[@]}"; do
  if grep -qxE "test $(sed 's/[][\.*^$+?(){}|/]/\\&/g' <<< "$t") \.\.\. ok\r?" "$rlog" && ! grep -qF "test $t ... FAILED" "$rlog"; then
    echo "::warning title=Flaky test::$t failed once and passed on the rerun"
    [ -z "$out" ] || echo "$t" >> "$out"
  else
    echo "cargo-retry: failed again: $t" >&2
    again=1
  fi
done
# A rerun that failed for any other reason (a build error, a test that is not one of the names) is a real failure too.
[ "$again" -eq 0 ] && [ "$rrc" -eq 0 ] || exit 1
echo "cargo-retry: every failing test passed on the rerun (flaky; flaky-check.sh retried checks the lists)" >&2
exit 0
