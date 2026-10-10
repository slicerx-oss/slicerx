#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Tests for heavy.sh, on a lock in a new temporary directory (never the machine's own lock).
#
#   scripts/ci/heavy-test.sh                  this side alone: Linux, macOS, Git Bash or WSL
#   scripts/ci/heavy-test.sh cross <distro> [<stopped distro>]
#                                             from Git Bash: this side, then Windows against WSL through wsl.exe; with
#                                             an installed distro that is not running, also a holder record from it
#
# Every process it starts is stopped by its pid. The role-* commands are the WSL half of the cross tests.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
heavy=$here/heavy.sh
export SX_HEAVY_POLL=1
unset SX_HEAVY_WAIT SX_CI_HOME

linpath() { case $1 in [A-Za-z]:*) wslpath -u "$1" ;; *) printf %s "$1" ;; esac; }
start_of() { sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20; }
case ${1:-} in
  role-hold) SX_HEAVY_LOCK=$2 exec bash "$heavy" sh -c 'echo $$ > "$1"; exec sleep 600' sh "$(linpath "$3")" ;;
  role-wait) SX_HEAVY_LOCK=$2 SX_HEAVY_WAIT=$3 bash "$heavy" sh -c 'echo "$1" >> "$2"' sh "$4" "$(linpath "$5")"; echo "rc $?"; exit 0 ;;
  role-kill) kill "-$2" "$3" 2> /dev/null; exit 0 ;;
  role-proc) cat /proc/sys/kernel/random/boot_id; start_of "$2"; echo "${WSL_DISTRO_NAME:-}"; exit 0 ;;
esac

case "$(uname -s)" in
  Darwin) side=darwin ;;
  Linux) if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2> /dev/null; then side=wsl; else side=linux; fi ;;
  *) side=msys ;;
esac
tmp=$(mktemp -d)
lock=$tmp/lock
# Git Bash: the lock is named by its Windows path, as a machine setting would name it.
[ "$side" = msys ] && lock=$(cygpath -w "$tmp")\\lock
dir=$tmp/lock # the same directory, for this script's own looks
fails=0 lpids='' wpids=''
cleanup() {
  for p in $lpids; do kill -9 "$p" 2> /dev/null; done
  for p in $wpids; do w role-kill 9 "$p" > /dev/null 2>&1; done
  wait 2> /dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

ok() { if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi; }
wait_for() { for _ in $(seq 150); do [ -s "$1" ] && return 0; sleep 0.2; done; return 1; }
holder_pid() { sed -n '1s/^pid \([0-9]*\).*/\1/p' "$dir/owner" 2> /dev/null; }
# A waiter on this side: runs "echo <tag> >> order" under the lock, giving up after $1 s. Sets rc and secs.
waiter() {
  local t0=$SECONDS
  SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=$1 bash "$heavy" sh -c 'echo "$1" >> "$2"' sh "$2" "$tmp/order" > "$tmp/waiter.out" 2>&1
  rc=$? secs=$((SECONDS - t0))
}
# A holder on this side, in the background, holding the lock until its child is stopped.
hold() {
  SX_HEAVY_LOCK=$lock bash "$heavy" sh -c 'echo $$ > "$1"; exec sleep 600' sh "$tmp/$1.child" > /dev/null 2>&1 &
  wait_for "$tmp/$1.child"; lpids="$lpids $(cat "$tmp/$1.child") $!"
}
release() { kill "$(cat "$tmp/$1.child")"; wait "$2" 2> /dev/null; }
fake() { rm -rf "$dir" && mkdir "$dir" && printf 'pid %s since 2026-01-01 00:00:00: fake\n%s\n' "$1" "$2" > "$dir/owner"; }
taken_over() { [ "$rc" = 0 ] && [ ! -d "$dir" ]; }
kept() { [ "$rc" = 75 ] && [ "$(holder_pid)" = "$1" ]; }

# This side's identity for a live process (this script), with the right or a wrong start time.
my_identity() {
  case $side in
    msys)
      local w ws; w=$(cat "/proc/$$/winpid")
      ws=$(powershell.exe -NoProfile -NonInteractive -Command "(Get-Process -Id $w).StartTime.ToFileTimeUtc()" | tr -d '\r')
      [ "$1" = right ] || ws=1
      printf 'side msys\nstart %s\nwinpid %s\nwinstart %s' "$( [ "$1" = right ] && start_of $$ || echo 1)" "$w" "$ws" ;;
    wsl | linux)
      printf 'side %s\nstart %s\nboot %s\ndistro %s' "$side" "$( [ "$1" = right ] && start_of $$ || echo 1)" \
        "$(cat /proc/sys/kernel/random/boot_id)" "${WSL_DISTRO_NAME:-}" ;;
    darwin) printf 'side darwin\nstart %s' "$( [ "$1" = right ] && ps -o lstart= -p $$ || echo 'Thu Jan  1 00:00:00 1970')" ;;
  esac
}

