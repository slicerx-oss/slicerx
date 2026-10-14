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
#                                              only these count against SX_HEAVY_GPU_ENGINE beside a --gpu run
#   SX_HEAVY_GPU_SLOTS=<n>                     how many --gpu holders may run at once (default: the number in
#                                              <lock>.gpu-slots, or 1 when there is none)
#   SX_HEAVY_GPU_ENGINE=<n>                    how many --class engine holds may run beside a --gpu run (default:
#                                              the number in <lock>.gpu-engine, or 1 when there is none)
#   SX_HEAVY_GPU_HOLDBACK=<seconds>            how long a CI --gpu waiter that waits for the engine holds keeps the
#                                              engine waiters behind it out (default: the number in
#                                              <lock>.gpu-holdback, or 300 when there is none)
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
# machine. The record's first line names the pid, the start and the command; the lines after it the holder's side and
# process identity, its user, and its SX_HEAVY_LABEL and session when there are any.
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
# A --gpu run also slices on the CPU in several browsers at once, and stalls beside more than one engine test suite
# (two beside it held its slices for over a minute). A hold made with --class engine is one (its record says "class
# engine"; CI's Rust test steps and a manual cargo test of the engine set it). So a --gpu run starts only while at most
# SX_HEAVY_GPU_ENGINE engine holds run, and while one holds or is handed a GPU slot, engine waiters take slots only up
# to that many; other plain jobs are not limited. A CI --gpu ticket that waits for the engine holds to drop to that
# many keeps the engine waiters behind it out for its first SX_HEAVY_GPU_HOLDBACK seconds (default 300), so it gets
# its quiet window; after that, they pass it. Tickets ahead of it in the queue are served first (up to the same limit
# while another --gpu run holds). A manual --gpu waiter never keeps anyone out.
#
# A manual (class 1) --e2e waiter that cannot run yet (a --gpu run or another --e2e run blocks it) gives its turn back:
# it keeps its place in the queue but holds nobody back, so the waiters behind it use what is free meanwhile. Once its
# ticket is SX_HEAVY_RESERVE_AFTER seconds old (default 900) it keeps its turn as a CI waiter does from the start: the
# free slot it needs is kept for it, and the --gpu waiters behind it wait, so it is never starved. Each time what
# blocks a waiter changes, it prints one line naming the holders or tickets in its way.
#
# The history log gets a line for every take, release, take-over and give-up: the time, the event, the mode, the slots,
# the side and pid, the user, the label, the session, the details and the command, separated by tabs. It is renamed to
# <history>.1 at about 1 MB.
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
# How many engine holds may run beside a --gpu run (0 is allowed: none).
geng=${SX_HEAVY_GPU_ENGINE:-$(head -n 1 "$lock.gpu-engine" 2> /dev/null | tr -dc 0-9)}
case $geng in '' | *[!0-9]*) geng=1 ;; esac
# How old a manual --e2e or --gpu waiter's ticket must be before it holds the others back for its turn. The machine
# setting is read again at every decision (with read, no fork), so a change to it reaches the waiters already queued.
# The same for how long a CI --gpu waiter keeps the engine waiters behind it out.
setting() {
  local v=$2
  [ -n "$v" ] || { read -r v < "$lock.$3"; } 2> /dev/null
  v=${v%"$cr"}
  case $v in '' | *[!0-9]*) v=$4 ;; esac
  printf -v "$1" %s "$v"
}
reserve_read() {
  setting reserve_after "${SX_HEAVY_RESERVE_AFTER:-}" reserve-after 900
  setting gpu_holdback "${SX_HEAVY_GPU_HOLDBACK:-}" gpu-holdback 300
}
reserve_read
# The GPU slot directories, for --gpu holders only: <lock>.gpu.1 up to <lock>.gpu.<gslots>.
gpu_dirs=()
for ((i = 1; i <= gslots; i++)); do gpu_dirs+=("$lock.gpu.$i"); done
case $lock in */.*) hist_default=$lock.history.log ;; */*) hist_default=${lock%/*}/history.log ;; *) hist_default=history.log ;; esac
hist=${SX_HEAVY_HISTORY-$hist_default}

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
# wsl.exe with its output cleaned of NULs and carriage returns, and its own exit status (124 when it timed out). The
# NULs are stripped inside the substitution, so bash never warns that it ignored a null byte.
wslx() { local o rc; o=$(set -o pipefail; winrun wsl.exe "$@" 2> /dev/null | tr -d '\0\r'); rc=$?; printf '%s\n' "$o"; return $rc; }
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
ticket= held=() gated= ran= t_run=
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
    for i in 1 2 3 4 5; do rm -rf "$d" 2> /dev/null; [ -e "$d" ] || break; sleep 1; done
  done
  gate_drop
  [ -z "$ran" ] || hist_line release "$slots_held" "rc $rc, held $((SECONDS - t_run)) s"
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Takes a free slot: writes this holder's record into it at once, so no waiter ever finds it without one for long.
take() {
  mkdir "$1" 2> /dev/null || return 1
  printf 'pid %s since %s: %s\n%s\nuser %s\n%s%s%s' $$ "$(date '+%F %T')" "${all:+(all slots) }$(one_line "$cmd")" "$me" \
    "$user" "${label:+label $label
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
  local d s=
  for d in "$@"; do
    mine "$d" && continue
    [ -e "$d" ] || continue
    read_rec "$d"
    s="$s${s:+; }${r_head:-holder starting}${r_label:+ [$r_label]}"
  done
  printf %s "$s"
}
# Judges the holder of slot $1 and frees the slot when the holder is dead (or it was left with no record).
judge_slot() {
  local d=$1 rec t m
  rec=$(cat "$d/owner" 2> /dev/null)
  # Take over only the record judged dead, not one a new holder wrote meanwhile.
  if [ -n "$rec" ] && ! alive "$rec" && [ "$(cat "$d/owner" 2> /dev/null)" = "$rec" ]; then
    echo "heavy.sh: taking over a lock left by $(sed -n '1s/ since.*//p' <<< "$rec") ($(sed -n 's/^side //p' <<< "$rec"))" >&2
    rm -rf "$d"
    hist_line clear "${d##*/}" "dead holder: $(one_line "$(sed -n '1p' <<< "$rec")")"
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
# its turn while it cannot run: a CI ticket always, a manual one once it is $reserve_after s old; holds_back, whether
# --gpu ticket $1 keeps engine waiters out while it waits for the engine holds: a CI one for its first $gpu_holdback s.
who() { local p=${r_head#pid }; p=${p%% *}; wn="pid $p${r_label:+ [$r_label]}"; }
add() { local cur=${!1}; printf -v "$1" '%s' "$cur${cur:+, }$2"; }
ticket_time() { tt=${1##*/}; tt=${tt#[01]-}; tt=${tt%%-*}; case $tt in '' | *[!0-9]*) tt=$tnow ;; esac; }
holds_back() {
  case ${1##*/} in 0-*) ;; *) return 1 ;; esac
  ticket_time "$1"
  [ $((tnow - tt)) -lt "$gpu_holdback" ]
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
  # GF: free GPU slots. gpu_blk: a --gpu run holds a GPU slot or is handed one (or waits ahead for the engine holds to
  # drop to $geng), so no --e2e or --all may start, and engine waiters keep to $geng slots.
  for d in "${gpu_dirs[@]}"; do
    if [ -e "$d" ]; then mine "$d" || { gpu_blk=1; read_rec "$d"; who; add gpu_by "$wn"; }; else GF=$((GF + 1)); fi
  done
  for t in "$q"/*; do
    [ -e "$t" ] || continue
    [ "$t" = "$ticket" ] && break
    # ci_ahead: a CI ticket waits (CI tickets sort first, so for a class 1 ticket every one of them is ahead).
    case ${t##*/} in 0-*) ci_ahead=1 ;; esac
    case ${t##*/} in
      *-gpu)
        # Handed a GPU slot. One that waits for the engine holds to drop keeps it, and keeps the engine waiters behind
        # it out, only while it holds them back (a CI one, for a while).
        gahead=$((gahead + 1))
        if [ -z "$excl_blk" ] && [ -z "$excl_ahead" ] && [ "$GF" -gt 0 ] && { [ "$PE" -le "$geng" ] || holds_back "$t"; }; then
          GF=$((GF - 1)) gpu_blk=1; add gpu_by "ticket ${t##*/}"
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
        ahead=$((ahead + 1))
        if [ "$F" -gt 0 ] && { [ -z "$gpu_blk" ] || [ "$PE" -lt "$geng" ]; }; then
          F=$((F - 1)) PE=$((PE + 1)); add engine_by "ticket ${t##*/}"
        fi ;;
      *)
        ahead=$((ahead + 1))
        [ "$F" -gt 0 ] && F=$((F - 1)) ;;
    esac
  done
  if [ -n "$gpu" ]; then [ "$gahead" -lt "$gslots" ] && front=1; else [ "$ahead" -lt "$slots" ] && front=1; fi
  # What blocks this waiter, said in one line each time it changes.
  why=
  case $mode in
    plain)
      if [ "$F" = 0 ]; then why="every slot is held or handed to a ticket ahead (${all_by:-queue ahead})"
      elif [ -n "$engine" ] && [ -n "$gpu_blk" ] && [ "$PE" -ge "$geng" ]; then
        why="a --gpu run holds or waits ($gpu_by), with $PE engine holds running or handed a slot beside it, at most $geng"
      fi ;;
    e2e)
      if [ "$F" = 0 ]; then why="every slot is held or handed to a ticket ahead (${all_by:-queue ahead})"
      elif [ -n "$e2e_blk" ]; then why="another --e2e run holds or is handed a slot ($e2e_by)"
      elif [ -n "$gpu_blk" ]; then why="a --gpu run holds or is handed a GPU slot ($gpu_by)"; fi ;;
    gpu)
      if [ -n "$excl_blk" ]; then why="an --e2e or --all run holds a slot ($excl_by)"
      elif [ -n "$excl_ahead" ]; then why="an --e2e or --all ticket is ahead in the queue ($ahead_by)"
      elif [ "$GF" = 0 ]; then why="every GPU slot is held or handed to a ticket ahead (${gpu_by:-queue ahead})"
      elif [ "$PE" -gt "$geng" ]; then why="$PE engine holds run or are handed a slot, at most $geng beside a --gpu run ($engine_by)"; fi ;;
  esac
  key=$why
  if [ -n "$why" ] && [ -n "$ticket" ] && [ "$mode" = e2e ]; then
    if keeps_turn "$ticket"; then why="$why; it keeps its turn"; key="$key keeps"
    else ticket_time "$ticket"; why="$why; it gives its turn back for $((reserve_after - (tnow - tt))) s more"; fi
  fi
  case $why in
    *' engine holds run or are handed a slot, '*)
      if holds_back "$ticket"; then why="$why; it keeps engine waiters out for $((gpu_holdback - (tnow - tt))) s more"; key="$key back"
      else why="$why; engine waiters pass it"; fi ;;
  esac
  [ -z "$why" ] || [ "$key" = "$last_why" ] || echo "heavy.sh: waiting: $why" >&2
  last_why=$key
  case $mode in
    plain | e2e)
      [ "$F" -gt 0 ] || return 0
      [ -z "$engine" ] || [ -z "$gpu_blk" ] || [ "$PE" -lt "$geng" ] || return 0
      [ "$mode" = plain ] || { [ -z "$e2e_blk" ] && [ -z "$gpu_blk" ]; } || return 0
      for d in "${slot_dirs[@]}"; do take "$d" && { admitted=1; return 0; }; done ;;
    gpu)
      [ -z "$excl_blk" ] && [ -z "$excl_ahead" ] && [ "$GF" -gt 0 ] && [ "$PE" -le "$geng" ] || return 0
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

t0=$SECONDS next=0 judged=0
while :; do
  refresh
  sweep
  if gate_take; then
    [ -n "$ticket" ] || new_ticket "$(seq_next)"
    refresh
    decide
    if [ -n "$admitted" ]; then
      rm -f "$ticket"; ticket=
      hist_rotate
      hist_line take "$(slot_names)" "waited $((SECONDS - t0)) s"
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
"$@"
rc=$?
[ "$rc" != 75 ] || { echo "heavy.sh: the command exited 75, reported as 1 (75 means heavy.sh gave up)" >&2; rc=1; }
exit $rc
