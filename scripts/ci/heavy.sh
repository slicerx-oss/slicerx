#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs a command while holding this machine's heavy-work lock, so a CI run never shares the CPU with a release build,
# a kit build or another CI run, and timing tests do not flake under load. Machine-wide, not per repo:
#
#   scripts/ci/heavy.sh <command...>          waits for a slot of the lock, runs, releases
#   scripts/ci/heavy.sh --all <command...>    waits for every slot, for a timing run that needs the machine alone
#   SX_HEAVY_LOCK=<dir>                        the lock (default ~/.slicerx-heavy.lock); when unset, the value in the
#                                              ci.env of the CI home this copy runs from ($SX_CI_HOME, or bin/..)
#   SX_HEAVY_SLOTS=<n>                         how many holders may run at once (default: the number in <lock>.slots,
#                                              a machine setting beside the lock, or 1 when there is none)
#   SX_HEAVY_WAIT=<seconds>                    give up after this long (default 0: wait as long as it takes)
#   SX_HEAVY_POLL=<seconds>                    how often a waiter looks again (default 5; the tests use 1)
#   SX_HEAVY_ORPHAN=<seconds>                  how old a lock with no holder record must be before it is cleared
#                                              (default 60; a holder writes its record right after taking the lock)
#
# Each slot is a directory holding its holder's record (mkdir is atomic; macOS has no flock command): <lock> is the
# first, <lock>.2 the second, and so on. A slot whose holder has died is taken over, so a crashed job never wedges the
# machine. Waiters take a ticket in <lock>.queue, and only as many of the oldest as there are free slots try one, so
# they are served in arrival order, CI jobs first (SX_HEAVY_PRIORITY=ci, or a self-hosted runner). A --all waiter
# takes the slots one by one as they free up; while one waits, only the oldest ticket takes a slot, so it is not
# passed over. Every waiter judges the holders now and then, so one that cannot does not wedge the queue.
#
# Windows (Git Bash) and WSL on one machine share one lock when both name the same directory on the Windows drive,
# for example C:\Users\<user>\.slicerx-heavy.lock (a C:\ path works on both sides). The record names the holder's
# side, and a holder is checked on its own side: through powershell.exe for a Windows holder, through wsl.exe for a
# WSL one. See README.md for the rules.
set -uo pipefail
all=
[ "${1:-}" = --all ] && { all=1; shift; }
[ $# -gt 0 ] || { echo "usage: heavy.sh [--all] <command...>" >&2; exit 2; }
max=${SX_HEAVY_WAIT:-0}
poll=${SX_HEAVY_POLL:-5}
orphan=${SX_HEAVY_ORPHAN:-60}
lock=${SX_HEAVY_LOCK:-}
if [ -z "$lock" ]; then
  env_file=${SX_CI_HOME:-$(dirname "$0")/..}/ci.env
  [ -f "$env_file" ] && lock=$(set +u; . "$env_file" > /dev/null 2>&1; printf %s "${SX_HEAVY_LOCK:-}")
fi
lock=${lock:-$HOME/.slicerx-heavy.lock}
case $lock in [A-Za-z]:[\\/]*) lock=$(cygpath -u "$lock" 2> /dev/null || wslpath -u "$lock" 2> /dev/null || printf %s "$lock") ;; esac
slots=${SX_HEAVY_SLOTS:-$(head -n 1 "$lock.slots" 2> /dev/null | tr -dc 0-9)}
case $slots in '' | *[!0-9]* | 0) slots=1 ;; esac
[ "$slots" -le 8 ] || slots=8
# The slot directories: <lock>, then <lock>.2 up to <lock>.<slots>.
slot_dirs=("$lock")
for ((i = 2; i <= slots; i++)); do slot_dirs+=("$lock.$i"); done

case "$(uname -s)" in
  Darwin) side=darwin ;;
  Linux) if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2> /dev/null; then side=wsl; else side=linux; fi ;;
  *) side=msys ;;
