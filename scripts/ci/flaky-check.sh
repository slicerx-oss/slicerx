#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# The flaky-test lists and the checks on them. See "Flaky tests" in scripts/ci/README.md.
# Each entry is its own file, so adding or removing one never touches another entry's lines.
#
#   flaky-check.sh lint                  fail on any entry without an owner, a valid date or an issue link
#   flaky-check.sh status <test name>    print quarantined, flaky or none for a failing test
#   flaky-check.sh report                list both lists with ages and deadlines; overdue flaky entries are marked
#   flaky-check.sh retried <file>        fail when a test named in <file> (one per line) passed only on a retry and
#                                        is on neither list
#
# flaky.d/<issue>-<slug>.txt:      name | owner | added | deadline | issue | why   (deadline: at most a day after added)
# quarantine.d/<issue>-<slug>.txt: name | owner | added | issue | why
# One entry line per file (lines starting with # are comments). <issue> is the number in the entry's issue link and
# <slug> is a few lowercase words, so two entries for one issue get two files.
# A name is a substring of the test name as the run reports it. A flaky entry whose deadline has passed counts as
# quarantined from the next day on (status prints quarantined, report marks it overdue), so an unfixed flake stops
# failing runs without anyone editing a file, and still shows in every report until someone fixes it.
# FLAKY_DIR picks another directory holding flaky.d and quarantine.d; FLAKY_TODAY (YYYY-MM-DD) replaces today's date.
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

