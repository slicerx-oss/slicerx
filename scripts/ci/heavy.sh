#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs a command while holding this machine's heavy-work lock, so a CI run never shares the CPU with a release build,
# a kit build or another CI run, and timing tests do not flake under load. Machine-wide, not per repo:
#
#   scripts/ci/heavy.sh <command...>          waits for a slot of the lock, runs, releases
#   scripts/ci/heavy.sh --all <command...>    waits for every slot, for a timing run that needs the machine alone
#   scripts/ci/heavy.sh --e2e <command...>    an e2e browser run: at most one holds a slot at a time, other jobs
#                                              share the rest; it also waits until no --gpu run holds, so a timing
#                                              spec on the GPU lane runs with no other browser suite
#   scripts/ci/heavy.sh --gpu <command...>    a GPU-drawn browser run: several run at once, in their own slots
#                                              (<lock>.gpu.1 and on), never beside a --e2e or --all holder
#   scripts/ci/heavy.sh --class engine <command...>
#                                              a plain hold for an engine test suite (cargo test of the Rust crates):
#                                              it never runs beside a --gpu run; a plain hold whose command runs cargo
#                                              is one without the flag
#   SX_HEAVY_GPU_SLOTS=<n>                     how many --gpu holders may run at once (default: the number in
#                                              <lock>.gpu-slots, or 1 when there is none)
#   SX_HEAVY_GPU_ENGINE=<n>                    how many --class engine holds may run beside a --gpu run (default:
#                                              the number in <lock>.gpu-engine, or 0 when there is none)
#   SX_HEAVY_ENGINE_STARVE=<seconds>           how long an engine waiter waits for the GPU lane before it takes the
#                                              next turn (default: the number in <lock>.engine-starve, or 240 when
#                                              there is none); at twice that it starts beside a --gpu run
#   SX_HEAVY_RESERVE_AFTER=<seconds>          how long a manual --e2e waiter that cannot run yet waits before it holds
#                                              the others back for its turn (default: the number in
#                                              <lock>.reserve-after, or 900 when there is none)
#   SX_HEAVY_LOCK=<dir>                       the lock (default ~/.slicerx-heavy.lock); when unset, the value in the
#                                              ci.env of the CI home this copy runs from ($SX_CI_HOME, or bin/..)
#   SX_HEAVY_SLOTS=<n>                         how many holders may run at once (default: the number in <lock>.slots,
#                                              a machine setting beside the lock, or 1 when there is none)
#   SX_HEAVY_WAIT=<seconds>                    give up after this long (default 0: wait as long as it takes), with
#                                              exit status 75 and without running the command; 75 is kept for
#                                              that, so a command that exits 75 itself is reported as 1
#   SX_HEAVY_POLL=<seconds>                    how often a waiter looks again (default 5; the tests use 1)
#   SX_HEAVY_ORPHAN=<seconds>                  how old a lock with no holder record must be before it is cleared
#                                              (default 60; a holder writes its record right after taking the lock)
#   SX_HEAVY_MAX_HOLD=<seconds>                the longest the command may run under the lock (0: no limit; default:
#                                              the number in <lock>.max-hold, or 7200 for --e2e and --gpu and no
#                                              limit for the rest). Past it the command and its children get TERM,
#                                              KILL after SX_HEAVY_KILL_GRACE seconds (default 60), and heavy.sh exits
#                                              124; a command that outlives KILL as well (stuck in a GPU driver) is left
#                                              running and its slots are freed after that many seconds more
#   SX_HEAVY_PROMOTE_AFTER=<seconds>           how old a waiter's ticket that is not a CI job's (and not --all) must
#                                              be before it queues as one, ahead of the CI tickets that came after it
#                                              (default: the number in <lock>.promote-after, or 1800; 0: never)
#   SX_HEAVY_COMMIT_FREE_MIN_GB=<n>            a --gpu hold on Windows (Git Bash or WSL) with less Windows commit charge
#                                              free than this asks WSL to drop its page cache before it queues (default:
#                                              the number in <lock>.commit-free-min, or 8; 0: never); see cache_check
#   SX_HEAVY_DROP_WAIT=<seconds>               how long it waits for the answer (default 40); it never blocks the hold
#   SX_HEAVY_SETTLE_S=<seconds>                after an answered drop, how long past the answer the commit is read once
#                                              more, in the background once the hold is granted (default 45; 0: never)
#   SX_HEAVY_LABEL=<text>                      who is asking, in the holder record and the history (optional)
#   SX_HEAVY_SESSION=<text>                    the session that asks (default: the run and job of a GitHub Actions
#                                              job; nothing else is read from the environment)
#   SX_HEAVY_HISTORY=<file>                    the history log (default history.log beside the lock, or
#                                              <lock>.history.log for a lock named .*; empty: none)
#   <lock>.target-dir                          a machine setting: one cargo target directory for every command run
#                                              under the lock, so worktrees do not each keep a full build (a
#                                              CARGO_TARGET_DIR the caller set wins); with it, sccache is the
#                                              RUSTC_WRAPPER when it is installed and none is set
#
# Each slot is a directory holding its holder's record (mkdir is atomic; macOS has no flock command): <lock> is the
# first, <lock>.2 the second, and so on. A slot whose holder has died is taken over, so a crashed job never wedges the
# machine: waiters judge the holders while they wait, and a holder judges the other slots once right after its take
# (in the background, so the take is not slowed), so a dead holder beside a free slot is cleared too. The record's first
# line names the pid, the start and the command; the lines after it the holder's side and process identity, its user,
# and its SX_HEAVY_LABEL and session when there are any.
#
# Waiters take a ticket in <lock>.queue, named <class>-<seconds>-<sequence>-<side>-<pid>[-all|-e2e|-gpu|-engine], where class
# 0 is a CI job (SX_HEAVY_PRIORITY=ci, or a self-hosted runner) and 1 anything else, so CI jobs go first and the rest
# are served in arrival order; the sequence number orders the tickets taken in the same second. Admission is decided
# under a gate (<lock>.gate, a directory held for the moment of a decision), so no two waiters decide at once: the
# waiter walks the queue from its head and hands the free slots to the tickets ahead of it in order, and takes one
# only when one is left for its own. A freed slot thus goes to the oldest ticket that may use it, never to the waiter
# that happens to look first, and in a poll no more waiters get in than there are free slots.
#
# A --all waiter at the head takes the slots one by one as they free up, and the tickets behind it get none, so it is
# not passed over; a --all waiter behind another one gives back what it holds. A --all waiter that is not a CI job
# (class 1) also gives back what it holds, and takes nothing, while any CI ticket waits: CI jobs never wait for a manual
# --all run to collect the machine. It goes when no CI ticket is waiting. A CI --all waiter keeps its slots. Slots a
# --all waiter holds while it still waits (its ticket still in the queue) are not an exclusive run: its ticket's place
# in the queue counts, as every other ticket's does. A --e2e holder's record says "class e2e";
# while one holds or is handed a slot, no other --e2e waiter takes one (two browser suites drawing software WebGL
# overload a machine). A waiting --e2e ticket that may take a slot keeps one free for itself while it waits for the
# --gpu runs to end, so the jobs behind it cannot starve it; one that waits for another --e2e run needs no such slot
# (that run's slot frees when it ends), and other jobs use the free slots meanwhile. Every waiter judges the holders now
# and then, so one that cannot does not wedge the queue. A ticket left alone for 2 minutes is a dead waiter's, and is
# dropped; a waiter refreshes its own on every poll and between the checks of a slow judgement.
#
# A --gpu holder's record says "class gpu", in one of the GPU slots, which plain waiters neither take nor count: the
# GPU lane's suites draw on the GPU and run side by side, while agents keep their own slots. The free GPU slots go to
# the --gpu tickets in order, and only while no --e2e holder or admitted --all holder holds and no --e2e or --all ticket
# is ahead in the queue (class first, then time), so an exclusive run is never starved and is never passed by a ticket
# that queued behind it. An --e2e or --all waiter behind a --gpu ticket that is handed a GPU slot waits for it: no
# --e2e or --all run ever starts beside a --gpu run.
#
# A --gpu run also slices on the CPU in several browsers at once, and fails beside an engine test suite (spawn errors,
# closed browsers and test timeouts while cargo held the other slots). A hold made with --class engine is one (its
# record says "class engine"; CI's Rust test steps set it), and so is a plain hold whose command runs cargo, whoever
# runs it. So a --gpu run gets the machine to itself: it starts only while at most SX_HEAVY_GPU_ENGINE (default 0)
# engine holds run, and while one holds or is handed a GPU slot, engine waiters take slots only up to that many. A
# --gpu ticket anywhere in the queue that only the engine holds keep out is about to be handed a GPU slot, and the
# engine waiters, ahead of it or behind it, wait for it as well. Other plain jobs are not limited. No engine waiter
# starves: once its ticket is SX_HEAVY_ENGINE_STARVE seconds old (default 240) it takes the next turn. While it waits
# with a plain slot free for it, no --gpu ticket is handed a GPU slot, and it starts as soon as the --gpu runs end, or
# at twice that age beside a --gpu run that still holds, so the GPU lane costs an engine hold at most that long.
#
# A manual (class 1) --e2e waiter that cannot run yet (a --gpu run or another --e2e run blocks it) gives its turn back:
# it keeps its place in the queue but holds nobody back, so the waiters behind it use what is free meanwhile. Once its
# ticket is SX_HEAVY_RESERVE_AFTER seconds old (default 900) it keeps its turn as a CI waiter does from the start: the
# free slot it needs is kept for it, and the --gpu waiters behind it wait, so it is never starved. Each time what
# blocks a waiter changes, it prints one line naming the holders or tickets in its way.
#
# A holder's record names its max hold ("hold <seconds> grace <seconds>"). A waiter takes over a slot whose record is
# older than that hold, twice the grace and 5 minutes more, even when the holder cannot be proved dead: by then the
# holder's own heavy.sh should have stopped the command and let go, so it is stuck, or gone on a side that cannot be
# asked. A record with no hold line (from an older heavy.sh) gets the max hold of its class on this machine. A holder
# whose slot was taken over leaves it alone when it ends. A waiter's ticket that is not a CI job's is renamed to a CI
# one once it is SX_HEAVY_PROMOTE_AFTER seconds old, so a steady stream of CI jobs cannot starve it.
#
# The history log gets a line for every take, release, take-over, give-up, timeout, kill, abandon and promotion: the
# time, the event, the mode, the slots, the side and pid, the user, the label, the session, the details and the
# command, separated by tabs. It is renamed to <history>.1 at about 1 MB.
#
# Windows (Git Bash) and WSL on one machine share one lock when both name the same directory on the Windows drive,
# for example C:\Users\<user>\.slicerx-heavy.lock (a C:\ path works on both sides). The record names the holder's
# side, and a holder is checked on its own side: through powershell.exe for a Windows holder, through wsl.exe for a
# WSL one. See README.md for the rules.
set -uo pipefail
# The queue's order is the byte order of the ticket names, whatever the caller's locale; the command runs in its own.
sx_lc_all=${LC_ALL+1}${LC_ALL:-} sx_lc_collate=${LC_COLLATE+1}${LC_COLLATE:-}
[ -z "${LC_ALL:-}" ] || LC_ALL=C
LC_COLLATE=C
tab=$'\t' cr=$'\r' nl=$'\n'
all= e2e= gpu= engine=
usage="usage: heavy.sh [--all | --e2e | --gpu | --class engine] <command...>"
while :; do
  case ${1:-} in
    --all) all=1; shift ;;
    --e2e) e2e=1; shift ;;
    --gpu) gpu=1; shift ;;
    --class)
      [ "${2:-}" = engine ] || { echo "heavy.sh: the only class is engine" >&2; echo "$usage" >&2; exit 2; }
      engine=1; shift 2 ;;
    *) break ;;
  esac