esac
distro=${WSL_DISTRO_NAME:-}
# A systemd service (a CI runner, for one) gets no WSL_DISTRO_NAME, but wslpath still knows the distro. A record
# without it could not be judged from the other distro side, and a dead holder would wedge the queue.
if [ "$side" = wsl ] && [ -z "$distro" ]; then distro=$(wslpath -w / 2> /dev/null | awk -F'[^A-Za-z0-9._-]+' '{print $3}'); fi

boot_id() { cat /proc/sys/kernel/random/boot_id 2> /dev/null; }
# A process's start time in clock ticks since boot: field 22 of /proc/<pid>/stat, counted after the ")" that ends
# the command name. Linux and Git Bash both have it.
stat_start() { sed 's/.*) //' | cut -d' ' -f20; }
proc_start() { { stat_start < "/proc/$1/stat"; } 2> /dev/null; }
# A Windows process's start time (FILETIME), "gone" when there is no such process, "unknown" when it cannot be read
# (an elevated process, for one), empty when powershell.exe cannot be run.
win_start() {
  winrun powershell.exe -NoProfile -NonInteractive -Command \
    "\$p = Get-Process -Id $1 -ErrorAction SilentlyContinue; if (-not \$p) { 'gone' } elseif (\$p.StartTime) { \$p.StartTime.ToFileTimeUtc() } else { 'unknown' }" \
    2> /dev/null | tr -d '\r'
}
wslx() { winrun wsl.exe "$@" 2> /dev/null | tr -d '\0\r'; }
# Runs a Windows program, for at most 30 s. WSL runs it through /init, as its binfmt entry would: a distro that runs
# systemd can lose that entry, and then a plain call fails.
winrun() {
  local exe; exe=$(command -v "$1") || return 127; shift
  if [ "$side" = wsl ]; then timeout 30 /init "$exe" "${exe##*/}" "$@"; else MSYS_NO_PATHCONV=1 timeout 30 "$exe" "$@"; fi
}

# This process's identity: the record's lines after the first.
identity() {
  echo "side $side"
  case $side in
    msys) local w; w=$(cat "/proc/$$/winpid"); echo "start $(proc_start $$)"; echo "winpid $w"; echo "winstart $(win_start "$w")" ;;
    wsl | linux) echo "start $(proc_start $$)"; echo "boot $(boot_id)"; echo "distro $distro" ;;
    darwin) echo "start $(ps -o lstart= -p $$)" ;;
  esac
}

# Whether the holder in record $1 is alive, asked on its own side. 0: alive, or it cannot be told; 1: dead. A holder is
# declared dead only on evidence: its pid is gone or now belongs to a later process (another start time), or its WSL
# distro has stopped or restarted (another boot id). A pid unknown on this side proves nothing.
alive() {
  local rec=$1 r_side pid start boot r_distro winpid winstart out running rc
  field() { sed -n "s/^$1 //p" <<< "$rec" | head -n 1; }
  pid=$(sed -n '1s/^pid \([0-9]*\).*/\1/p' <<< "$rec")
  r_side=$(field side) start=$(field start) boot=$(field boot) r_distro=$(field distro)
  winpid=$(field winpid) winstart=$(field winstart)
  [ -n "$pid" ] || return 0
  case "$r_side:$side" in
    :*) kill -0 "$pid" 2> /dev/null ;; # a record from before sides were recorded: same side, the old rule
    darwin:darwin) kill -0 "$pid" 2> /dev/null && [ "$(ps -o lstart= -p "$pid")" = "$start" ] ;;
    linux:linux | wsl:wsl)
      # A WSL record with no distro came from a service on this machine's WSL (before wslpath filled the name in).
      if [ "$r_side" = linux ] || [ "$r_distro" = "$distro" ] || [ -z "$r_distro" ]; then
        [ "$(boot_id)" = "$boot" ] && [ "$(proc_start "$pid")" = "$start" ]
      else wsl_alive; fi ;;
    wsl:msys) wsl_alive ;;
    msys:msys | msys:wsl)
      # In Git Bash, the holder's own pid with the same Windows pid and start time is enough. Otherwise ask Windows.
      [ "$side" = msys ] && kill -0 "$pid" 2> /dev/null && [ "$(cat "/proc/$pid/winpid" 2> /dev/null)" = "$winpid" ] &&
        [ "$(proc_start "$pid")" = "$start" ] && return 0
      case $winpid in '' | *[!0-9]*) return 0 ;; esac
      out=$(win_start "$winpid")
      case $out in gone) return 1 ;; '' | unknown) return 0 ;; esac
      [ -z "$winstart" ] || [ "$winstart" = unknown ] || [ "$out" = "$winstart" ] ;;
    *) return 0 ;; # a side this one cannot ask: never taken over
  esac
}

