#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Removes the temp dirs SlicerX's tests, e2e host and signing scripts leave behind, on macOS, Linux and WSL.
# It looks only at the names below, at depth 1 of $TMPDIR and /tmp, and only at dirs this user owns that nothing
# has written to for --min-age-hours (default 2). A dry run is the default: it prints each candidate with its size
# and age, and a total. scripts/ci/README.md, "Disk", says what each name is.
#
#   sh scripts/janitor-mac.sh [--execute] [--below-gb N] [--min-age-hours N] [--target-dir DIR]...
#
#   --execute         delete the candidates (without it nothing is removed)
#   --below-gb N      do nothing unless the free space on $HOME's or $TMPDIR's disk is under N GB
#   --min-age-hours N only dirs untouched for N hours or more; values under 2 are raised to 2
#   --target-dir DIR  a dir of per-runner cargo targets (default $HOME/target): DIR/*/debug/incremental is a
#                     candidate, but only while no cargo, rustc or Runner.Worker process runs
#
# Never: git worktrees or anything holding a .git, source trees, ~/builds, release outputs.
set -u

execute=0 below='' hours=2 targets=''
while [ $# -gt 0 ]; do
  case $1 in
    --execute) execute=1 ;;
    --below-gb) below=${2:?--below-gb needs a number}; shift ;;
    --min-age-hours) hours=${2:?--min-age-hours needs a number}; shift ;;
    --target-dir) targets="$targets
${2:?--target-dir needs a dir}"; shift ;;
    -h | --help) sed -n '4,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "janitor: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case $hours in '' | *[!0-9]*) echo "janitor: --min-age-hours takes whole hours" >&2; exit 2 ;; esac
case $below in *[!0-9]*) echo "janitor: --below-gb takes whole GB" >&2; exit 2 ;; esac
[ "$hours" -lt 2 ] && hours=2
[ -n "$targets" ] || targets=$HOME/target
mins=$((hours * 60))
uid=$(id -u)

free_kb() { df -Pk "$1" 2> /dev/null | awk 'NR == 2 { print $4 }'; }
gb() { awk -v k="$1" 'BEGIN { printf "%.1f", k / 1048576 }'; }
free_report() {
  for d in "$HOME" "${TMPDIR:-/tmp}" /tmp; do
    df -Pk "$d" 2> /dev/null | awk 'NR == 2 { print $6 " " $4 }'
  done | awk '!seen[$1]++' | while read -r mnt kb; do echo "  $mnt: $(gb "$kb") GB free"; done
}

if [ -n "$below" ]; then
  low=0
  for d in "$HOME" "${TMPDIR:-/tmp}"; do
    kb=$(free_kb "$d")
    [ -n "$kb" ] && [ "$kb" -lt $((below * 1048576)) ] && low=1
  done
  if [ $low -eq 0 ]; then
    echo "janitor: at least $below GB free, nothing to do"
    free_report
    exit 0
  fi
fi

if [ $execute -eq 1 ]; then echo "janitor: deleting, min age $hours h"; else echo "janitor: dry run, nothing is deleted; min age $hours h"; fi
echo "free before:"
free_report

total=0 count=0
# untouched: nothing in the dir or its direct children changed in the last $2 minutes (Vite and the e2e host write
# into subdirs, which moves the subdir's time, not the top dir's)
untouched() { [ -z "$(find "$1" -maxdepth 1 -mmin "-$2" -print 2> /dev/null | head -n 1)" ]; }
if stat -c %Y / > /dev/null 2>&1; then
  mtimes() { find "$1" -maxdepth 1 -exec stat -c %Y {} + 2> /dev/null; }
else
  mtimes() { find "$1" -maxdepth 1 -exec stat -f %m {} + 2> /dev/null; }
fi
age_h() { mtimes "$1" | sort -n | tail -n 1 | awk -v now="$(date +%s)" '{ printf "%.1f", (now - $1) / 3600 }'; }
take() { # path, what left it
  [ -e "$1/.git" ] && return
  kb=$(du -sk "$1" 2> /dev/null | awk '{ print $1 }')
  kb=${kb:-0}
  printf '%8s MB %7s h  %s  (%s)\n' "$((kb / 1024))" "$(age_h "$1")" "$1" "$2"
  total=$((total + kb))
  count=$((count + 1))
  if [ $execute -eq 1 ]; then rm -rf "$1" || echo "janitor: could not remove all of $1" >&2; fi
}
pid_alive() { [ -n "$1" ] && kill -0 "$1" 2> /dev/null; }

# Vitest's core temp dir: a 21-character nanoid holding only ssr/ and client/ (patches/vitest@5.0.2.patch stops new ones)
vitest_dir() {
  b=$(basename "$1")
  case $b in *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ ${#b} -eq 21 ] || return 1
  n=0
  for e in "$1"/* "$1"/.[!.]*; do
    [ -e "$e" ] || continue
    case $(basename "$e") in
      ssr | client) [ -d "$e" ] || return 1; n=$((n + 1)) ;;
      *) return 1 ;;
    esac
  done
  [ $n -gt 0 ]
}

seen=''
for root in "${TMPDIR:-}" /tmp; do
  [ -n "$root" ] && [ -d "$root" ] || continue
  real=$(cd "$root" && pwd -P)
  case " $seen " in *" $real "*) continue ;; esac
  seen="$seen $real"
  # a here-document, not a pipe, so the loop runs in this shell and keeps the running total
  while IFS= read -r d; do
    [ -n "$d" ] && untouched "$d" "$mins" || continue
    case $(basename "$d") in
      sx-e2e-native-*) pid_alive "$(cat "$d/owner.pid" 2> /dev/null)" || take "$d" "e2e native host" ;;
      slicerx-mcp-test-*|slicerx-mcp-fn-*) take "$d" "MCP tests" ;;
      sx-hub-test-* | sx-cli-* | sx-starters-* | sx-updater-e2e-*) take "$d" "Rust and updater tests" ;;
      sx-sign*) take "$d" "mac signing stage" ;;
      playwright-artifacts-*) take "$d" "Playwright" ;;
      *) vitest_dir "$d" && take "$d" "Vitest" ;;
    esac
  done << LIST
$(find "$real" -mindepth 1 -maxdepth 1 -type d -user "$uid" -mmin "+$mins" -print 2> /dev/null)
LIST
done

# Per-runner cargo incremental caches, only while no build or runner job is running
busy=$(ps -A -o comm= 2> /dev/null | sed 's|.*/||' | grep -E '^(cargo|rustc|Runner\.Worker)$' | sort -u | tr '\n' ' ')
while IFS= read -r t; do
  [ -n "$t" ] && [ -d "$t" ] || continue
  for d in "$t"/*/debug/incremental; do
    [ -d "$d" ] || continue
    if [ -n "$busy" ]; then echo "  skipped $d: running $busy"; continue; fi
    untouched "$d" "$mins" && take "$d" "cargo incremental"
  done
done << LIST
$targets
LIST

if [ $execute -eq 1 ]; then echo "total: $count dirs, $(gb "$total") GB removed"
else echo "total: $count dirs, $(gb "$total") GB would be removed (run with --execute)"; fi
echo "free after:"
free_report