done
[ -z "$all" ] || { e2e=; gpu=; }
[ -z "$e2e" ] || gpu=
[ -z "$all$e2e$gpu" ] || engine=
[ $# -gt 0 ] || { echo "$usage" >&2; exit 2; }
mode=plain
[ -z "$all" ] || mode=all
[ -z "$e2e" ] || mode=e2e
[ -z "$gpu" ] || mode=gpu
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
gslots=${SX_HEAVY_GPU_SLOTS:-$(head -n 1 "$lock.gpu-slots" 2> /dev/null | tr -dc 0-9)}
case $gslots in '' | *[!0-9]* | 0) gslots=1 ;; esac
[ "$gslots" -le 8 ] || gslots=8
# How many engine holds may run beside a --gpu run (default 0: none, so a --gpu run has the machine to itself).
geng=${SX_HEAVY_GPU_ENGINE:-$(head -n 1 "$lock.gpu-engine" 2> /dev/null | tr -dc 0-9)}
case $geng in '' | *[!0-9]*) geng=0 ;; esac
# How old a manual --e2e or --gpu waiter's ticket must be before it holds the others back for its turn. The machine
# setting is read again at every decision (with read, no fork), so a change to it reaches the waiters already queued.
# The same for how long an engine waiter waits for the GPU lane before it takes the next turn.
setting() {
  local v=$2
  [ -n "$v" ] || { read -r v < "$lock.$3"; } 2> /dev/null
  v=${v%"$cr"}
  case $v in '' | *[!0-9]*) v=$4 ;; esac
  printf -v "$1" %s "$v"
}
reserve_read() {
  setting reserve_after "${SX_HEAVY_RESERVE_AFTER:-}" reserve-after 900
  setting engine_starve "${SX_HEAVY_ENGINE_STARVE:-}" engine-starve 240
  setting promote_after "${SX_HEAVY_PROMOTE_AFTER:-}" promote-after 1800
}
reserve_read
# The max hold on this machine for a holder of class $2 (e2e, gpu or anything else), into variable $1: the machine
# setting, or 2 hours for a browser run (a hung browser or GPU driver must not keep the lock all day) and none for the
# rest (a nightly run or a release build may take long).
hold_for() {
  local mh
  setting mh "" max-hold ""
  [ -n "$mh" ] || case $2 in e2e | gpu) mh=7200 ;; *) mh=0 ;; esac
  printf -v "$1" %s "$mh"
}
hold_for max_hold "$mode"
case ${SX_HEAVY_MAX_HOLD:-} in '' | *[!0-9]*) ;; *) max_hold=$SX_HEAVY_MAX_HOLD ;; esac
grace=${SX_HEAVY_KILL_GRACE:-60}
case $grace in '' | *[!0-9]*) grace=60 ;; esac
# The GPU slot directories, for --gpu holders only: <lock>.gpu.1 up to <lock>.gpu.<gslots>.
gpu_dirs=()
for ((i = 1; i <= gslots; i++)); do gpu_dirs+=("$lock.gpu.$i"); done
case $lock in */.*) hist_default=$lock.history.log ;; */*) hist_default=${lock%/*}/history.log ;; *) hist_default=history.log ;; esac
hist=${SX_HEAVY_HISTORY-$hist_default}

case "$(uname -s)" in
  Darwin)
    side=darwin
    # A shell started by ssh has only the system PATH, without Homebrew or cargo, so a command a caller passes
    # (timeout, cargo, pnpm) would not be found. Their directories go at the end, so a caller's own PATH still wins.
    for d in /opt/homebrew/bin /usr/local/bin "$HOME/.cargo/bin"; do
      case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH=$PATH:$d ;; esac
    done
    export PATH
    ;;
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
# wsl.exe with its output cleaned of NULs and carriage returns, and its own exit status (124 when it timed out). The
# NULs are stripped inside the substitution, so bash never warns that it ignored a null byte.
wslx() { local o rc; o=$(set -o pipefail; winrun wsl.exe "$@" 2> /dev/null | tr -d '\0\r'); rc=$?; printf '%s\n' "$o"; return $rc; }
# The path of Windows program $1, into wx; fails when there is none.
winexe() {
  local sys
  # A WSL distro with appendWindowsPath=false has no Windows directories on PATH: look in System32 itself, or a
  # Windows holder could never be judged dead from there.
  if ! wx=$(command -v "$1"); then
    [ "$side" = wsl ] && sys=$(wslpath -u 'C:\Windows\System32' 2> /dev/null) || return 127
    case $1 in powershell.exe) wx=$sys/WindowsPowerShell/v1.0/powershell.exe ;; *) wx=$sys/$1 ;; esac
    [ -x "$wx" ] || return 127
  fi
}
# Runs a Windows program, for at most 30 s. WSL runs it through /init, as its binfmt entry would: a distro that runs
# systemd can lose that entry, and then a plain call fails.
winrun() {
  local exe wx
  winexe "$1" || return 127
  exe=$wx
  shift
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
  local installed
  installed=$(wslx -l -q) || return 0
  # WSL distros belong to one Windows user: from another user (a CI runner's own account) the holder's distro is not
  # installed, so it cannot be asked about, and its holder counts as alive.
  if [ -n "$r_distro" ]; then grep -qxF "$r_distro" <<< "$installed" || return 0; else [ -n "$installed" ] || return 0; fi
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

# One line of text for a record or the history: no tabs, carriage returns or line breaks.
one_line() { local s=${1//$tab/ }; s=${s//$cr/}; s=${s//$nl/ }; printf %s "$s"; }
user=${USER:-${USERNAME:-}}
[ -n "$user" ] || user=$(id -un 2> /dev/null)
label=$(one_line "${SX_HEAVY_LABEL:-}")
# The record and the history name the session only from SX_HEAVY_SESSION or the Actions run, never from the rest of
# the environment, which can hold tokens.
session=${SX_HEAVY_SESSION:-}
if [ -z "$session" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  session="run ${GITHUB_REPOSITORY:-}/${GITHUB_RUN_ID}/${GITHUB_RUN_ATTEMPT:-1} job ${GITHUB_JOB:-}"
fi
session=$(one_line "$session")

me=$(identity)
q=$lock.queue
gate=$lock.gate
mkdir -p "$q" 2> /dev/null
# CI jobs (a self-hosted runner, or SX_HEAVY_PRIORITY=ci) queue ahead of other waiters; a holder always finishes.
prio=1
if [ "${SX_HEAVY_PRIORITY:-}" = ci ] || [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ]; then prio=0; fi
ticket= held=() gated= ran= t_run= timed_out=
if stat -c %Y / > /dev/null 2>&1; then gnu_stat=1; else gnu_stat=; fi
mtime() { if [ -n "$gnu_stat" ]; then stat -c %Y "$1" 2> /dev/null; else stat -f %m "$1" 2> /dev/null; fi; }
now() { date +%s; }

# Appends a line to the history: event $1, slots $2, details $3.
hist_line() {
  [ -n "$hist" ] || return 0
  { printf '%s\t%s\t%s\t%s\t%s:%s\t%s\t%s\t%s\t%s\t%s\n' "$(date '+%FT%T%z')" "$1" "$mode" "$2" "$side" $$ "$user" \
    "$label" "$session" "$3${engine:+, class engine}" "$(one_line "$cmd")" >> "$hist"; } 2> /dev/null
}
# Renames the history to <history>.1 at about 1 MB. Called under the gate only, so two waiters never rotate at once.
hist_rotate() {
  [ -n "$hist" ] && [ -f "$hist" ] || return 0
  local size; size=$(wc -c < "$hist" 2> /dev/null | tr -dc 0-9)
  [ "${size:-0}" -lt 1048576 ] || mv -f "$hist" "$hist.1" 2> /dev/null
  return 0
}
slot_names() { local d s=; for d in ${held[@]+"${held[@]}"}; do s="$s${s:+,}${d##*/}"; done; printf %s "$s"; }

