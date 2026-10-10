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
#   SX_HEAVY_GPU_SLOTS=<n>                     how many --gpu holders may run at once (default: the number in
#                                              <lock>.gpu-slots, or 1 when there is none)
#   SX_HEAVY_LOCK=<dir>                       the lock (default ~/.slicerx-heavy.lock); when unset, the value in the
#                                              ci.env of the CI home this copy runs from ($SX_CI_HOME, or bin/..)
#   SX_HEAVY_SLOTS=<n>                         how many holders may run at once (default: the number in <lock>.slots,
#                                              a machine setting beside the lock, or 1 when there is none)
#   SX_HEAVY_WAIT=<seconds>                    give up after this long (default 0: wait as long as it takes)
#   SX_HEAVY_POLL=<seconds>                    how often a waiter looks again (default 5; the tests use 1)
#   SX_HEAVY_ORPHAN=<seconds>                  how old a lock with no holder record must be before it is cleared
#                                              (default 60; a holder writes its record right after taking the lock)
#   SX_HEAVY_LABEL=<text>                      who is asking, in the holder record and the history (optional)
#   SX_HEAVY_SESSION=<text>                    the session that asks (default: any *_SESSION_ID in the environment,
#                                              and the run and job of a GitHub Actions job)
#   SX_HEAVY_HISTORY=<file>                    the history log (default history.log beside the lock, or
#                                              <lock>.history.log for a lock named .*; empty: none)
#
# Each slot is a directory holding its holder's record (mkdir is atomic; macOS has no flock command): <lock> is the
# first, <lock>.2 the second, and so on. A slot whose holder has died is taken over, so a crashed job never wedges the
# machine. The record's first line names the pid, the start and the command; the lines after it the holder's side and
# process identity, its user, and its SX_HEAVY_LABEL and session when there are any.
#
# Waiters take a ticket in <lock>.queue, named <class>-<seconds>-<sequence>-<side>-<pid>[-all|-e2e|-gpu], where class
# 0 is a CI job (SX_HEAVY_PRIORITY=ci, or a self-hosted runner) and 1 anything else, so CI jobs go first and the rest
# are served in arrival order; the sequence number orders the tickets taken in the same second. Admission is decided
# under a gate (<lock>.gate, a directory held for the moment of a decision), so no two waiters decide at once: the
# waiter walks the queue from its head and hands the free slots to the tickets ahead of it in order, and takes one
# only when one is left for its own. A freed slot thus goes to the oldest ticket that may use it, never to the waiter
# that happens to look first, and in a poll no more waiters get in than there are free slots.
#
# A --all waiter at the head takes the slots one by one as they free up, and the tickets behind it get none, so it is
# not passed over; a --all waiter behind another one gives back what it holds. A --e2e holder's record says "class e2e";
# while one holds or is handed a slot, no other --e2e waiter takes one (two browser suites drawing software WebGL
# overload a machine). A waiting --e2e ticket that may take a slot keeps one free for itself while it waits for the
# --gpu runs to end, so the jobs behind it cannot starve it; one that waits for another --e2e run needs no such slot
# (that run's slot frees when it ends), and other jobs use the free slots meanwhile. Every waiter judges the holders now
# and then, so one that cannot does not wedge the queue. A ticket left alone for 2 minutes is a dead waiter's, and is
# dropped; a waiter refreshes its own on every poll and between the checks of a slow judgement.
#
# A --gpu holder's record says "class gpu", in one of the GPU slots, which plain waiters neither take nor count: the
# GPU lane's suites draw on the GPU and run side by side, while agents keep their own slots. The free GPU slots go to
# the --gpu tickets in order, and only while no --e2e or --all holder holds and no --e2e or --all ticket is older, so an
# exclusive run is never starved; an --e2e waiter behind a --gpu ticket that is handed a GPU slot waits for it.
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
all= e2e= gpu=
while :; do
  case ${1:-} in
    --all) all=1; shift ;;
    --e2e) e2e=1; shift ;;
    --gpu) gpu=1; shift ;;
    *) break ;;
  esac