flaky_d=$dir/flaky.d
quar_d=$dir/quarantine.d
# files <dir>: the entry files in a list folder, sorted
files() { local f; for f in "$1"/*.txt; do [ -f "$f" ] && printf '%s
' "$f"; done; }
# entries <dir>: the non-comment lines of every entry file in a list folder
entries() { local f; while IFS= read -r f; do grep -vE '^\s*(#|$)' "$f" || true; done < <(files "$1"); }

errors=0
err() { echo "flaky-check: $*" >&2; errors=$((errors + 1)); }

# check_file <file> <list name>: one entry line, named after its issue; prints the line
check_file() {
  local f=$1 base n issue_n
  base=$(basename "$f")
  n=$(grep -cvE '^\s*(#|$)' "$f")
  if [ "$n" != 1 ]; then err "$2/$base has $n entry lines; each file holds exactly one"; return 1; fi
  [[ $base =~ ^([0-9]+)-[a-z0-9]+(-[a-z0-9]+)*\.txt$ ]] || err "$2/$base is not named <issue>-<slug>.txt (a few lowercase words)"
  issue_n=${BASH_REMATCH[1]:-}
  line=$(grep -vE '^\s*(#|$)' "$f")
  if [ -n "$issue_n" ] && [[ $line =~ /issues/([0-9]+) ]] && [ "${BASH_REMATCH[1]}" != "$issue_n" ]; then
    err "$2/$base is named for #$issue_n but its issue link is #${BASH_REMATCH[1]}"
  fi
}

lint() {
  local line n f file name owner added deadline issue why
  for old in flaky.txt quarantine.txt; do
    [ -e "$dir/$old" ] && err "scripts/ci/$old is gone: each entry is now a file in ${old%.txt}.d/ (see scripts/ci/README.md)"
  done
  while IFS= read -r file; do
    check_file "$file" quarantine.d || continue
    IFS='|' read -r name owner added issue why <<< "$line"
    name=$(trim "$name"); owner=$(trim "$owner"); added=$(trim "$added"); issue=$(trim "$issue")
    f="quarantine.d/$(basename "$file") (\"$name\")"
    [ -n "$name" ] || { err "quarantine.d/$(basename "$file") has no test name: $line"; continue; }
    [ -n "$owner" ] || err "$f has no owner"
    valid_date "$added" || err "$f needs a date added as YYYY-MM-DD, got \"$added\""
    [[ $issue =~ $issue_re ]] || err "$f needs an issue link (https://github.com/<org>/<repo>/issues/<n>), got \"$issue\""
  done < <(files "$quar_d")
  while IFS= read -r file; do
    check_file "$file" flaky.d || continue
    IFS='|' read -r name owner added deadline issue why <<< "$line"
    name=$(trim "$name"); owner=$(trim "$owner"); added=$(trim "$added"); deadline=$(trim "$deadline"); issue=$(trim "$issue")
    f="flaky.d/$(basename "$file") (\"$name\")"
    [ -n "$name" ] || { err "flaky.d/$(basename "$file") has no test name: $line"; continue; }
    [ -n "$owner" ] || err "$f has no owner"
    valid_date "$added" || err "$f needs a date added as YYYY-MM-DD, got \"$added\""
    if ! valid_date "$deadline"; then err "$f needs a deadline as YYYY-MM-DD, got \"$deadline\""
    elif valid_date "$added"; then
      n=$(days_between "$added" "$deadline")
      [ "$n" -ge 0 ] || err "$f has a deadline before its added date"
      [ "$n" -le "$max_days" ] || err "$f has a deadline $n days after it was added; the limit is $max_days"
    fi
    [[ $issue =~ $issue_re ]] || err "$f needs an issue link (https://github.com/<org>/<repo>/issues/<n>), got \"$issue\""
    if entries "$quar_d" | cut -d'|' -f1 | sed 's/[[:space:]]*$//' | grep -qxF -- "$name"; then
      err "$f is on both flaky.d and quarantine.d"
    fi
  done < <(files "$flaky_d")
  # the same test listed twice, in either folder
  while IFS= read -r name; do err "\"$name\" has more than one entry file"; done < <(
    { entries "$flaky_d"; entries "$quar_d"; } | cut -d'|' -f1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sort | uniq -d)
  [ "$errors" = 0 ] || return 1
  echo "flaky-check: lists ok ($(entries "$flaky_d" | wc -l | tr -d ' ') flaky, $(entries "$quar_d" | wc -l | tr -d ' ') quarantined)"
}

status() { # test name -> quarantined | flaky | none
  local test=$1 line name owner added deadline
  while IFS= read -r line; do
    name=$(trim "${line%%|*}")
    if [ -n "$name" ]; then case $test in *"$name"*) echo quarantined; return 0 ;; esac; fi
  done < <(entries "$quar_d")
  while IFS= read -r line; do
    IFS='|' read -r name owner added deadline _ <<< "$line"
    name=$(trim "$name"); deadline=$(trim "$deadline")
    [ -n "$name" ] || continue
    case $test in *"$name"*)
      # an unreadable deadline never grants a quarantine; lint fails on it
      if valid_date "$deadline" && [ "$(days_between "$deadline" "$today")" -gt 0 ]; then echo quarantined; else echo flaky; fi
      return 0 ;;
    esac
  done < <(entries "$flaky_d")
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
  done < <(entries "$flaky_d")
  echo "Quarantined (failures counted, not failed on):"
  while IFS= read -r line; do
    IFS='|' read -r name owner added issue _ <<< "$line"
    added=$(trim "$added")
    age=$(valid_date "$added" && days_between "$added" "$today" || echo '?')
    echo "  $(trim "$name") | $(trim "$owner") | ${age}d old | $(trim "$issue")"
  done < <(entries "$quar_d")
}

retried() { # a file of test names that passed only on a retry
  local file=$1 test s bad=0
  [ -f "$file" ] || { echo "flaky-check: no retries recorded"; return 0; }
  while IFS= read -r test; do
    [ -n "$test" ] || continue
    s=$(status "$test")
    if [ "$s" = none ]; then
      echo "flaky-check: passed only on a retry and is not on scripts/ci/flaky.d: $test" >&2
      echo "::error title=Untracked flaky test::$test passed only on retry. Fix it, or add a file scripts/ci/flaky.d/<issue>-<slug>.txt with an owner, a deadline one day out and an issue link."
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
