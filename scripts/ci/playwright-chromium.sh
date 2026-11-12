#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Installs Playwright's Chromium and the system packages it needs, the ones `playwright install --with-deps chromium`
# installs, without asking the package mirror for packages the runner already has.
#
#   scripts/ci/playwright-chromium.sh
#
# The browser comes from Playwright's own download (kept by actions/cache in ~/.cache/ms-playwright; a download that
# fails is tried again through net-retry.sh). Then Playwright lists the system packages that are missing
# (install-deps --dry-run, a simulated install that needs no network): none
# missing, and no apt runs at all; some missing, and those go through apt-install.sh, from the .deb files in
# SX_APT_CACHE (by default ~/.cache/sx-apt/playwright, kept per runner image) when it has them, otherwise from the
# mirror with cut-off retries and a fallback mirror. When the list cannot be made (no package lists on the runner), the
# list an earlier run kept with the cache is used, and with none `playwright install-deps chromium` installs them as
# --with-deps did. A self-hosted runner's system packages are
# installed once by its admin (two jobs running apt at once collide), so there it only installs the browser.
set -uo pipefail

pw() { pnpm --filter @slicerx/web exec playwright "$@"; }
bash "$(dirname "$0")/net-retry.sh" pnpm --filter @slicerx/web exec playwright install chromium || exit 1
[ "${RUNNER_ENVIRONMENT:-}" = self-hosted ] && exit 0
[ "$(uname -s)" = Linux ] || exit 0

report=$(pw install-deps --dry-run chromium 2>&1)
echo "$report"
if grep -q "All system dependencies are installed" <<<"$report"; then
  exit 0
fi
cache=${SX_APT_CACHE:-$HOME/.cache/sx-apt/playwright}
mkdir -p "$cache"
# "Missing system dependencies (N):" and then one indented package a line
mapfile -t missing < <(sed -n '/^Missing system dependencies/,$ s/^  \([a-z0-9][a-z0-9.+-]*\)$/\1/p' <<<"$report")
if [ "${#missing[@]}" -gt 0 ]; then
  # kept with the cache, for a run whose runner cannot make the list
  printf '%s\n' "${missing[@]}" >"$cache/packages.txt"
  exec bash "$(dirname "$0")/apt-install.sh" --cache "$cache" "${missing[@]}"
fi
if [ -s "$cache/packages.txt" ]; then
  echo "playwright-chromium: the missing packages could not be listed; installing the ones the cache lists"
  mapfile -t missing <"$cache/packages.txt"
  exec bash "$(dirname "$0")/apt-install.sh" --cache "$cache" "${missing[@]}"
fi
echo "playwright-chromium: the missing packages could not be listed; installing them as --with-deps does"
pw install-deps chromium