# The gate: one decision at a time. It is held for a moment only, so one older than 30 s was left by a waiter that died
# while it decided, and is cleared.
gate_take() {
  local i m
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    mkdir "$gate" 2> /dev/null && { gated=1; return 0; }
    if [ $((i % 5)) = 0 ]; then
      m=$(mtime "$gate")
      if [ -n "$m" ] && [ $(($(now) - m)) -ge 30 ]; then
        echo "heavy.sh: cleared a gate left for $(($(now) - m)) s" >&2; rm -rf "$gate" 2> /dev/null; continue
      fi
    fi
    sleep 0.1 2> /dev/null || sleep 1
  done
  return 1
}
# Windows refuses to remove a directory another process is looking into, so the removal is tried a few times.
gate_drop() {
  [ -n "$gated" ] || return 0
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do rmdir "$gate" 2> /dev/null; [ -e "$gate" ] || break; sleep 0.1 2> /dev/null || sleep 1; done
  gated=
}
# The next sequence number of the queue, taken under the gate.
seq_next() {
  local s=
  read -r s 2> /dev/null < "$q/.seq"
  case $s in '' | *[!0-9]*) s=0 ;; esac
  s=$(((10#$s + 1) % 1000000))
  { printf '%s\n' "$s" > "$q/.seq"; } 2> /dev/null
  printf %06d "$s"
}
new_ticket() { ticket=$q/$prio-$(now)-$1-$side-$$${all:+-all}${e2e:+-e2e}${gpu:+-gpu}${engine:+-engine}; touch "$ticket" 2> /dev/null; }
refresh() { [ -z "$ticket" ] || touch "$ticket" 2> /dev/null || { mkdir -p "$q" 2> /dev/null; touch "$ticket" 2> /dev/null; }; }

# Windows refuses to remove a directory another process is looking into (a waiter reading the record), and a slot
# left empty that way would have no record to judge, so the removal is tried a few times.
release() {
  local rc=$? d i slots_held
  [ -z "$ticket" ] || rm -f "$ticket"
  slots_held=$(slot_names)
  for d in ${held[@]+"${held[@]}"}; do
    if ! ours "$d"; then
      [ ! -e "$d" ] || echo "heavy.sh: ${d##*/} was taken over while this held it; left to its new holder" >&2
      continue
    fi
    for i in 1 2 3 4 5; do rm -rf "$d" 2> /dev/null; [ -e "$d" ] || break; sleep 1; done
  done
  gate_drop
  [ -z "$ran" ] || hist_line release "$slots_held" "rc $rc, held $((SECONDS - t_run)) s${timed_out:+, stopped at the max hold of $max_hold s}"
}
# Whether slot $1 still holds this holder's record: a slot taken over (its holder judged stale) may have a new holder.
ours() {
  local o
  o=$(cat "$1/owner" 2> /dev/null) || return 1
  [[ $o == "pid $$ since "* && $o == *"$nl$me$nl"* ]]
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Takes a free slot: writes this holder's record into it at once, so no waiter ever finds it without one for long.
take() {
  mkdir "$1" 2> /dev/null || return 1
  printf 'pid %s since %s: %s\n%s\nuser %s\nhold %s grace %s\n%s%s%s' $$ "$(date '+%F %T')" "${all:+(all slots) }$(one_line "$cmd")" \
    "$me" "$user" "$max_hold" "$grace" "${label:+label $label
}" "${session:+session $session
}" "${e2e:+class e2e
}${gpu:+class gpu
}${engine:+class engine
}" > "$1/owner"
  held+=("$1")
}
mine() { local d; for d in ${held[@]+"${held[@]}"}; do [ "$d" = "$1" ] && return 0; done; return 1; }
# Reads the record in slot $1: r_head its first line, r_class e2e, gpu or engine, r_label its label, r_side its side.
read_rec() {
  local l n=0
  r_head= r_class= r_label= r_side=
  while IFS= read -r l || [ -n "$l" ]; do
    n=$((n + 1)); [ $n = 1 ] && r_head=$l
    case $l in 'class e2e') r_class=e2e ;; 'class gpu') r_class=gpu ;; 'class engine') r_class=engine ;; 'label '*) r_label=${l#label } ;; 'side '*) r_side=${l#side } ;; esac
  done 2> /dev/null < "$1/owner"
}
# The holders, for the waiting message.
holders_of() {
  local d s= age lim grc
  for d in "$@"; do
    mine "$d" && continue
    [ -e "$d" ] || continue
    read_rec "$d"
    s="$s${s:+; }${r_head:-holder starting}${r_label:+ [$r_label]}"
    held_for "$d" && s="$s (held $age s${lim:+, max hold $lim s})"
  done
  printf %s "$s"
}
# How long the holder of slot $1 has held it, on the lock's own clock (our ticket's mtime) into age, and its max hold
# into lim (empty when it has none), from its record or, for a record with no hold line, the max hold of its class
# here; grc its grace. Fails when the record cannot be read.
held_for() {
  local m t0 rec h cls=
  rec=$(cat "$1/owner" 2> /dev/null) && m=$(mtime "$1/owner") && [ -n "$m" ] || return 1
  t0=$([ -n "$ticket" ] && mtime "$ticket"); [ -n "$t0" ] || t0=$(now)
  age=$((t0 - m)) grc=60
  h=$(sed -n 's/^hold \([0-9]*\) grace \([0-9]*\)$/\1 \2/p' <<< "$rec")
  if [ -n "$h" ]; then grc=${h#* } lim=${h% *}
  else
    case $rec in *"${nl}class e2e"*) cls=e2e ;; *"${nl}class gpu"*) cls=gpu ;; esac
    hold_for lim "$cls"
  fi
  [ "$lim" -gt 0 ] || lim=
  [ "$age" -ge 0 ] || age=0
}
# Judges the holder of slot $1 and frees the slot when the holder is dead (or it was left with no record), or alive
# but past its max hold by more than its own heavy.sh needs to stop it.
judge_slot() {
  local d=$1 rec t m age lim grc
  rec=$(cat "$d/owner" 2> /dev/null)
  # Take over only the record judged dead, not one a new holder wrote meanwhile.
  if [ -n "$rec" ] && ! alive "$rec" && [ "$(cat "$d/owner" 2> /dev/null)" = "$rec" ]; then
    echo "heavy.sh: taking over a lock left by $(sed -n '1s/ since.*//p' <<< "$rec") ($(sed -n 's/^side //p' <<< "$rec"))" >&2
    rm -rf "$d"
    hist_line clear "${d##*/}" "dead holder: $(one_line "$(sed -n '1p' <<< "$rec")")"
    return 0
  fi
  if [ -n "$rec" ] && held_for "$d" && [ -n "$lim" ] && [ "$age" -ge $((lim + 2 * grc + 300)) ] &&
    [ "$(cat "$d/owner" 2> /dev/null)" = "$rec" ]; then
    echo "heavy.sh: taking over a lock held past its max hold by $(sed -n '1s/ since.*//p' <<< "$rec") ($(sed -n 's/^side //p' <<< "$rec"), held $age s, max hold $lim s); the holder is left running" >&2
    rm -rf "$d"
    hist_line clear "${d##*/}" "stale holder: held $age s, max hold $lim s: $(one_line "$(sed -n '1p' <<< "$rec")")"
    return 0
  fi
  # No record: a holder between mkdir and writing it, or a slot whose removal failed half way. Only one older than
  # $orphan seconds is cleared, and rmdir removes it only while it is still empty.
  if [ -z "$rec" ] && [ -d "$d" ] && [ ! -e "$d/owner" ]; then
    t=$(now); m=$(mtime "$d")
    if [ -n "$m" ] && [ $((t - m)) -ge "$orphan" ] && rmdir "$d" 2> /dev/null; then
      echo "heavy.sh: cleared a lock with no holder record, left for $((t - m)) s" >&2
      hist_line clear "${d##*/}" "no holder record for $((t - m)) s"
      return 0
    fi
  fi
  return 1
}
# Judges every slot but this holder's own once, right after its take. A job cancelled past its traps leaves a dead
# holder, and while a slot beside it is free no waiter waits for its slot to judge it. It runs in the background on
# none of the caller's streams (the history logs what it clears), so the take is not slowed and nothing waits for it.
reap() {
  local d
  trap - EXIT INT TERM
  for d in "${slot_dirs[@]}" "${gpu_dirs[@]}"; do
    mine "$d" || [ ! -e "$d" ] || judge_slot "$d"
  done
  exit 0
}
# Drops the tickets of dead waiters: those left alone for 2 minutes (on the lock's own clock: our ticket's mtime). Warns
# once about a ticket from a heavy.sh older than 2026-10-08 (<seconds>-<side>-<pid>): it sorts after every ticket of
# this one, and such a copy only tries the lock while its own ticket is first, so it waits as long as others keep coming.
sweep() {
  local t0 m t list
  t0=$([ -n "$ticket" ] && mtime "$ticket"); [ -n "$t0" ] || t0=$(now)
  if [ -n "$gnu_stat" ]; then list=$(stat -c '%Y %n' "$q"/* 2> /dev/null); else list=$(stat -f '%m %N' "$q"/* 2> /dev/null); fi
  while read -r m t; do
    case $m in '' | *[!0-9]*) continue ;; esac
    if [ "$t" != "$ticket" ] && [ $((t0 - m)) -ge 120 ]; then rm -f "$t"; continue; fi
    case ${t##*/} in
      [01]-*) ;;
      *)
        [ -n "$old_warned" ] && continue
        old_warned=1
        echo "heavy.sh: an older heavy.sh waits in the queue (${t##*/}) and cannot be served in order; update it to this one" >&2
        hist_line old-copy "" "ticket ${t##*/}" ;;
    esac
  done <<< "$list"
}
old_warned=

