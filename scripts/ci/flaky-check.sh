#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# The flaky-test lists and the checks on them. See "Flaky tests" in scripts/ci/README.md.
#
#   flaky-check.sh lint                  fail on any entry without an owner, a valid date or an issue link
#   flaky-check.sh status <test name>    print quarantined, flaky or none for a failing test
#   flaky-check.sh report                list both files with ages and deadlines; overdue flaky entries are marked
#   flaky-check.sh retried <file>        fail when a test named in <file> (one per line) passed only on a retry and
#                                        is on neither list
#
# flaky.txt:      name | owner | added | deadline | issue | why     (deadline: at most a day after added)
# quarantine.txt: name | owner | added | issue | why
# A name is a substring of the test name as the run reports it. A flaky entry whose deadline has passed counts as
# quarantined from the next day on (status prints quarantined, report marks it overdue), so an unfixed flake stops
# failing runs without anyone editing a file, and still shows in every report until someone fixes it.
# FLAKY_DIR picks another directory for the two files; FLAKY_TODAY (YYYY-MM-DD) replaces today's date.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
dir=${FLAKY_DIR:-$here}
today=${FLAKY_TODAY:-$(date +%F)}
max_days=${SX_FLAKY_MAX_DAYS:-1}
issue_re='^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+$'
date_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'

