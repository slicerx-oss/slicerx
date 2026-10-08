#!/bin/zsh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds the universal macOS app, then hands it and the disk image to scripts/sign-mac, which signs inside-out with the
# hardened runtime, notarizes, staples and checks the result the way Gatekeeper does. The stapled app also goes into
# the update bundle (.app.tar.gz) for in-app updates.
#
# Run it from a Terminal window in the Mac's own desktop session (not over ssh): the signing key and the notary
# credentials sit in the login keychain, which only that session can unlock. No secret passes through this script.
# The certificate is named by its public identity; the App Store Connect key lives in the keychain profile
# created once with `xcrun notarytool store-credentials`.
#
#   zsh apps/desktop/release/macos-sign.sh
#
# Environment (all optional):
#   SX_SIGN_IDENTITY  certificate name (default: the SlicerX Developer ID Application certificate)
#   SX_NOTARY_PROFILE notarytool keychain profile (default: slicerx-notary)
#   SX_OUT            where the finished files go (default: target/signed under the repository)
set -euo pipefail

identity=${SX_SIGN_IDENTITY:-"Developer ID Application: SEAN LEONARD (X2928JZ7GJ)"}
profile=${SX_NOTARY_PROFILE:-slicerx-notary}
repo=$(cd "$(dirname "$0")/../../.." && pwd)
out=${SX_OUT:-$repo/target/signed}
export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH

say() { print -- "\n== $*"; }

say "keychain and credentials"
export SX_SIGN_IDENTITY=$identity SX_NOTARY_PROFILE=$profile
# In the desktop session sign-mac runs directly. Elsewhere (ssh) the sign-mac agent signs for us.
if zsh "$repo/scripts/sign-mac" --check; then
  signer=(zsh "$repo/scripts/sign-mac")
elif [[ -x $HOME/bin/sign-mac-request ]]; then
  print "using the sign-mac agent"
  signer=("$HOME/bin/sign-mac-request")
else
  exit 4
fi

cd "$repo"
# A release never carries the agent bridge (docs/agent-bridge.md): refuse a bridge environment before building.
node apps/desktop/release/check-agent-bridge.mjs --env --manifest apps/desktop/src-tauri/Cargo.toml
say "build (universal, unsigned)"
pnpm install --frozen-lockfile --filter "@slicerx/desktop..." --filter "@slicerx/mcp..."
rustup target add wasm32-unknown-unknown aarch64-apple-darwin x86_64-apple-darwin
pnpm --filter @slicerx/slicer build:wasm
sh packages/geom/wasm/scripts/build.sh
pnpm --filter @slicerx/desktop tauri:config
node apps/desktop/release/prepare-sidecars.mjs --target universal-apple-darwin --config apps/desktop/src-tauri/gen/edition.conf.json
(cd apps/desktop && pnpm tauri build --config src-tauri/gen/edition.conf.json --target universal-apple-darwin --bundles app)

bundle=$repo/target/universal-apple-darwin/release/bundle/macos
app=$(print -- "$bundle"/*.app(N[1]))
[[ -d $app ]] || { print -u2 "No app bundle in $bundle"; exit 1; }
name=${${app:t}%.app}
version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")
mkdir -p "$out"
lipo -archs "$app/Contents/MacOS/${name:l}" 2>/dev/null || true
say "no agent bridge"
node apps/desktop/release/check-agent-bridge.mjs --binary "$app/Contents/MacOS/${name:l}" --dist apps/desktop/dist

say "sign, notarize and staple the app"
"${signer[@]}" "$app"

say "disk image"
dmg=$out/${name}_${version}_universal.dmg
stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname "$name" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
"${signer[@]}" "$dmg"

say "update bundle"
# the stapled app as the in-app updater installs it: a tar.gz with the .app at its root. sign-updates.sh signs it.
upd=$out/${name}_${version}_universal.app.tar.gz
COPYFILE_DISABLE=1 tar -C "${app:h}" -czf "$upd" "${app:t}"

cp -R "$app" "$out/"
(cd "$out" && shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256")
say "done: $dmg"