# Helpers for decide, with no subshells (a fork is slow in Git Bash): wn, a holder's short name from read_rec; add, a
# name appended to the comma list in variable $1; tt, ticket $1's queue time; keeps_turn, whether --e2e ticket $1 keeps
# its turn while it cannot run: a CI ticket always, a manual one once it is $reserve_after s old; starved, whether
# engine ticket $1 has waited $engine_starve s or more, and so takes the next turn.
who() { local p=${r_head#pid }; p=${p%% *}; wn="pid $p${r_label:+ [$r_label]}"; }
add() { local cur=${!1}; printf -v "$1" '%s' "$cur${cur:+, }$2"; }
ticket_time() { tt=${1##*/}; tt=${tt#[01]-}; tt=${tt%%-*}; case $tt in '' | *[!0-9]*) tt=$tnow ;; esac; }
starved() {
  case ${1##*/} in *-engine) ;; *) return 1 ;; esac
  ticket_time "$1"
  [ $((tnow - tt)) -ge "$engine_starve" ]
}
keeps_turn() {
  case ${1##*/} in 0-*) return 0 ;; esac
  ticket_time "$1"
  [ $((tnow - tt)) -ge "$reserve_after" ]
}
last_why=
# The admission decision, under the gate. Walks the queue from its head and hands out the free slots in ticket order,
# as every waiter would; takes this waiter's slot when one is left for it. Sets admitted, and front when the waiter is
# near enough to the head to judge the holders on every poll.
decide() {
  local d t p F=0 GF=0 PE=0 e2e_blk= gpu_blk= excl_blk= excl_ahead= all_ahead= ci_ahead= ahead=0 gahead=0
  local e2e_by= gpu_by= excl_by= ahead_by= engine_by= all_by= tnow tt wn why key
  local est= est_by= gwant= gwant_by= gx= gf gb age=0 left
  admitted= front= tnow=$(now)
  reserve_read
  # F: free plain slots. e2e_blk: an --e2e run holds or is handed a plain slot, so no other --e2e may take one.
  # excl_blk: an --e2e run or an admitted --all run holds a plain slot, so no --gpu may take a GPU slot. A --all waiter
  # still collecting slots has its ticket in the queue: the walk below meets it in queue order, so a --gpu ticket ahead
  # of it still gets its GPU slot, and the --all waiter then waits for that run to end. PE: engine holds others run, or
  # engine slots handed to tickets ahead in the walk; beside a --gpu run there may be at most $geng.
  for d in "${slot_dirs[@]}"; do
    [ -e "$d" ] || { F=$((F + 1)); continue; }
    mine "$d" && continue
    read_rec "$d"
    who; add all_by "$wn"
    [ "$r_class" = e2e ] && { e2e_blk=1; excl_blk=1; add e2e_by "$wn"; add excl_by "$wn"; }
    case $r_head in
      *': (all slots) '*)
        # A --all waiter still collecting slots runs nothing in them yet.
        p=${r_head#pid }; p=${p%% *}
        if [ -n "$r_side" ] && compgen -G "$q/[01]-*-$r_side-$p-all" > /dev/null; then continue; fi
        excl_blk=1; add excl_by "$wn" ;;
    esac
    [ "$r_class" = engine ] && { PE=$((PE + 1)); add engine_by "$wn"; }
  done
  # GF: free GPU slots. gpu_blk: a --gpu run holds a GPU slot or is handed one, so no --e2e or --all may start, and
  # engine waiters keep to $geng slots.
  for d in "${gpu_dirs[@]}"; do
    if [ -e "$d" ]; then mine "$d" || { gpu_blk=1; read_rec "$d"; who; add gpu_by "$wn"; }; else GF=$((GF + 1)); fi
  done
  # est: an engine waiter that has waited $engine_starve s takes the next turn, so while one waits with a plain slot
  # free for it, no --gpu ticket is handed a GPU slot.
  if [ "$F" -gt 0 ]; then
    for t in "$q"/*-engine; do [ -e "$t" ] && starved "$t" && { est=1; add est_by "ticket ${t##*/}"; }; done
  fi
  # gwant: a --gpu ticket anywhere in the queue that would be handed a GPU slot but for the engine holds (and est), in
  # queue order as the walk below would hand them out. The engine waiters that have not yet waited $engine_starve s,
  # ahead of it or behind it, wait for it.
  gf=$GF gb=$gpu_blk
  for t in "$q"/*; do
    [ -e "$t" ] || continue
    case ${t##*/} in
      *-gpu)
        if [ -z "$excl_blk" ] && [ -z "$gx" ] && [ "$gf" -gt 0 ]; then
          gf=$((gf - 1)) gwant=1; add gwant_by "ticket ${t##*/}"
          [ "$PE" -gt "$geng" ] || [ -n "$est" ] || gb=1
        fi ;;
      *-e2e) if { [ -z "$e2e_blk" ] && [ -z "$gb" ]; } || keeps_turn "$t"; then gx=1; fi ;;
      *-all) gx=1 ;;
    esac
  done
  for t in "$q"/*; do
    [ -e "$t" ] || continue
    [ "$t" = "$ticket" ] && break
    # ci_ahead: a CI ticket waits (CI tickets sort first, so for a class 1 ticket every one of them is ahead).
    case ${t##*/} in 0-*) ci_ahead=1 ;; esac
    case ${t##*/} in
      *-gpu)
        # First in line for a free GPU slot; handed it unless the engine holds or an engine waiter's turn keep it out.
        gahead=$((gahead + 1))
        if [ -z "$excl_blk" ] && [ -z "$excl_ahead" ] && [ "$GF" -gt 0 ]; then
          GF=$((GF - 1))
          if [ "$PE" -le "$geng" ] && [ -z "$est" ]; then gpu_blk=1; add gpu_by "ticket ${t##*/}"; fi
        fi ;;
      *-e2e)
        # Handed a slot to run in, or, while it keeps its turn, a slot kept free while the --gpu runs end, with the
        # --gpu tickets behind it kept out; behind another --e2e run, no slot. One that gives its turn back holds nothing.
        ahead=$((ahead + 1))
        if { [ -z "$e2e_blk" ] && [ -z "$gpu_blk" ]; } || keeps_turn "$t"; then
          excl_ahead=1; add ahead_by "ticket ${t##*/}"
          if [ -z "$e2e_blk" ] && [ "$F" -gt 0 ]; then F=$((F - 1)) e2e_blk=1; add e2e_by "ticket ${t##*/}"; fi
        fi ;;
      *-all) ahead=$((ahead + 1)) excl_ahead=1 all_ahead=1 F=0; add ahead_by "ticket ${t##*/}" ;;
      *-engine)
        # Handed a slot while no --gpu run holds or is about to get one, or, once it has waited $engine_starve s, a
        # slot kept for its turn while the --gpu runs end.
        ahead=$((ahead + 1))
        if [ "$F" -gt 0 ] && { starved "$t" || { [ -z "$gpu_blk" ] && [ -z "$gwant" ]; } || [ "$PE" -lt "$geng" ]; }; then
          F=$((F - 1)) PE=$((PE + 1)); add engine_by "ticket ${t##*/}"
        fi ;;
      *)
        ahead=$((ahead + 1))
        [ "$F" -gt 0 ] && F=$((F - 1)) ;;
    esac
  done
  if [ -n "$gpu" ]; then [ "$gahead" -lt "$gslots" ] && front=1; else [ "$ahead" -lt "$slots" ] && front=1; fi
  # What blocks this waiter, said in one line each time it changes.
  why= key=
  # An engine waiter's age: past $engine_starve s it has the next turn, past twice that it starts beside a --gpu run.
  if [ -n "$engine" ] && [ -n "$ticket" ]; then ticket_time "$ticket"; age=$((tnow - tt)); fi
  case $mode in
    plain)
      if [ "$F" = 0 ]; then why="every slot is held or handed to a ticket ahead (${all_by:-queue ahead})"
      elif [ -z "$engine" ] || [ "$PE" -lt "$geng" ] || [ "$age" -ge $((2 * engine_starve)) ]; then :
      elif [ "$age" -ge "$engine_starve" ]; then
        left=$((2 * engine_starve - age))
        [ -z "$gpu_blk" ] || { why="a --gpu run holds ($gpu_by); it has the next turn, and starts beside it in $left s"; key="gpu next"; }
      elif [ -n "$gpu_blk" ] || [ -n "$gwant" ]; then
        left=$((engine_starve - age))
        if [ -n "$gpu_blk" ]; then why="a --gpu run holds or is handed a GPU slot ($gpu_by)"
        else why="a --gpu waiter is about to be handed a GPU slot ($gwant_by)"; fi
        key=$why why="$why; it takes the next turn in $left s"
      fi ;;
    e2e)
      if [ "$F" = 0 ]; then why="every slot is held or handed to a ticket ahead (${all_by:-queue ahead})"
      elif [ -n "$e2e_blk" ]; then why="another --e2e run holds or is handed a slot ($e2e_by)"
      elif [ -n "$gpu_blk" ]; then why="a --gpu run holds or is handed a GPU slot ($gpu_by)"; fi ;;
    gpu)
      if [ -n "$excl_blk" ]; then why="an --e2e or --all run holds a slot ($excl_by)"
      elif [ -n "$excl_ahead" ]; then why="an --e2e or --all ticket is ahead in the queue ($ahead_by)"
      elif [ "$GF" = 0 ]; then why="every GPU slot is held or handed to a ticket ahead (${gpu_by:-queue ahead})"
      elif [ -n "$est" ]; then why="an engine waiter has waited past $engine_starve s and takes the next turn ($est_by)"
      elif [ "$PE" -gt "$geng" ] && [ "$geng" = 0 ]; then
        why="engine holds run or are handed a slot ($engine_by), and a --gpu run starts only once none does"
      elif [ "$PE" -gt "$geng" ]; then why="$PE engine holds run or are handed a slot, at most $geng beside a --gpu run ($engine_by)"; fi ;;
  esac
  [ -n "$key" ] || key=$why
  if [ -n "$why" ] && [ -n "$ticket" ] && [ "$mode" = e2e ]; then
    if keeps_turn "$ticket"; then why="$why; it keeps its turn"; key="$key keeps"
    else ticket_time "$ticket"; why="$why; it gives its turn back for $((reserve_after - (tnow - tt))) s more"; fi
  fi
  [ -z "$why" ] || [ "$key" = "$last_why" ] || echo "heavy.sh: waiting: $why" >&2
  last_why=$key
  case $mode in
    plain | e2e)
      [ "$F" -gt 0 ] || return 0
      # An engine waiter: no --gpu run holds or is about to get a GPU slot; past $engine_starve s, only the --gpu runs
      # that hold count; past twice that, none.
      if [ -n "$engine" ] && [ "$PE" -ge "$geng" ] && [ "$age" -lt $((2 * engine_starve)) ]; then
        [ -z "$gpu_blk" ] || return 0
        [ "$age" -ge "$engine_starve" ] || [ -z "$gwant" ] || return 0
      fi
      [ "$mode" = plain ] || { [ -z "$e2e_blk" ] && [ -z "$gpu_blk" ]; } || return 0
      for d in "${slot_dirs[@]}"; do take "$d" && { admitted=1; return 0; }; done ;;
    gpu)
      [ -z "$excl_blk" ] && [ -z "$excl_ahead" ] && [ "$GF" -gt 0 ] && [ "$PE" -le "$geng" ] && [ -z "$est" ] || return 0
      for d in "${gpu_dirs[@]}"; do take "$d" && { admitted=1; return 0; }; done ;;
    all)
      if [ -n "$all_ahead" ] || { [ "$prio" = 1 ] && [ -n "$ci_ahead" ]; }; then
        # Another --all waits ahead: give back what this one holds, or the two would wait for each other. Not a CI
        # job while a CI ticket waits: give back what it holds and take nothing, so the CI jobs run first.
        if [ "${#held[@]}" -gt 0 ]; then
          for d in "${held[@]}"; do rm -rf "$d" 2> /dev/null; done
          held=()
        fi
        return 0
      fi
      for d in "${slot_dirs[@]}"; do
        [ "$F" -gt 0 ] || break
        mine "$d" || ! take "$d" || F=$((F - 1))
      done
      # The machine alone: also no GPU run left, and none handed a GPU slot ahead of this ticket (none behind it
      # starts while this waits or holds).
      [ "${#held[@]}" = "$slots" ] && [ -z "$gpu_blk" ] && admitted=1 ;;
  esac
  return 0
}
# The command as the record and the history show it, with anything that looks like a secret replaced by [redacted]:
# the value of NAME=value when NAME has TOKEN, KEY, SECRET, PASS or AUTH in it, the argument after a --token, --key,
# --password, --secret or --auth flag (or its =value), and the shapes of common access tokens. The command itself
# runs with its arguments as given.
redact() {
  local out= a hide= q="[^[:space:]\"']"
  for a in "$@"; do
    if [ -n "$hide" ]; then a="[redacted]"; hide=; fi
    case $a in --[Tt][Oo][Kk][Ee][Nn] | --[Kk][Ee][Yy] | --[Aa][Pp][Ii]-[Kk][Ee][Yy] | --[Pp][Aa][Ss][Ss] | --[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd] | --[Ss][Ee][Cc][Rr][Ee][Tt] | --[Aa][Uu][Tt][Hh]) hide=1 ;; esac
    out="$out${out:+ }$a"
  done
  printf %s "$out" | sed -E \
    -e "s/([A-Za-z0-9_]*([Tt][Oo][Kk][Ee][Nn]|[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss]|[Aa][Uu][Tt][Hh])[A-Za-z0-9_]*)=$q+/\1=[redacted]/g" \
    -e "s/(--?([Tt]oken|[Kk]ey|[Aa]pi-[Kk]ey|[Pp]assword|[Ss]ecret|[Aa]uth)=)$q+/\1[redacted]/g" \
    -e "s/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/\1[redacted]/g" \
    -e "s/sk-[A-Za-z0-9_-]{16,}/sk-[redacted]/g" \
    -e "s/xox[abprs]-[A-Za-z0-9-]+/xox-[redacted]/g" \
    -e "s/AKIA[0-9A-Z]{16}/AKIA[redacted]/g" \
    -e "s/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/[redacted]/g"
}
cmd=$(redact "$@")
# A plain hold whose command runs cargo (a word of it that is cargo, alone or at the end of a path, also inside a
# sh -c script) is an engine hold, whoever runs it, so a cargo test or build never runs beside a --gpu run.
if [ -z "$all$e2e$gpu$engine" ]; then
  for sx_arg in "$@"; do
    case " $sx_arg " in *[[:space:]/]cargo[[:space:]]* | *[[:space:]/]cargo.exe[[:space:]]*) engine=1; break ;; esac
  done