echo "== $side, lock $lock"
name="a free lock runs the command and passes its exit status"
SX_HEAVY_LOCK=$lock bash "$heavy" sh -c 'exit 7'; rc=$?
ok eval '[ $rc = 7 ] && [ ! -d "$dir" ]'

hold h1; h1=$!
waiter 3 w1
name="a live holder is kept and SX_HEAVY_WAIT=3 gives up on time (rc $rc, $secs s)"
ok eval 'kept $h1 && [ $secs -ge 3 ] && [ $secs -le 6 ]'
name="a holder killed by pid is taken over"
kill -9 "$h1"; wait "$h1" 2> /dev/null
waiter 20 w2
ok eval 'taken_over && grep -q "taking over a lock left by pid $h1" "$tmp/waiter.out"'
kill "$(cat "$tmp/h1.child")" 2> /dev/null

name="a record with a live pid and another start time is taken over"
fake $$ "$(my_identity wrong)"; waiter 20 w3; ok taken_over
name="the same record with the right start time is kept"
fake $$ "$(my_identity right)"; waiter 2 w4; ok kept $$
name="an old record (no side) with a live pid is kept"
fake $$ ''; waiter 2 w5; ok kept $$

# A lock with no record: a holder between mkdir and writing it (kept), or one left empty when its removal failed on
# Windows (cleared once it is older than SX_HEAVY_ORPHAN).
name="a new lock with no record is kept"
rm -rf "$dir" && mkdir "$dir"; SX_HEAVY_ORPHAN=60 waiter 2 w6; ok eval '[ "$rc" = 75 ] && [ -d "$dir" ]'
name="an old lock with no record is cleared"
rm -rf "$dir" && mkdir "$dir" && touch -d '-120 seconds' "$dir"; SX_HEAVY_ORPHAN=60 waiter 20 w7
ok eval 'taken_over && grep -q "cleared a lock with no holder record" "$tmp/waiter.out"'
sleep 0 & dead=$!; wait $dead
name="an old record (no side) with a dead pid is taken over"
fake $dead ''; waiter 20 w6; ok taken_over
if [ "$side" = wsl ]; then
  # A record from a service (no WSL_DISTRO_NAME) on this WSL, as an older heavy.sh in a CI runner wrote it.
  boot=$(cat /proc/sys/kernel/random/boot_id)
  name="a WSL record with no distro and a dead pid is taken over"
  fake $dead "$(printf 'side wsl\nstart 1\nboot %s\ndistro ' "$boot")"; waiter 20 w6b; ok taken_over
  name="a WSL record with no distro and a live pid is kept"
  fake $$ "$(printf 'side wsl\nstart %s\nboot %s\ndistro ' "$(start_of $$)" "$boot")"; waiter 3 w6c; ok kept $$
fi
name="a record from a side this one cannot ask is kept"
fake 1 'side elsewhere'; waiter 2 w7; ok kept 1
rm -rf "$dir"

name="a ticket left by a dead waiter does not hold up the queue"
mkdir -p "$dir.queue" && touch -t 202601010000 "$dir.queue/0000000000-gone-1"
waiter 20 w8; ok eval 'taken_over && [ $secs -le 3 ] && [ ! -e "$dir.queue/0000000000-gone-1" ]'

