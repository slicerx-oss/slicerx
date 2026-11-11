#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Installs Ubuntu packages on a hosted Linux runner, from a cache of their .deb files when it can, so a job gets by
# without the package mirror.
#
#   scripts/ci/apt-install.sh [--cache DIR] <package>...
#
# 1. Packages already installed are left out; with none left there is nothing to do, and the mirror is never asked.
# 2. With --cache, the .deb files in DIR (kept by an earlier run, restored by actions/cache) of packages not yet
#    installed are installed with dpkg, which needs no network. When that leaves nothing missing, it is done.
# 3. Otherwise the mirror: one apt-get update, then up to three tries of apt-get install, each cut off after 150 s, so a
#    hung connection is dropped and retried on a new one instead of waiting out the job's limit (one runner took 27 s
#    and another 1254 s on the same step started at the same moment). apt itself retries a failed download three times
#    and gives up on a silent connection after 30 s. When the update fails (the runner could not reach or resolve the
#    mirror), the update and the install are tried once more on SX_APT_FALLBACK (by default
#    http://mirrors.edge.kernel.org/ubuntu; set it empty for none). The packages are signed by Ubuntu either way, and
#    apt checks them. With --cache, the files it downloads are kept in DIR for the next run.
# The time before and after each command is printed, so a stall shows which one hung.
#
# A cold cache during a mirror outage still needs a mirror: it fails when the fallback cannot be reached either.
set -uo pipefail

cache=""
if [ "${1:-}" = --cache ]; then
  cache=$2
  shift 2
fi
[ "$#" -gt 0 ] || { echo "usage: apt-install.sh [--cache DIR] <package>..." >&2; exit 2; }

sudo=""
[ "$(id -u)" = 0 ] || sudo=sudo
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30)
stamp() { echo "$(date -u +%H:%M:%S) $*"; }
installed() { [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null | cut -c1-2)" = ii ]; }
missing() {
  local p
  for p in "$@"; do installed "$p" || echo "$p"; done
}

mapfile -t left < <(missing "$@")
if [ "${#left[@]}" = 0 ]; then
  stamp "all $# packages are installed already"
  exit 0
fi
stamp "${#left[@]} of $# packages to install: ${left[*]}"

if [ -n "$cache" ]; then
  mkdir -p "$cache/partial"
  # the cached files of packages this runner does not have yet (the rest are on its image already), the newest of each
  # when a cache kept from an older image has two
  declare -A newest=() version=()
  for f in "$cache"/*.deb; do
    [ -e "$f" ] || continue
    p=$(dpkg-deb -f "$f" Package)
    v=$(dpkg-deb -f "$f" Version)
    installed "$p" && continue
    if [ -z "${newest[$p]:-}" ] || dpkg --compare-versions "$v" gt "${version[$p]}"; then
      newest[$p]=$f
      version[$p]=$v
    fi
  done
  debs=("${newest[@]}")
  if [ "${#debs[@]}" -gt 0 ]; then
    stamp "dpkg -i ${#debs[@]} cached files"
    $sudo dpkg -i "${debs[@]}" >/dev/null || stamp "dpkg -i ended with status $?, going on to the mirror"
    mapfile -t left < <(missing "${left[@]}")
    if [ "${#left[@]}" = 0 ]; then
      stamp "installed from the cache, with no mirror"
      exit 0
    fi
    stamp "still to install after the cache: ${left[*]}"
  fi
  opts+=(-o "Dir::Cache::archives=$cache")
fi

# the runner's own user keeps the cache, so actions/cache can read every file in it
keep() { [ -z "$cache" ] || $sudo chown -R "$(id -u):$(id -g)" "$cache"; }

install() {
  local try status
  for try in 1 2 3; do
    stamp "apt-get install, try $try of 3"
    # -f also finishes what a partial dpkg -i of the cache left unconfigured
    timeout 150 $sudo apt-get "${opts[@]}" install -f -y --no-install-recommends "${left[@]}"
    status=$?
    if [ "$status" = 0 ]; then
      stamp "apt-get install done"
      return 0
    fi
    stamp "apt-get install try $try ended with status $status"
    [ "$try" = 3 ] || sleep 5
  done
  return 1
}

# Points apt at the fallback mirror for archive and security. Hosted Ubuntu runners list their mirrors in
# /etc/apt/apt-mirrors.txt (sources with mirror+file:), tried in order, so the fallback goes first; a plain sources file
# names the hosts itself.
fall_back() {
  local mirror=${SX_APT_FALLBACK-http://mirrors.edge.kernel.org/ubuntu} etc=${SX_APT_ETC:-/etc/apt}
  [ -n "$mirror" ] || return 1
  stamp "switching to the fallback mirror $mirror"
  if [ -f "$etc/apt-mirrors.txt" ]; then
    { echo "$mirror/"; cat "$etc/apt-mirrors.txt"; } | $sudo tee "$etc/apt-mirrors.txt.fallback" >/dev/null
    $sudo mv "$etc/apt-mirrors.txt.fallback" "$etc/apt-mirrors.txt"
  fi
  local f
  for f in "$etc/sources.list" "$etc"/sources.list.d/*.sources "$etc"/sources.list.d/*.list; do
    [ -f "$f" ] || continue
    $sudo sed -i -E "s#https?://([a-z0-9.-]+\.)?(archive|security)\.ubuntu\.com/ubuntu/?#$mirror/#g" "$f"
  done
}

update() {
  stamp "apt-get update"
  # --error-on=any: a list that did not download fails the update, where apt would only warn
  timeout 120 $sudo apt-get "${opts[@]}" update --error-on=any
}

if update; then
  stamp "apt-get update done"
  install && { keep; exit 0; }
else
  stamp "apt-get update failed (status $?)"
  if fall_back && update; then
    stamp "apt-get update done on the fallback mirror"
    install && { keep; exit 0; }
  else
    stamp "no package lists from a mirror, trying the install on the lists the runner has"
    install && { keep; exit 0; }
  fi
fi
keep
echo "apt-install: ${left[*]} did not install" >&2
exit 1