fi

# Renames this waiter's ticket from class 1 to class 0 once it is $promote_after s old, under the gate: it then sorts
# with the CI tickets by its time, ahead of every CI job that queued after it. A --all waiter is never promoted (it
# would take the whole machine from CI).
promote() {
  local tt tnow new
  [ "$promote_after" -gt 0 ] && [ -z "$all" ] && [ -n "$ticket" ] || return 0
  case ${ticket##*/} in 1-*) ;; *) return 0 ;; esac
  tnow=$(now); ticket_time "$ticket"
  [ $((tnow - tt)) -ge "$promote_after" ] || return 0
  new=$q/0-${ticket##*/1-}
  mv -f "$ticket" "$new" 2> /dev/null || return 0
  ticket=$new
  echo "heavy.sh: waited $((tnow - tt)) s behind CI jobs; now queued as one, ahead of those that came after it" >&2
  hist_line promote "" "ticket ${ticket##*/}, waited $((tnow - tt)) s"
}

# Signals process $2 and every process under it with $1 (TERM or KILL). The tree is read before any signal, so the
# children of a process that dies first are still found. In Git Bash, ps lists the MSYS processes (its own format: an
# optional status letter, then the pid and the parent pid), and taskkill ends the native Windows ones under the command.
kill_tree() {
  local sig=$1 p=$2 w= tree
  if [ "$side" = msys ]; then
    w=$(cat "/proc/$p/winpid" 2> /dev/null)
    tree=$(ps -e 2> /dev/null | awk 'NR > 1 { sub(/^[ \t]*[A-Za-z][ \t]/, " "); print $1, $2 }')
  else
    tree=$(ps -A -o pid= -o ppid= 2> /dev/null)
  fi
  tree=$(awk -v root="$p" '{ kids[$2] = kids[$2] " " $1 }
    END { n = split(root, q, " "); out = root; for (i = 1; i <= n; i++) { m = split(kids[q[i]], k, " "); for (j = 1; j <= m; j++) { q[++n] = k[j]; out = out " " k[j] } } print out }' <<< "$tree")
  case $w in
    '' | *[!0-9]*) ;;
    *) if [ "$sig" = KILL ]; then MSYS_NO_PATHCONV=1 taskkill /T /F /PID "$w"; else MSYS_NO_PATHCONV=1 taskkill /T /PID "$w"; fi > /dev/null 2>&1 ;;
  esac
  kill "-$sig" ${tree:-$p} 2> /dev/null
  return 0
}
# Whether process $1 ended (or this holder let go: file $2 is gone) within $grace seconds.
gone_within() {
  local i
  for ((i = 0; i < grace; i++)); do kill -0 "$1" 2> /dev/null && [ -e "$2" ] || return 0; sleep 1; done
  ! kill -0 "$1" 2> /dev/null || [ ! -e "$2" ]
}
# Runs beside the command while a max hold is set, and ends with heavy.sh. Past the max hold it stops the command
# (pid in file $1, which goes with the slot): TERM to it and its children, KILL after $grace s. One that outlives KILL
# too (stuck in a GPU driver) is left running, and after $grace s more its slots are freed so the queue moves on.
watchdog() {
  local pidf=$1 end=$((SECONDS + max_hold)) p step d
  trap - EXIT INT TERM
  while [ "$SECONDS" -lt "$end" ]; do
    kill -0 $$ 2> /dev/null && [ -e "$pidf" ] || exit 0
    step=$((end - SECONDS)); [ "$step" -le 15 ] || step=15
    sleep "$step" < /dev/null > /dev/null 2>&1
  done
  p=$(cat "$pidf" 2> /dev/null)
  [ -n "$p" ] && [ -e "$pidf" ] || exit 0
  : > "${pidf%/*}/timed-out"
  echo "heavy.sh: the command ran past the max hold of $max_hold s; stopping it (pid $p)" >&2
  hist_line timeout "$(slot_names)" "held $((SECONDS - t_run)) s, max hold $max_hold s: TERM to pid $p and its children"
  kill_tree TERM "$p"
  gone_within "$p" "$pidf" && exit 0
  echo "heavy.sh: the command did not stop within $grace s; killing it (pid $p)" >&2
  hist_line kill "$(slot_names)" "pid $p still ran $grace s after TERM: KILL to it and its children"
  kill_tree KILL "$p"
  gone_within "$p" "$pidf" && exit 0
  echo "heavy.sh: the command outlived KILL (pid $p, stuck in a driver?); freeing the lock and leaving it running" >&2
  hist_line abandon "$(slot_names)" "pid $p still ran $grace s after KILL: slots freed, process left running"
  for d in "${held[@]}"; do ours "$d" && rm -rf "$d" 2> /dev/null; done
  exit 0
}

# Windows commit charge: TotalVirtualMemorySize less FreeVirtualMemory, in KB. WSL's page cache counts toward it, and
# when it runs out, process starts fail and GPU runs crawl. So a --gpu hold reads it before it queues for a GPU slot,
# and with less than SX_HEAVY_COMMIT_FREE_MIN_GB free (the number in <lock>.commit-free-min, default 8, 0 for never) it
# asks a timer inside WSL to drop the page cache: it writes <lock>.drop-cache.request, waits up to SX_HEAVY_DROP_WAIT
# seconds (default 40) for <lock>.drop-cache.done, reads the commit again and logs one cache-drop line. None of it
# ever fails, stops or kills anything: a missing answer is logged and the hold goes on. A commit that cannot be read
# although powershell.exe is there asks for a drop as well (before "unreadable"); with no powershell.exe the check is
# skipped with one log line.
# SX_HEAVY_COMMIT_CMD (a command that prints "<total KB> <free KB>") and SX_HEAVY_POWERSHELL (the program to ask) are
# for the tests. Fails with 127 when there is no powershell.exe, and 1 when it cannot start or prints no reading.
# WSL hands the dropped cache back to Windows over a minute or so, so the reading right after the answer shows little
# of it. An answered drop sets settle_at, and once the hold is granted, settle reads the commit again then.
settle_at= settle_from= settle_who=
commit_read() {
  local out rc wx
  c_total= c_free=
  if [ -n "${SX_HEAVY_COMMIT_CMD:-}" ]; then
    out=$(sh -c "$SX_HEAVY_COMMIT_CMD" 2> /dev/null); rc=$?
  else
    winexe "${SX_HEAVY_POWERSHELL:-powershell.exe}" || return 127
    out=$(winrun "${SX_HEAVY_POWERSHELL:-powershell.exe}" -NoProfile -NonInteractive -Command \
      '$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)"' 2> /dev/null); rc=$?
  fi
  [ "$rc" = 0 ] || return 1
  read -r c_total c_free _ <<< "${out//$cr/}"
  case $c_total in '' | *[!0-9]*) return 1 ;; esac
  case $c_free in '' | *[!0-9]*) return 1 ;; esac
  [ "$c_total" -gt 0 ] && [ "$c_free" -le "$c_total" ]
}
# KB as GB with one decimal, into variable $2.
gb() { local g=$((($1 * 10 + 524288) / 1048576)); printf -v "$2" '%d.%d' $((g / 10)) $((g % 10)); }
commit_text() { local cu ct cf; gb $((c_total - c_free)) cu; gb "$c_total" ct; gb "$c_free" cf; printf -v "$1" 'used %s of %s GB, free %s GB' "$cu" "$ct" "$cf"; }
# Reads a request or done file of "<key> <value>" lines: f_time, f_id, f_result, f_detail. Fails without a time.
kv_read() {
  local k v
  f_time= f_id= f_result= f_detail=
  [ -f "$1" ] || return 1
  while IFS=' ' read -r k v || [ -n "$k" ]; do
    v=${v%"$cr"}
    case $k in time) f_time=$v ;; id) f_id=$v ;; result) f_result=$v ;; detail) f_detail=$v ;; esac
  done 2> /dev/null < "$1"
  case $f_time in '' | *[!0-9]*) return 1 ;; esac
}
cache_check() {
  local min wait_s dpoll req dfile before after who t req_t req_id end answered answered_at why settle_s
  setting min "${SX_HEAVY_COMMIT_FREE_MIN_GB:-}" commit-free-min 8
  [ "$min" -gt 0 ] || return 0
  case $side in msys | wsl) ;; *) [ -n "${SX_HEAVY_COMMIT_CMD:-}${SX_HEAVY_POWERSHELL:-}" ] || return 0 ;; esac
  wait_s=${SX_HEAVY_DROP_WAIT:-40}; case $wait_s in '' | *[!0-9]*) wait_s=40 ;; esac
  dpoll=${SX_HEAVY_DROP_POLL:-1}
  # A reading that fails although powershell.exe is there is what an exhausted commit looks like (a new process
  # cannot start), so it asks for a drop too; the timer's rate limit keeps that cheap.
  commit_read
  case $? in
    0)
      [ "$c_free" -lt $((min * 1048576)) ] || return 0
      commit_text before
      why="Windows commit charge $before, under $min GB free" ;;
    127) hist_line cache-drop "" "skipped: no powershell.exe to read the Windows commit charge"; return 0 ;;
    *) before=unreadable why="Windows commit charge unreadable" ;;
  esac
  who=${session:-${label:-$user}}
  req=$lock.drop-cache.request dfile=$lock.drop-cache.done
  t=$(now) req_t= req_id=
  # A request another hold wrote a moment ago is joined; one left unread longer than a wait means nothing answers.
  if [ -f "$req" ]; then
    kv_read "$req" || f_time=0
    if [ $((t - f_time)) -ge $((wait_s + 10)) ]; then
      echo "heavy.sh: $why; a cache drop request from $((t - f_time)) s ago is still unread" >&2
      hist_line cache-drop "" "before $before; cache drop not answered: a request from $((t - f_time)) s ago is still unread; asked by $who"
      return 0
    fi
    req_t=$f_time req_id=$f_id
  fi
  if [ -z "$req_t" ]; then
    req_t=$t req_id=$t-$side-$$
    { printf 'time %s\nid %s\nby %s\nbefore %s\n' "$t" "$req_id" "$who" "$before" > "$req.$$" && mv -f "$req.$$" "$req"; } 2> /dev/null || {
      rm -f "$req.$$" 2> /dev/null
      hist_line cache-drop "" "before $before; skipped: could not write the cache drop request"
      return 0
    }
  fi
  echo "heavy.sh: $why; asked WSL to drop its page cache" >&2
  # The answer names the request it answered; one written since the request was made answers it too.
  end=$((SECONDS + wait_s)) answered=
  while :; do
    if kv_read "$dfile" && { { [ -n "$req_id" ] && [ "$f_id" = "$req_id" ]; } || [ "$f_time" -ge "$req_t" ]; }; then
      answered=1 answered_at=$SECONDS; break
    fi
    [ "$SECONDS" -lt "$end" ] || break
    sleep "$dpoll"
  done
  if commit_read; then commit_text after; else after=unreadable; fi
  if [ -z "$answered" ]; then
    echo "heavy.sh: cache drop not answered in $wait_s s; going on" >&2
    hist_line cache-drop "" "before $before, after $after; cache drop not answered in $wait_s s; asked by $who"
  else
    echo "heavy.sh: cache drop ${f_result:-answered}; Windows commit charge now $after" >&2
    hist_line cache-drop "" "before $before, after $after; ${f_result:-answered}${f_detail:+: $f_detail}; asked by $who"
    settle_s=${SX_HEAVY_SETTLE_S:-45}; case $settle_s in '' | *[!0-9]*) settle_s=45 ;; esac
    [ "$settle_s" = 0 ] || settle_at=$((answered_at + settle_s)) settle_from=$answered_at settle_who=$who
  fi
  return 0
}
# The settled reading: one more cache-drop line, from the same side and pid as the one it follows. It runs in the
# background, holds no slot and drops this holder's traps, so it never delays the hold or its release. It moves its
# streams to /dev/null with exec first: bash keeps a copy of the caller's streams open while a function runs with
# redirections of its own, and a caller that reads heavy.sh's output through a pipe would wait for that copy. It ends
# by itself after one reading, which a hung powershell.exe cannot stretch past winrun's 30 s; a hold that ends first
# does not stop it. It writes with hist_line, as every line is.
settle() {
  local s settled
  exec < /dev/null > /dev/null 2>&1
  trap - EXIT INT TERM
  s=$((settle_at - SECONDS))
  [ "$s" -le 0 ] || sleep "$s"
  if commit_read; then commit_text settled; else settled=unreadable; fi
  hist_line cache-drop "" "settled $settled; read $((SECONDS - settle_from)) s past the answer; asked by $settle_who"
  exit 0
}
[ -z "$gpu" ] || cache_check