name="waiters are served in arrival order"
: > "$tmp/order"
hold h2; h2=$!
for t in A B C; do
  SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" sh -c 'echo "$1" >> "$2"' sh "$t" "$tmp/order" > /dev/null 2>&1 &
  eval "p$t=\$!"; lpids="$lpids $!"; sleep 1.5
done
release h2 "$h2"; wait "$pA" "$pB" "$pC"
ok eval '[ "$(tr "\n" " " < "$tmp/order")" = "A B C " ]'

name="a CI waiter (a self-hosted runner) goes ahead of earlier waiters"
: > "$tmp/order"
hold h3; h3=$!
for t in A B; do
  SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" sh -c 'echo "$1" >> "$2"' sh "$t" "$tmp/order" > /dev/null 2>&1 &
  eval "p$t=\$!"; lpids="$lpids $!"; sleep 1.5
done
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 RUNNER_ENVIRONMENT=self-hosted bash "$heavy" sh -c 'echo "$1" >> "$2"' sh C "$tmp/order" > /dev/null 2>&1 &
pC=$!; lpids="$lpids $!"; sleep 1.5
release h3 "$h3"; wait "$pA" "$pB" "$pC"
ok eval '[ "$(tr "\n" " " < "$tmp/order")" = "C A B " ]'

# Slots: <lock>.slots names how many holders may run at once, SX_HEAVY_SLOTS overrides it, and --all takes them all.
echo 2 > "$dir.slots"
name="with 2 slots in <lock>.slots, two holders run at once and a third waiter waits"
hold h4; h4=$!
hold h5; h5=$!
waiter 3 w9
ok eval '[ "$rc" = 75 ] && [ -d "$dir" ] && [ -d "$dir.2" ]'
name="SX_HEAVY_SLOTS=1 overrides <lock>.slots"
release h5 "$h5"
SX_HEAVY_SLOTS=1 waiter 3 w10; ok eval '[ "$rc" = 75 ] && [ ! -d "$dir.2" ]'
name="a dead holder in the second slot is taken over"
sleep 0 & dead=$!; wait $dead
mkdir "$dir.2" && printf 'pid %s since 2026-01-01 00:00:00: fake\n' "$dead" > "$dir.2/owner"
waiter 20 w11; ok eval '[ "$rc" = 0 ] && [ ! -d "$dir.2" ] && grep -q "taking over a lock left by pid $dead" "$tmp/waiter.out"'
name="--all waits for every slot, runs alone, and a later waiter does not pass it"
: > "$tmp/order"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" --all sh -c '[ -d "$1" ] && [ -d "$1.2" ] && echo ALL >> "$2"' sh "$dir" "$tmp/order" > /dev/null 2>&1 &
pAll=$!; lpids="$lpids $!"; sleep 1.5
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" sh -c 'echo "$1" >> "$2"' sh B "$tmp/order" > /dev/null 2>&1 &
pB=$!; lpids="$lpids $!"; sleep 3
# B came after the --all waiter, so it may not take the second slot while the first is still held.
b_waited=$([ -s "$tmp/order" ] && echo no || echo yes)
release h4 "$h4"; wait "$pAll" "$pB"
ok eval '[ "$b_waited" = yes ] && [ "$(tr "\n" " " < "$tmp/order")" = "ALL B " ] && [ ! -d "$dir" ] && [ ! -d "$dir.2" ]'

# --e2e: one e2e holder at a time; other jobs still share the free slot, even behind a waiting --e2e ticket.
SX_HEAVY_LOCK=$lock bash "$heavy" --e2e sh -c 'echo $$ > "$1"; exec sleep 600' sh "$tmp/e1.child" > /dev/null 2>&1 &
e1=$!; wait_for "$tmp/e1.child"; lpids="$lpids $(cat "$tmp/e1.child") $e1"
name="an --e2e holder's record says class e2e"
ok grep -qx 'class e2e' "$dir/owner"
name="a second --e2e waiter waits while one --e2e holds a slot, with a slot free"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=3 bash "$heavy" --e2e true > /dev/null 2>&1; rc=$?
ok eval '[ "$rc" = 75 ] && [ ! -d "$dir.2" ]'
name="a plain waiter behind a waiting --e2e ticket takes the free slot"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" --e2e true > /dev/null 2>&1 &
pE=$!; lpids="$lpids $!"; sleep 1.5
waiter 20 w12
ok eval '[ "$rc" = 0 ] && [ $secs -le 5 ]'
name="the waiting --e2e ticket runs once the --e2e holder is gone"
release e1 "$e1"
t0=$SECONDS; wait "$pE"; rc=$?
ok eval '[ "$rc" = 0 ] && [ $((SECONDS - t0)) -le 10 ]'

