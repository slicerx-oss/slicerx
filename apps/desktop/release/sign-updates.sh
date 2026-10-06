#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Signs a release's update bundles with the update signing key, on the release Mac, where the key lives and stays.
#   apps/desktop/release/sign-updates.sh <version> <folder>
# Signs every SlicerX_<version>_* update bundle in the folder (the macOS .app.tar.gz, the Windows -setup.exe and .msi,
# the Linux .AppImage) with `tauri signer sign --app-version`, writing <bundle>.sig next to each. publish.sh turns
# them into latest.json. The key is read from a file only its owner can read (SX_UPDATER_KEY, default
# ~/.config/slicerx/updater.key) and its password from the login keychain (item slicerx-updater-key), or empty when
# the item is missing. Neither is printed, copied or passed on a command line. updates.md, "Update signing", sets it up.
set -eu
[ $# -eq 2 ] || { echo "usage: sign-updates.sh <version> <folder>" >&2; exit 2; }
version=$1 dir=$2
here=$(cd "$(dirname "$0")" && pwd)
key=${SX_UPDATER_KEY:-$HOME/.config/slicerx/updater.key}
[ -d "$dir" ] || { echo "sign-updates: no folder $dir" >&2; exit 2; }
[ -f "$key" ] || { echo "sign-updates: no update key at $key (updates.md, Update signing)" >&2; exit 3; }
# the key file is the owner's alone
case $(ls -l "$key" | cut -c1-10) in
  -rw-------|-r--------) ;;
  *) echo "sign-updates: $key must be readable by its owner only (chmod 600)" >&2; exit 3 ;;
esac
password=
if command -v security >/dev/null 2>&1; then
  password=$(security find-generic-password -s "${SX_UPDATER_KEYCHAIN_ITEM:-slicerx-updater-key}" -w 2>/dev/null || true)
fi

signed=0
for f in "$dir"/SlicerX_"$version"_*.app.tar.gz "$dir"/SlicerX_"$version"_*-setup.exe "$dir"/SlicerX_"$version"_*.msi "$dir"/SlicerX_"$version"_*.AppImage; do
  [ -f "$f" ] || continue
  rm -f "$f.sig"
  # the CLI reads the key path and password from the environment, so neither shows in the process list; with no
  # terminal on stdin it never stops to ask
  TAURI_SIGNING_PRIVATE_KEY_PATH=$key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$password \
    pnpm --silent --dir "$here/.." exec tauri signer sign --app-version "$version" "$f" </dev/null >/dev/null
  [ -s "$f.sig" ] || { echo "sign-updates: no signature written for $f" >&2; exit 1; }
  echo "signed $(basename "$f")"
  signed=$((signed + 1))
done
[ "$signed" -gt 0 ] || { echo "sign-updates: no update bundles for $version in $dir" >&2; exit 1; }
