#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Refuses unless a commit has every required CI check green. A red main blocks every release bump.
#
#   scripts/ci/require-green.sh [--dry-run] <commit> [repo]
#
# Reads the commit's check-runs from GitHub (read only) and requires each check in required-checks.txt to be
# success or skipped. A check that is still running, or has not appeared yet, is waited for up to
# SX_GREEN_WAIT seconds (default 3600: a push to main takes 35 to 43 minutes to turn every required check green), then
# counts as not green. If a check was run more than once, the latest run
# counts. Exit 0 when green, 1 when not, 2 on usage or API errors.
# The read goes through gh api when gh is installed and works. When gh is missing, fails, or SX_GREEN_GH=0, it
# reads api.github.com anonymously with curl (a public repository needs no sign-in; the JSON is parsed with node) and
# says so once on stderr. Anonymous reads are limited to 60 per hour, so in that mode each wait spreads the reads
# GitHub says are left (keeping 10 spare for other readers) over the time to its reset: between 20 and 300 s, or until
# the reset when none are spare, and 300 s when the reply has no rate limit headers. SX_GREEN_POLL overrides it. A 403
# or 429 reply is an API error (exit 2).
#   --dry-run                  report each check and the verdict, and exit 0 either way
#   SX_PUBLISH_ALLOW_RED=1     owner-approved emergency only: prints a loud warning and lets a red commit through
#   SX_GREEN_WAIT=<seconds>    how long to wait for pending or missing checks
#   SX_GREEN_POLL=<seconds>    poll interval while waiting (default 20, or paced by the rate limit when anonymous)
#   SX_GREEN_GH=0              skip gh and read anonymously
#   SX_REQUIRED_CHECKS=<file>  another list (default: required-checks.txt next to this script)
set -uo pipefail

dry=0
if [ "${1:-}" = --dry-run ]; then dry=1; shift; fi
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: require-green.sh [--dry-run] <commit> [owner/repo]" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
list=${SX_REQUIRED_CHECKS:-$here/required-checks.txt}
sha=$(git -C "$here" rev-parse --verify "$1^{commit}" 2>/dev/null) || { echo "require-green: unknown commit $1" >&2; exit 2; }
gh_ok=0
if [ "${SX_GREEN_GH:-}" != 0 ] && command -v gh > /dev/null 2>&1; then gh_ok=1; fi
slug=${2:-}
[ -z "$slug" ] && [ "$gh_ok" = 1 ] && slug=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$slug" ]; then # github.com/owner/repo from the origin URL (https or ssh form)
  slug=$(git -C "$here" remote get-url origin 2>/dev/null | sed -E 's#/+$##; s#\.git$##' \
    | sed -nE 's#^.*github\.com[:/]+([^/]+/[^/]+)$#\1#p' | head -n 1)
fi
[ -n "$slug" ] || { echo "require-green: cannot tell the repository (pass owner/repo)" >&2; exit 2; }
wait=${SX_GREEN_WAIT:-3600}; poll=${SX_GREEN_POLL:-20}
required=$(grep -vE '^\s*(#|$)' "$list" | sed 's/[[:space:]]*$//')
[ -n "$required" ] || { echo "require-green: no required checks in $list" >&2; exit 2; }

# Parses one raw curl -i reply on stdin. Line 1: http status, requests left, reset (epoch seconds), next page URL.
# Then id, name, status, conclusion rows. Status 0 means the reply was not a check-runs page.
parse_page='
const s = require("fs").readFileSync(0, "utf8");
let rest = s, head = "";
while (/^HTTP\/\S+ \d+/.test(rest)) {
  const m = rest.search(/\r?\n\r?\n/);
  if (m < 0) { head = rest; rest = ""; break; }
  head = rest.slice(0, m); rest = rest.slice(m).replace(/^\r?\n\r?\n/, "");
}
const status = Number((/^HTTP\/\S+ (\d+)/.exec(head) || [0, 0])[1]);
const next = (/<([^>]+)>;\s*rel="next"/.exec(head) || [0, ""])[1];
const left = (/^x-ratelimit-remaining:\s*(\d+)/im.exec(head) || [0, ""])[1];
const reset = (/^x-ratelimit-reset:\s*(\d+)/im.exec(head) || [0, ""])[1];
let rows = [];
let ok = status === 200;
if (ok) {
  try { rows = JSON.parse(rest).check_runs.map((r) => [r.id, r.name, r.status, r.conclusion || ""].join("\t")); }
  catch (e) { ok = false; }
}
console.log([ok ? status : (status === 200 ? 0 : status), left || "-", reset || "-", next].join("\t"));
if (ok && rows.length) console.log(rows.join("\n"));
'