# --gpu: GPU slots of their own (<lock>.gpu-slots), several at once, never beside an exclusive run.
echo 2 > "$dir.gpu-slots"
gpu_hold() {
  SX_HEAVY_LOCK=$lock bash "$heavy" --gpu sh -c 'echo $$ > "$1"; exec sleep 600' sh "$tmp/$1.child" > /dev/null 2>&1 &
  eval "$1=\$!"; wait_for "$tmp/$1.child"; lpids="$lpids $(cat "$tmp/$1.child") $!"
}
gpu_hold g1; gpu_hold g2
name="two --gpu holders run at once in the GPU slots, leaving the plain slots free"
ok eval '[ -d "$dir.gpu.1" ] && [ -d "$dir.gpu.2" ] && [ ! -d "$dir" ] && [ ! -d "$dir.2" ] && grep -qx "class gpu" "$dir.gpu.1/owner"'
name="a plain waiter takes a plain slot beside the --gpu holders"
waiter 20 w13
ok eval '[ "$rc" = 0 ] && [ $secs -le 5 ]'
name="a third --gpu waiter waits while the GPU slots are full"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=3 bash "$heavy" --gpu true > /dev/null 2>&1; rc=$?
ok eval '[ "$rc" = 75 ]'
name="an --e2e waiter waits while a --gpu run holds, with the plain slots free"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=3 bash "$heavy" --e2e true > /dev/null 2>&1; rc=$?
ok eval '[ "$rc" = 75 ] && [ ! -d "$dir" ]'
name="a --gpu waiter behind a waiting --e2e ticket waits, with a GPU slot free"
release g2 "$g2"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" --e2e sh -c 'echo $$ > "$1"; exec sleep 600' sh "$tmp/e3.child" > /dev/null 2>&1 &
e3=$!; lpids="$lpids $!"; sleep 1.5
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=3 bash "$heavy" --gpu true > /dev/null 2>&1; rc=$?
ok eval '[ "$rc" = 75 ] && [ ! -d "$dir.gpu.2" ]'
name="the --e2e ticket runs once the last --gpu holder is gone"
release g1 "$g1"; wait_for "$tmp/e3.child"; lpids="$lpids $(cat "$tmp/e3.child")"
ok eval 'grep -qx "class e2e" "$dir/owner"'
name="a --gpu waiter waits while an --e2e run holds"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=3 bash "$heavy" --gpu true > /dev/null 2>&1; rc=$?
ok eval '[ "$rc" = 75 ] && [ ! -d "$dir.gpu.1" ]'
name="the --gpu waiter runs once the --e2e holder is gone"
release e3 "$e3"
SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=20 bash "$heavy" --gpu true > /dev/null 2>&1; rc=$?
ok eval '[ "$rc" = 0 ]'
rm -f "$dir.gpu-slots"
rm -f "$dir.slots"