done
[ -z "$all" ] || { e2e=; gpu=; }
[ -z "$e2e" ] || gpu=
[ $# -gt 0 ] || { echo "usage: heavy.sh [--all | --e2e | --gpu] <command...>" >&2; exit 2; }
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

# One line of text for a record or the history: no tabs, carriage returns or line breaks.
one_line() { local s=${1//$tab/ }; s=${s//$cr/}; s=${s//$nl/ }; printf %s "$s"; }
user=${USER:-${USERNAME:-}}
[ -n "$user" ] || user=$(id -un 2> /dev/null)
label=$(one_line "${SX_HEAVY_LABEL:-}")
session=${SX_HEAVY_SESSION:-}
if [ -z "$session" ]; then
  n=0
  for v in $(compgen -v 2> /dev/null); do
    case $v in *_SESSION_ID) [ -n "${!v:-}" ] && [ $n -lt 3 ] && { session="$session${session:+ }$v=${!v}"; n=$((n + 1)); } ;; esac
  done
  [ -z "${GITHUB_RUN_ID:-}" ] || session="$session${session:+ }run ${GITHUB_REPOSITORY:-}/${GITHUB_RUN_ID}/${GITHUB_RUN_ATTEMPT:-1} job ${GITHUB_JOB:-}"
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
    "$label" "$session" "$3" "$(one_line "$cmd")" >> "$hist"; } 2> /dev/null
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
new_ticket() { ticket=$q/$prio-$(now)-$1-$side-$$${all:+-all}${e2e:+-e2e}${gpu:+-gpu}; touch "$ticket" 2> /dev/null; }
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
}" > "$1/owner"
  held+=("$1")
}
mine() { local d; for d in ${held[@]+"${held[@]}"}; do [ "$d" = "$1" ] && return 0; done; return 1; }
# Reads the record in slot $1: r_head its first line, r_class e2e or gpu, r_label its label.
read_rec() {
  local l n=0
  r_head= r_class= r_label=
  while IFS= read -r l || [ -n "$l" ]; do
    n=$((n + 1)); [ $n = 1 ] && r_head=$l
    case $l in 'class e2e') r_class=e2e ;; 'class gpu') r_class=gpu ;; 'label '*) r_label=${l#label } ;; esac
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

# The admission decision, under the gate. Walks the queue from its head and hands out the free slots in ticket order,
# as every waiter would; takes this waiter's slot when one is left for it. Sets admitted, and front when the waiter is
# near enough to the head to judge the holders on every poll.
decide() {
  local d t F=0 GF=0 e2e_blk= gpu_blk= gpu_held= excl_blk= excl_ahead= all_ahead= ahead=0 gahead=0
  admitted= front=
  # F: free plain slots. e2e_blk: an --e2e run holds or is handed a plain slot, so no other --e2e may take one.
  # excl_blk: an --e2e run or a --all holder holds a plain slot, so no --gpu may take a GPU slot.
  for d in "${slot_dirs[@]}"; do
    [ -e "$d" ] || { F=$((F + 1)); continue; }
    mine "$d" && continue
    read_rec "$d"
    [ "$r_class" = e2e ] && { e2e_blk=1; excl_blk=1; }
    case $r_head in *': (all slots) '*) excl_blk=1 ;; esac
  done
  # GF: free GPU slots. gpu_held: a --gpu run holds a GPU slot. gpu_blk: one holds or is handed one, so no --e2e may
  # start. A --all waiter waits for the holders only: an older --gpu waiter does not take a GPU slot beside its held
  # slots, so it goes after the --all run.
  for d in "${gpu_dirs[@]}"; do
    if [ -e "$d" ]; then mine "$d" || { gpu_blk=1; gpu_held=1; }; else GF=$((GF + 1)); fi
  done
  for t in "$q"/*; do
    [ -e "$t" ] || continue
    [ "$t" = "$ticket" ] && break
    case ${t##*/} in
      *-gpu)
        gahead=$((gahead + 1))
        if [ -z "$excl_blk" ] && [ -z "$excl_ahead" ] && [ "$GF" -gt 0 ]; then GF=$((GF - 1)); gpu_blk=1; fi ;;
      *-e2e)
        # Handed a slot to run in, or kept one free while the --gpu runs end; behind another --e2e run, nothing.
        ahead=$((ahead + 1)) excl_ahead=1
        if [ -z "$e2e_blk" ] && [ "$F" -gt 0 ]; then F=$((F - 1)); e2e_blk=1; fi ;;
      *-all) ahead=$((ahead + 1)) excl_ahead=1 all_ahead=1 F=0 ;;
      *) ahead=$((ahead + 1)); [ "$F" -gt 0 ] && F=$((F - 1)) ;;
    esac
  done
  if [ -n "$gpu" ]; then [ "$gahead" -lt "$gslots" ] && front=1; else [ "$ahead" -lt "$slots" ] && front=1; fi
  case $mode in
    plain | e2e)
      [ "$F" -gt 0 ] || return 0
      [ "$mode" = plain ] || { [ -z "$e2e_blk" ] && [ -z "$gpu_blk" ]; } || return 0
      for d in "${slot_dirs[@]}"; do take "$d" && { admitted=1; return 0; }; done ;;
    gpu)
      [ -z "$excl_blk" ] && [ -z "$excl_ahead" ] && [ "$GF" -gt 0 ] || return 0
      for d in "${gpu_dirs[@]}"; do take "$d" && { admitted=1; return 0; }; done ;;
    all)
      if [ -n "$all_ahead" ]; then
        # Another --all waits ahead: give back what this one holds, or the two would wait for each other.
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
      # The machine alone: also no GPU run left (none starts while this waits or holds).
      [ "${#held[@]}" = "$slots" ] && [ -z "$gpu_held" ] && admitted=1 ;;
  esac
  return 0
}
cmd="$*"

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
"$@"