t0=$SECONDS next=0 judged=0
while :; do
  refresh
  sweep
  if gate_take; then
    [ -n "$ticket" ] || new_ticket "$(seq_next)"
    refresh
    promote
    decide
    if [ -n "$admitted" ]; then
      rm -f "$ticket"; ticket=
      hist_rotate
      hist_line take "$(slot_names)" "waited $((SECONDS - t0)) s$([ "$max_hold" = 0 ] || echo ", max hold $max_hold s")"
      gate_drop
      break
    fi
    gate_drop
  else
    # The gate stays busy: queue up anyway (at the back of this second), and decide on the next poll.
    [ -n "$ticket" ] || new_ticket 999999
    front=1
  fi
  # The front of the queue judges the holders on every poll; every waiter does once a minute, so one that cannot (a
  # record from a side it cannot ask) does not keep a dead holder's slot for the whole queue.
  if [ -n "$front" ] || [ $((SECONDS - judged)) -ge 60 ]; then
    judged=$SECONDS freed=
    for d in "${slot_dirs[@]}" "${gpu_dirs[@]}"; do
      mine "$d" && continue
      [ -e "$d" ] || continue
      if judge_slot "$d"; then freed=1; fi
      refresh
    done
    [ -n "$freed" ] && continue
  fi
  waited=$((SECONDS - t0))
  if [ "$waited" -ge "$next" ]; then
    if [ -n "$gpu" ]; then
      holders=$(holders_of "${gpu_dirs[@]}" "${slot_dirs[@]}")
      echo "heavy.sh: waiting for a GPU slot of $lock ($gslots GPU slot$([ "$gslots" = 1 ] || echo s): ${holders:-queue ahead})" >&2
    else
      holders=$(holders_of "${slot_dirs[@]}")
      echo "heavy.sh: waiting for $lock ($slots slot$([ "$slots" = 1 ] || echo s)${all:+, all of them}: ${holders:-queue ahead})" >&2
    fi
    next=$((next + 300))
  fi
  if [ "$max" -gt 0 ] && [ "$waited" -ge "$max" ]; then
    echo "heavy.sh: gave up after $max s" >&2
    hist_line give-up "$(slot_names)" "waited $waited s"
    exit 75
  fi
  sleep "$poll"
