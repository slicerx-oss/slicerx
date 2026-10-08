#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Refuses unless a commit has every required CI check green. A red main blocks every release bump.
#
#   scripts/ci/require-green.sh [--dry-run] <commit> [repo]
#
# Reads the commit's check-runs from GitHub (gh api, read only) and requires each check in required-checks.txt to be
# success or skipped. A check that is still running, or has not appeared yet, is waited for up to
# SX_GREEN_WAIT seconds (default 600), then counts as not green. If a check was run more than once, the latest run
# counts. Exit 0 when green, 1 when not, 2 on usage or API errors.
#   --dry-run                  report each check and the verdict, and exit 0 either way
#   SX_PUBLISH_ALLOW_RED=1     owner-approved emergency only: prints a loud warning and lets a red commit through
#   SX_GREEN_WAIT=<seconds>    how long to wait for pending or missing checks
#   SX_GREEN_POLL=<seconds>    poll interval while waiting (default 20)
#   SX_REQUIRED_CHECKS=<file>  another list (default: required-checks.txt next to this script)
set -uo pipefail

dry=0
if [ "${1:-}" = --dry-run ]; then dry=1; shift; fi
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: require-green.sh [--dry-run] <commit> [owner/repo]" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
list=${SX_REQUIRED_CHECKS:-$here/required-checks.txt}
sha=$(git -C "$here" rev-parse --verify "$1^{commit}" 2>/dev/null) || { echo "require-green: unknown commit $1" >&2; exit 2; }
slug=${2:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}
[ -n "$slug" ] || { echo "require-green: cannot tell the repository (gh repo view failed)" >&2; exit 2; }
wait=${SX_GREEN_WAIT:-600}; poll=${SX_GREEN_POLL:-20}
required=$(grep -vE '^\s*(#|$)' "$list" | sed 's/[[:space:]]*$//')
[ -n "$required" ] || { echo "require-green: no required checks in $list" >&2; exit 2; }

# name <TAB> status <TAB> conclusion, latest run per name
fetch() {
  gh api --paginate "repos/$slug/commits/$sha/check-runs?per_page=100" \
    --jq '.check_runs[] | [.id, .name, .status, (.conclusion // "")] | @tsv' \
    | sort -n | awk -F'\t' '{ r[$2] = $3 "\t" $4 } END { for (n in r) print n "\t" r[n] }'
}

evaluate() { # sets bad (lines) and pending (count)
  bad=""; pending=0
  while IFS= read -r name; do
    row=$(awk -F'\t' -v n="$name" '$1 == n { print $2 "\t" $3 }' <<< "$runs")
    status=${row%%$'\t'*}; concl=${row#*$'\t'}
    if [ -z "$row" ]; then bad+="  $name: missing"$'\n'; pending=$((pending + 1))
    elif [ "$status" != completed ]; then bad+="  $name: $status"$'\n'; pending=$((pending + 1))
    elif [ "$concl" = success ] || [ "$concl" = skipped ]; then :
    else bad+="  $name: $concl"$'\n'
    fi
  done <<< "$required"
}

waited=0
while :; do
  runs=$(fetch) || { echo "require-green: gh api failed for $slug@${sha:0:8}" >&2; exit 2; }
  evaluate
  # wait only while something could still turn green; a finished failure ends it at once
  [ -z "$bad" ] && break
  [ "$dry" = 1 ] && break
  [ "$pending" -gt 0 ] && [ "$waited" -lt "$wait" ] || break
  [ "$waited" = 0 ] && echo "require-green: waiting for checks on ${sha:0:8} (up to ${wait}s)" >&2
  sleep "$poll"; waited=$((waited + poll))
done

if [ -z "$bad" ]; then echo "require-green: ${sha:0:8} has every required check green"; exit 0; fi
{
  echo "require-green: ${sha:0:8} is NOT green. Required checks failing, pending or missing:"
  printf '%s' "$bad"
} >&2
if [ "$dry" = 1 ]; then echo "require-green: dry run, nothing refused" >&2; exit 0; fi
if [ "${SX_PUBLISH_ALLOW_RED:-}" = 1 ]; then
  echo "require-green: *** SX_PUBLISH_ALLOW_RED=1: CONTINUING WITH A RED COMMIT. Owner-approved emergencies only. ***" >&2
  exit 0
fi
echo "require-green: refusing. Fix main and release from a green commit (SX_PUBLISH_ALLOW_RED=1 is for an owner-approved emergency only)." >&2
exit 1
