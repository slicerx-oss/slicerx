#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Slices requests many times, several processes at once, and counts the output
# hashes and exit codes. A healthy build on a healthy machine prints one line
# per request and thread count: every run exits 0 with one hash. A crash, a
# panic or a second hash is a bug, or a machine that is not stable under load
# (run the same loop with -t 1: a single-threaded slice has no races, so a
# failure there points at the machine).
#
#   packages/core/bench/stress.sh [-n runs] [-p processes] [-t threads,...] <sx> <request.json>...
#
# -n runs of each request (default 50), -p processes at once (default 4),
# -t comma-separated RAYON_NUM_THREADS values (default: the pool's own size).
# The stderr of every failed run is kept in $TMPDIR/sx-stress-fail.
set -eu
runs=50
procs=4
threads=default
while getopts n:p:t: o; do
  case $o in
    n) runs=$OPTARG ;;
    p) procs=$OPTARG ;;
    t) threads=$OPTARG ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
if [ $# -lt 2 ]; then
  echo "usage: stress.sh [-n runs] [-p processes] [-t threads,...] <sx> <request.json>..." >&2
  exit 2
fi
sx=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
shift
if command -v sha1sum >/dev/null 2>&1; then sum=sha1sum; else sum='shasum -a 1'; fi
tmp=${TMPDIR:-/tmp}
fail=$tmp/sx-stress-fail
mkdir -p "$fail"

one() {
  local req=$1 t=$2 o e=0 h
  o=$(mktemp -d "$tmp/sx-stress.XXXXXX")
  if [ "$t" = default ]; then unset RAYON_NUM_THREADS; else export RAYON_NUM_THREADS=$t; fi
  (cd "$(dirname "$req")" && "$sx" slice --request "$req" --out-dir "$o" >/dev/null 2>"$o/err") || e=$?
  h=$(cat "$o"/slice.* 2>/dev/null | $sum | cut -c1-16)
  if [ "$e" -ne 0 ]; then cp "$o/err" "$fail/$(basename "$req" .json)-t$t-exit$e-$$-$RANDOM.err"; fi
  rm -rf "$o"
  echo "$(basename "$req") threads=$t exit=$e $h"
}
export -f one
export sx sum tmp fail

status=0
for t in ${threads//,/ }; do
  for req in "$@"; do
    abs=$(cd "$(dirname "$req")" && pwd)/$(basename "$req")
    out=$(for _ in $(seq 1 "$runs"); do echo "$abs"; done | xargs -P "$procs" -I{} bash -c "one {} $t" | sort | uniq -c)
    echo "$out"
    if [ "$(echo "$out" | wc -l)" -ne 1 ] || ! echo "$out" | grep -q ' exit=0 '; then status=1; fi
  done
done
exit $status