done
reap < /dev/null > /dev/null 2>&1 &
if [ -n "$settle_at" ]; then settle & fi
ran=1 t_run=$SECONDS
if [ -n "$sx_lc_all" ]; then LC_ALL=${sx_lc_all#1}; else unset LC_ALL; fi
if [ -n "$sx_lc_collate" ]; then LC_COLLATE=${sx_lc_collate#1}; else unset LC_COLLATE; fi
# One shared cargo target per machine, when the machine names one beside the lock. Cargo's own lock on the target
# directory keeps two holders from building into it at once.
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  sx_target=
  { read -r sx_target < "$lock.target-dir"; } 2> /dev/null
  sx_target=${sx_target%"$cr"}
  if [ -n "$sx_target" ]; then
    export CARGO_TARGET_DIR=$sx_target
    if [ -z "${RUSTC_WRAPPER:-}" ] && command -v sccache > /dev/null 2>&1; then export RUSTC_WRAPPER=sccache; fi
  fi
fi
# A machine that shares its cores with other work caps cargo and test threads under the lock with a number in
# "$lock.jobs" (one line). A value the caller already set wins; without the file nothing is capped.
sx_jobs=
{ read -r sx_jobs < "$lock.jobs"; } 2> /dev/null
sx_jobs=${sx_jobs%"$cr"}
case $sx_jobs in
  '' | *[!0-9]*) ;;
  *) export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-$sx_jobs} RUST_TEST_THREADS=${RUST_TEST_THREADS:-$sx_jobs} ;;
esac
if [ "$max_hold" -gt 0 ]; then
  # The command runs in the foreground as before, through sh, which writes its pid for the watchdog and execs it.
  pidf=${held[0]}/cmd.pid
  : > "$pidf"
  watchdog "$pidf" &
  wd=$!
  sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$pidf" "$@"
  rc=$?
  kill "$wd" 2> /dev/null
  wait "$wd" 2> /dev/null
  if [ -e "${held[0]}/timed-out" ]; then
    timed_out=1
    echo "heavy.sh: stopped at the max hold of $max_hold s (exit status $rc), reported as 124" >&2
    rc=124
  fi
else
  "$@"
  rc=$?
fi
[ "$rc" != 75 ] || { echo "heavy.sh: the command exited 75, reported as 1 (75 means heavy.sh gave up)" >&2; rc=1; }
exit $rc