# Whole days from date $1 to date $2 (both YYYY-MM-DD), without GNU or BSD date options.
days_between() {
  awk -v a="$1" -v b="$2" '
    function jd(s,  y, m, d) {
      y = substr(s, 1, 4) + 0; m = substr(s, 6, 2) + 0; d = substr(s, 9, 2) + 0
      if (m <= 2) { y--; m += 12 }
      return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d
    }
    BEGIN { print jd(b) - jd(a) }'
}
valid_date() { # shape and a plausible calendar day
  [[ $1 =~ $date_re ]] || return 1
  local m=${1:5:2} d=${1:8:2}
  [ $((10#$m)) -ge 1 ] && [ $((10#$m)) -le 12 ] && [ $((10#$d)) -ge 1 ] && [ $((10#$d)) -le 31 ]
}
trim() { local s=$1; s=${s#"${s%%[![:space:]]*}"}; s=${s%"${s##*[![:space:]]}"}; printf '%s' "$s"; }

# entries <file>: the non-comment lines
entries() { [ -f "$1" ] && grep -vE '^\s*(#|$)' "$1" || true; }

errors=0
err() { echo "flaky-check: $*" >&2; errors=$((errors + 1)); }

lint() {
  local line n f name owner added deadline issue why
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS='|' read -r name owner added issue why <<< "$line"
    name=$(trim "$name"); owner=$(trim "$owner"); added=$(trim "$added"); issue=$(trim "$issue")
    f="quarantine.txt entry \"$name\""
    [ -n "$name" ] || { err "quarantine.txt: an entry has no test name: $line"; continue; }
    [ -n "$owner" ] || err "$f has no owner"
    valid_date "$added" || err "$f needs a date added as YYYY-MM-DD, got \"$added\""
    [[ $issue =~ $issue_re ]] || err "$f needs an issue link (https://github.com/<org>/<repo>/issues/<n>), got \"$issue\""
  done < <(entries "$dir/quarantine.txt")
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS='|' read -r name owner added deadline issue why <<< "$line"
    name=$(trim "$name"); owner=$(trim "$owner"); added=$(trim "$added"); deadline=$(trim "$deadline"); issue=$(trim "$issue")
    f="flaky.txt entry \"$name\""
    [ -n "$name" ] || { err "flaky.txt: an entry has no test name: $line"; continue; }
    [ -n "$owner" ] || err "$f has no owner"
    valid_date "$added" || err "$f needs a date added as YYYY-MM-DD, got \"$added\""
    if ! valid_date "$deadline"; then err "$f needs a deadline as YYYY-MM-DD, got \"$deadline\""
    elif valid_date "$added"; then
      n=$(days_between "$added" "$deadline")
      [ "$n" -ge 0 ] || err "$f has a deadline before its added date"
      [ "$n" -le "$max_days" ] || err "$f has a deadline $n days after it was added; the limit is $max_days"
    fi
    [[ $issue =~ $issue_re ]] || err "$f needs an issue link (https://github.com/<org>/<repo>/issues/<n>), got \"$issue\""
    if entries "$dir/quarantine.txt" | cut -d'|' -f1 | sed 's/[[:space:]]*$//' | grep -qxF -- "$name"; then
      err "$f is on both flaky.txt and quarantine.txt"
    fi
  done < <(entries "$dir/flaky.txt")
  [ "$errors" = 0 ] || return 1
  echo "flaky-check: lists ok ($(entries "$dir/flaky.txt" | wc -l | tr -d ' ') flaky, $(entries "$dir/quarantine.txt" | wc -l | tr -d ' ') quarantined)"
}

status() { # test name -> quarantined | flaky | none
  local test=$1 line name owner added deadline
  while IFS= read -r line; do
    name=$(trim "${line%%|*}")
    if [ -n "$name" ]; then case $test in *"$name"*) echo quarantined; return 0 ;; esac; fi
  done < <(entries "$dir/quarantine.txt")
  while IFS= read -r line; do
    IFS='|' read -r name owner added deadline _ <<< "$line"
    name=$(trim "$name"); deadline=$(trim "$deadline")
    [ -n "$name" ] || continue
    case $test in *"$name"*)
      # an unreadable deadline never grants a quarantine; lint fails on it
      if valid_date "$deadline" && [ "$(days_between "$deadline" "$today")" -gt 0 ]; then echo quarantined; else echo flaky; fi
      return 0 ;;
    esac
  done < <(entries "$dir/flaky.txt")
  echo none
}

report() {
  local line name owner added deadline issue age left
  echo "Flaky (passed on the rerun; fix by the deadline or it counts as quarantined), today $today:"
  while IFS= read -r line; do
    IFS='|' read -r name owner added deadline issue _ <<< "$line"
    name=$(trim "$name"); added=$(trim "$added"); deadline=$(trim "$deadline")
    age=$(valid_date "$added" && days_between "$added" "$today" || echo '?')
    left=$(valid_date "$deadline" && days_between "$today" "$deadline" || echo '?')
    if [ "$left" != '?' ] && [ "$left" -lt 0 ]; then
      echo "  OVERDUE $name | $(trim "$owner") | ${age}d old, deadline passed $((-left))d ago, now quarantined | $(trim "$issue")"
    else echo "  $name | $(trim "$owner") | ${age}d old, deadline $deadline | $(trim "$issue")"; fi
  done < <(entries "$dir/flaky.txt")
  echo "Quarantined (failures counted, not failed on):"
  while IFS= read -r line; do
    IFS='|' read -r name owner added issue _ <<< "$line"
    added=$(trim "$added")
    age=$(valid_date "$added" && days_between "$added" "$today" || echo '?')
    echo "  $(trim "$name") | $(trim "$owner") | ${age}d old | $(trim "$issue")"
  done < <(entries "$dir/quarantine.txt")
}

retried() { # a file of test names that passed only on a retry
  local file=$1 test s bad=0
  [ -f "$file" ] || { echo "flaky-check: no retries recorded"; return 0; }
  while IFS= read -r test; do
    [ -n "$test" ] || continue
    s=$(status "$test")
    if [ "$s" = none ]; then
      echo "flaky-check: passed only on a retry and is not on scripts/ci/flaky.txt: $test" >&2
      echo "::error title=Untracked flaky test::$test passed only on retry. Fix it, or add it to scripts/ci/flaky.txt with an owner, a deadline one day out and an issue link."
      bad=1
    else echo "flaky-check: passed only on a retry, tracked as $s: $test"; fi
  done < "$file"
  return $bad
}

case ${1:-} in
  lint) lint ;;
  status) [ $# -ge 2 ] || { echo "usage: flaky-check.sh status <test name>" >&2; exit 2; }; status "$2" ;;
  report) report ;;
  retried) [ $# -ge 2 ] || { echo "usage: flaky-check.sh retried <file>" >&2; exit 2; }; retried "$2" ;;
  *) echo "usage: flaky-check.sh lint|status <name>|report|retried <file>" >&2; exit 2 ;;
esac