# Sets runs: name <TAB> status <TAB> conclusion, latest run per name. Returns 1 on an API error.
latest() { sort -n | awk -F'\t' '{ r[$2] = $3 "\t" $4 } END { for (n in r) print n "\t" r[n] }'; }

fetch_gh() {
  local out
  out=$(gh api --paginate "repos/$slug/commits/$sha/check-runs?per_page=100" \
    --jq '.check_runs[] | [.id, .name, .status, (.conclusion // "")] | @tsv' 2>/dev/null) || return 1
  runs=$(latest <<< "$out")
}

anon_left=""; anon_reset=""; anon_pages=1 # from the last anonymous read, for pace
fetch_anon() {
  local url="https://api.github.com/repos/$slug/commits/$sha/check-runs?per_page=100" pages=0 raw parsed meta status left reset all=""
  while [ -n "$url" ]; do
    pages=$((pages + 1))
    [ "$pages" -le 30 ] || { echo "require-green: more than 30 pages of check runs for $slug@${sha:0:8}" >&2; return 1; }
    raw=$(curl -sS -i -H "User-Agent: slicerx-require-green" -H "Accept: application/vnd.github+json" "$url") \
      || { echo "require-green: curl failed reading $url" >&2; return 1; }
    parsed=$(node -e "$parse_page" <<< "$raw") || { echo "require-green: node could not read the GitHub reply" >&2; return 1; }
    meta=${parsed%%$'\n'*}
    # read collapses empty tab fields, so the fields that can be missing are "-" and the page URL comes last
    IFS=$'\t' read -r status left reset url <<< "$meta"
    anon_left=${left#-}; anon_reset=${reset#-}
    case "$status" in
      200) ;;
      403|429) echo "require-green: GitHub refused the anonymous read (HTTP $status, rate limit or access). Anonymous reads are limited to 60 per hour; wait and retry, or sign in gh." >&2; return 1 ;;
      *) echo "require-green: GitHub answered HTTP $status reading check runs for $slug@${sha:0:8}" >&2; return 1 ;;
    esac
    case "$url" in https://api.github.com/*) ;; *) url="" ;; esac
    [ "$parsed" = "$meta" ] || all+="${parsed#*$'\n'}"$'\n'
  done
  anon_pages=$pages
  runs=$(printf '%s' "$all" | grep . | latest)
}

# Anonymous and no SX_GREEN_POLL: spread the reads left, less 10 spare, over the time to the reset, one read per page.
pace() {
  [ "$fallback" = 1 ] && [ -z "${SX_GREEN_POLL:-}" ] && [ -n "$anon_left" ] && [ -n "$anon_reset" ] || return 0
  local secs spare
  secs=$((anon_reset - $(date +%s))); [ "$secs" -gt 0 ] || secs=1
  spare=$((anon_left - 10))
  if [ "$spare" -le 0 ]; then poll=$((secs + 1)); return 0; fi
  poll=$(((secs * anon_pages + spare - 1) / spare))
  [ "$poll" -ge 20 ] || poll=20
  [ "$poll" -le 300 ] || poll=300
}

fallback=0
fetch() {
  if [ "$gh_ok" = 1 ]; then
    fetch_gh && return 0
    gh_ok=0
  fi
  if [ "$fallback" = 0 ]; then
    fallback=1
    echo "require-green: gh unavailable, reading check runs anonymously" >&2
    [ -n "${SX_GREEN_POLL:-}" ] || poll=300
  fi
  fetch_anon
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
  fetch || { echo "require-green: could not read check runs for $slug@${sha:0:8}" >&2; exit 2; }
  evaluate
  # wait only while something could still turn green; a finished failure ends it at once
  [ -z "$bad" ] && break
  [ "$dry" = 1 ] && break
  [ "$pending" -gt 0 ] && [ "$waited" -lt "$wait" ] || break
  [ "$waited" = 0 ] && echo "require-green: waiting for checks on ${sha:0:8} (up to ${wait}s)" >&2
  pace
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