if [ "${1:-}" = cross ]; then
  distro=${2:?usage: heavy-test.sh cross <distro> [<stopped distro>]} stopped=${3:-}
  [ "$side" = msys ] || { echo "cross runs from Git Bash" >&2; exit 2; }
  w() { MSYS_NO_PATHCONV=1 wsl.exe -d "$distro" -u root -- bash "$self" "$@"; }
  # wsl.exe drops the backslashes in its arguments, so WSL is handed C:/... paths.
  win() { cygpath -m "$tmp/$1"; }
  wlock=$(win lock)
  self=$(MSYS_NO_PATHCONV=1 wsl.exe -d "$distro" -u root -- wslpath -u "$(cygpath -m "$here/heavy-test.sh")" | tr -d '\r')
  # A holder in WSL, in the background, holding the lock until its child is stopped.
  whold() {
    w role-hold "$wlock" "$(win "$1.child")" > /dev/null 2>&1 &
    wait_for "$tmp/$1.child"; wpids="$wpids $(cat "$tmp/$1.child") $(holder_pid)"
  }
  wwaiter() { local t0=$SECONDS; rc=$(w role-wait "$wlock" "$1" "$2" "$(win order)" 2> "$tmp/waiter.out" | sed -n 's/^rc //p'); secs=$((SECONDS - t0)); }
  echo "== msys and wsl ($distro), lock $lock, in WSL $wlock"

  whold x1; x1=$(holder_pid)
  name="a WSL holder keeps a Windows waiter out"
  waiter 3 x1w; ok kept "$x1"
  name="a WSL holder killed by pid is taken over from Windows"
  w role-kill 9 "$x1"; waiter 20 x2w
  ok eval 'taken_over && grep -q "taking over a lock left by pid $x1 (wsl)" "$tmp/waiter.out"'
  w role-kill 15 "$(cat "$tmp/x1.child")"

  hold x3; x3=$!
  name="a Windows holder keeps a WSL waiter out"
  wwaiter 3 x3w; ok kept "$x3"
  name="a Windows holder killed by pid is taken over from WSL"
  kill -9 "$x3"; wait "$x3" 2> /dev/null
  wwaiter 30 x4w; ok taken_over
  kill "$(cat "$tmp/x3.child")" 2> /dev/null

  { read -r wboot; read -r wstart; read -r wdistro; } < <(w role-proc 1 | tr -d '\r')
  name="a WSL record with a live pid and another start time is taken over from Windows"
  fake 1 "$(printf 'side wsl\nstart 1\nboot %s\ndistro %s' "$wboot" "$wdistro")"; waiter 20 x5; ok taken_over
  name="a WSL record with another boot id is taken over from Windows"
  fake 1 "$(printf 'side wsl\nstart %s\nboot 0\ndistro %s' "$wstart" "$wdistro")"; waiter 20 x6; ok taken_over
  name="the WSL record with the right start time and boot id is kept"
  fake 1 "$(printf 'side wsl\nstart %s\nboot %s\ndistro %s' "$wstart" "$wboot" "$wdistro")"; waiter 3 x7; ok kept 1
  if [ -n "$stopped" ]; then
    name="a record from a distro that is not running ($stopped) is taken over, and the distro stays stopped"
    fake 1 "$(printf 'side wsl\nstart %s\nboot %s\ndistro %s' "$wstart" "$wboot" "$stopped")"; waiter 20 x7b
    ok eval 'taken_over && ! MSYS_NO_PATHCONV=1 wsl.exe -l --running -q | tr -d "\0\r" | grep -qxF "$stopped"'
  fi
  name="a Windows record with a live pid and another start time is taken over from WSL"
  fake $$ "$(my_identity wrong)"; wwaiter 30 x8; ok taken_over
  name="the Windows record with the right start time is kept from WSL"
  fake $$ "$(my_identity right)"; wwaiter 3 x9; ok kept $$
  rm -rf "$dir"

  name="waiters on both sides are served in arrival order"
  : > "$tmp/order"
  hold x10; x10=$!
  w role-wait "$wlock" 60 W "$(win order)" > /dev/null 2>&1 & lpids="$lpids $!"; pW=$!; sleep 3
  SX_HEAVY_LOCK=$lock SX_HEAVY_WAIT=60 bash "$heavy" sh -c 'echo "$1" >> "$2"' sh M "$tmp/order" > /dev/null 2>&1 &
  pM=$!; lpids="$lpids $!"; sleep 2
  release x10 "$x10"; wait "$pW" "$pM"
  ok eval '[ "$(tr "\n" " " < "$tmp/order")" = "W M " ]'
fi

echo "== $fails failed"
[ "$fails" = 0 ]