# A WSL holder seen from Windows or from another distro. A distro that is not running has no processes left, so its
# holder is dead; wsl.exe is never asked to run anything in a distro that is not running, so it never starts one.
wsl_alive() {
  wslx -l -q > /dev/null || return 0
  running=$(wslx -l --running -q); rc=$?
  [ $rc -ne 124 ] || return 0
  [ $rc -eq 0 ] || running=
  if [ -z "$r_distro" ]; then [ -n "$running" ]; return; fi
  grep -qxF "$r_distro" <<< "$running" || return 1
  out=$(wslx -d "$r_distro" -u root -- sh -c "cat /proc/sys/kernel/random/boot_id; cat /proc/$pid/stat 2>/dev/null; echo end")
  [ "$(tail -n 1 <<< "$out")" = end ] || return 0
  [ "$(head -n 1 <<< "$out")" = "$boot" ] || return 1
  [ "$(sed -n 2p <<< "$out" | stat_start)" = "$start" ]
}

me=$(identity)
q=$lock.queue
mkdir -p "$q" 2> /dev/null
# CI jobs (a self-hosted runner, or SX_HEAVY_PRIORITY=ci) queue ahead of other waiters; a holder always finishes.
prio=1
if [ "${SX_HEAVY_PRIORITY:-}" = ci ] || [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ]; then prio=0; fi
ticket=$q/$prio-$(date +%s)-$side-$$${all:+-all}
held=()
# Windows refuses to remove a directory another process is looking into (a waiter reading the record), and a slot
# left empty that way would have no record to judge, so the removal is tried a few times.
release() {
  rm -f "$ticket"
  local d i
  for d in ${held[@]+"${held[@]}"}; do
    for i in 1 2 3 4 5; do rm -rf "$d" 2> /dev/null; [ -e "$d" ] || break; sleep 1; done
  done
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mtime() { stat -c %Y "$1" 2> /dev/null || stat -f %m "$1" 2> /dev/null; }
# Takes a free slot: writes this holder's record into it at once, so no waiter ever finds it without one for long.
take() {
  mkdir "$1" 2> /dev/null || return 1
  printf 'pid %s since %s: %s\n%s\n' $$ "$(date '+%F %T')" "${all:+(all slots) }$cmd" "$me" > "$1/owner"
  held+=("$1")
}
mine() { local d; for d in ${held[@]+"${held[@]}"}; do [ "$d" = "$1" ] && return 0; done; return 1; }
# Judges the holder of slot $1 and frees the slot when the holder is dead (or it was left with no record).
judge_slot() {
  local d=$1 rec t m
  rec=$(cat "$d/owner" 2> /dev/null)
  # Take over only the record judged dead, not one a new holder wrote meanwhile.
  if [ -n "$rec" ] && ! alive "$rec" && [ "$(cat "$d/owner" 2> /dev/null)" = "$rec" ]; then
    echo "heavy.sh: taking over a lock left by $(sed -n '1s/ since.*//p' <<< "$rec") ($(sed -n 's/^side //p' <<< "$rec"))" >&2
    rm -rf "$d"; return 0
  fi
  # No record: a holder between mkdir and writing it, or a slot whose removal failed half way. Only one older than
  # $orphan seconds is cleared, and rmdir removes it only while it is still empty.
  if [ -z "$rec" ] && [ -d "$d" ] && [ ! -e "$d/owner" ]; then
    t=$(date +%s); m=$(mtime "$d")
    if [ -n "$m" ] && [ $((t - m)) -ge "$orphan" ] && rmdir "$d" 2> /dev/null; then
      echo "heavy.sh: cleared a lock with no holder record, left for $((t - m)) s" >&2; return 0
    fi
  fi
  return 1
}
cmd="$*"

t0=$SECONDS next=0 judged=0
while :; do
  # Our ticket, refreshed on every poll. A ticket left alone for 2 minutes is a dead waiter's, and is dropped.
  touch "$ticket" 2> /dev/null || { mkdir -p "$q" 2> /dev/null; touch "$ticket" 2> /dev/null; }
  # pos: the live tickets ahead of ours. all_ahead: whether one of them, or ours, waits for every slot.
  now=$(mtime "$ticket") pos=0 all_ahead=$all
  for t in "$q"/*; do
    [ -e "$t" ] || continue
    [ "$t" = "$ticket" ] && break
    if [ -n "$now" ]; then
      m=$(mtime "$t"); [ $((now - ${m:-0})) -lt 120 ] || { rm -f "$t"; continue; }
    fi
    pos=$((pos + 1))
    case $t in *-all) all_ahead=1 ;; esac
  done
  free=0
  for d in "${slot_dirs[@]}"; do [ -e "$d" ] || free=$((free + 1)); done
  # The front of the queue: as many of the oldest tickets as there are slots, or only the oldest while a --all waits.
  # Of those, only as many as there are free slots try one; all of them judge the holders on every poll.
  front=
  if [ -n "$all_ahead" ]; then [ "$pos" = 0 ] && front=1; else [ "$pos" -lt "$slots" ] && front=1; fi
  if [ -n "$front" ]; then
    if [ -n "$all" ]; then
      for d in "${slot_dirs[@]}"; do mine "$d" || take "$d"; done
      [ "${#held[@]}" = "$slots" ] && break
    elif [ "$pos" -lt "$free" ]; then
      for d in "${slot_dirs[@]}"; do take "$d" && break 2; done
    fi
    judge=1
  else
    # Every waiter judges the holders once a minute, so one that cannot (a record from a side it cannot ask) does not
    # keep a dead holder's slot for the whole queue.
    judge=; [ $((SECONDS - judged)) -lt 60 ] || judge=1
  fi
  if [ -n "$judge" ]; then
    judged=$SECONDS freed=
    for d in "${slot_dirs[@]}"; do if ! mine "$d" && judge_slot "$d"; then freed=1; fi; done
    [ -n "$freed" ] && continue
  fi
  waited=$((SECONDS - t0))
  if [ "$waited" -ge "$next" ]; then
    holders=
    for d in "${slot_dirs[@]}"; do
      mine "$d" && continue
      [ -e "$d" ] && holders="$holders${holders:+; }$(head -n 1 "$d/owner" 2> /dev/null || echo 'holder starting')"
    done
    echo "heavy.sh: waiting for $lock ($slots slot$([ "$slots" = 1 ] || echo s)${all:+, all of them}: ${holders:-queue ahead})" >&2
    next=$((next + 300))
  fi
  if [ "$max" -gt 0 ] && [ "$waited" -ge "$max" ]; then echo "heavy.sh: gave up after $max s" >&2; exit 75; fi
  sleep "$poll"
done
rm -f "$ticket"
"$@"
