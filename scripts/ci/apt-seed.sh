#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Downloads, on a runner that can reach the package mirror, the .deb files a hosted runner image needs for some
# packages, so apt-install.sh on that image installs them with no mirror.
#
#   scripts/ci/apt-seed.sh [--print] <suite> <dpkg-status> <dir> <package>...
#   scripts/ci/apt-seed.sh [--print] <suite> <dpkg-status> <dir> --playwright
#
# <suite> is the image's Ubuntu release (noble, resolute) and <dpkg-status> a copy of its /var/lib/dpkg/status. apt
# runs as this runner's own user with a state of its own under a scratch directory (APT_CONFIG): sources for <suite>
# (the Ubuntu archive and security pockets, main and universe, checked with the Ubuntu archive keyring), lists of its
# own, and the image's package status. So it picks exactly the packages and upgrades the image would install, and
# nothing on this runner changes. With --playwright the packages are the ones `playwright install-deps --dry-run
# chromium` finds missing on that image, Playwright's list for the image's platform (noble is ubuntu24.04-x64, resolute
# ubuntu26.04-x64) checked against the image's status, as playwright-chromium.sh asks on the image itself. The files land in <dir>, with the
# asked packages in <dir>/packages.txt. With --print it lists their URLs and downloads nothing. When the Ubuntu hosts
# give no lists, it tries once more on SX_APT_FALLBACK (by default http://mirrors.edge.kernel.org/ubuntu, a full
# mirror of the archive and security pockets).
set -uo pipefail

print=""
if [ "${1:-}" = --print ]; then
  print=1
  shift
fi
[ "$#" -ge 4 ] || { echo "usage: apt-seed.sh [--print] <suite> <dpkg-status> <dir> <package>... | --playwright" >&2; exit 2; }
suite=$1 status=$(realpath "$2") dir=$3
shift 3
mkdir -p "$dir/partial"
dir=$(realpath "$dir")

keyring=${SX_APT_KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}
archive=${SX_APT_ARCHIVE:-http://archive.ubuntu.com/ubuntu}
security=${SX_APT_SECURITY:-http://security.ubuntu.com/ubuntu}
stamp() { echo "$(date -u +%H:%M:%S) $*"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/lists/partial" "$work/cache" "$work/parts"
sources() {
  {
    echo "deb [signed-by=$keyring] $1 $suite main universe"
    echo "deb [signed-by=$keyring] $1 $suite-updates main universe"
    echo "deb [signed-by=$keyring] $2 $suite-security main universe"
  } >"$work/sources.list"
}
sources "$archive" "$security"
cat >"$work/apt.conf" <<EOF
Dir::Etc::sourcelist "$work/sources.list";
Dir::Etc::sourceparts "$work/parts";
Dir::Etc::preferences "$work/none";
Dir::Etc::preferencesparts "$work/parts";
Dir::State::Lists "$work/lists";
Dir::State::status "$status";
Dir::State::extended_states "$work/extended_states";
Dir::Cache "$work/cache";
Dir::Cache::archives "$dir";
Debug::NoLocking "true";
APT::Architecture "amd64";
APT::Architectures { "amd64"; };
Acquire::Retries "3";
Acquire::http::Timeout "30";
EOF
export APT_CONFIG=$work/apt.conf

update() {
  stamp "apt-get update for $suite from $1"
  timeout 300 apt-get update --error-on=any
}
# as apt-install.sh does on the image, one more try on SX_APT_FALLBACK when the Ubuntu hosts cannot be reached
fallback=${SX_APT_FALLBACK-http://mirrors.edge.kernel.org/ubuntu}
if ! update "$archive"; then
  [ -n "$fallback" ] && sources "$fallback" "$fallback" && update "$fallback" || { echo "apt-seed: no package lists for $suite" >&2; exit 1; }
fi

if [ "$1" = --playwright ]; then
  case $suite in
    noble) platform=ubuntu24.04-x64 ;;
    resolute) platform=ubuntu26.04-x64 ;;
    *) echo "apt-seed: no Playwright platform for $suite" >&2; exit 1 ;;
  esac
  report=$(PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=$platform pnpm --filter @slicerx/web exec playwright install-deps --dry-run chromium 2>&1)
  echo "$report"
  # as in playwright-chromium.sh: "Missing system dependencies (N):" and then one indented package a line
  mapfile -t packages < <(sed -n '/^Missing system dependencies/,$ s/^  \([a-z0-9][a-z0-9.+-]*\)$/\1/p' <<<"$report")
  if [ "${#packages[@]}" = 0 ]; then
    grep -q "All system dependencies are installed" <<<"$report" || { echo "apt-seed: Playwright listed nothing for $platform" >&2; exit 1; }
    : >"$dir/packages.txt"
    stamp "the image has every package Playwright needs for $platform"
    exit 0
  fi
  set -- "${packages[@]}"
fi

if [ -n "$print" ]; then
  apt-get install --print-uris -qq -y --no-install-recommends "$@"
  exit
fi
stamp "apt-get download of what the image needs for $#: $*"
timeout 600 apt-get install --download-only -y --no-install-recommends "$@" || { echo "apt-seed: the download for $suite did not finish" >&2; exit 1; }
printf '%s\n' "$@" >"$dir/packages.txt"
rm -rf "$dir/partial" "$dir/lock"
stamp "$(find "$dir" -name '*.deb' | wc -l) files, $(du -sh "$dir" | cut -f1), in $dir"
