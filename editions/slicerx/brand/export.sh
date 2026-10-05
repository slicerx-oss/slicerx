#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Copies every brand file to a folder outside the repo, for handing to other people.
#
#   ./export.sh "$HOME/Downloads/SlicerX Assets"
#
# Anything in the folder that this script did not make is moved into _legacy-<today>/ inside it
# first, so nothing of yours is overwritten and nothing old is mistaken for current. What the
# script made last time is replaced. Run ./build.sh --no-wire first, so the files it copies are
# fresh. The social card is in social/, rendered from svg/, so no site has to be running.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:?usage: export.sh <directory>}"
today="$(date +%Y-%m-%d)"

[ -d "$here/out" ] || { echo "run ./build.sh first" >&2; exit 1; }

mkdir -p "$dest"
legacy="$dest/_legacy-$today"
shopt -s nullglob dotglob
for item in "$dest"/*; do
  name="$(basename "$item")"
  case "$name" in
    _legacy-*|.DS_Store) continue ;;
    # Its own output from an earlier run: replaced below, never archived.
    svg|png|favicon|ios|android|desktop|social|splash|README.md) rm -rf "$item"; continue ;;
  esac
  mkdir -p "$legacy"
  mv "$item" "$legacy/"
done
shopt -u nullglob dotglob

cp -R "$here/svg" "$dest/svg"
for d in png favicon ios android desktop social splash; do cp -R "$here/out/$d" "$dest/$d"; done

node - "$here/paths.json" > "$dest/README.md" <<'JS'
const p = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const row = (n, use) => `| ${n} | \`${p.palette[n].a}\` | \`${p.palette[n].b}\` | ${use} |`
console.log(`# SlicerX brand files

Generated from the repository by \`editions/slicerx/brand/export.sh\`. Do not edit these. Change the kit's scripts, rebuild and export again.

## The mark

An X cut into eight print layers and filled with the filament gradient, purple at the top left to pink at the bottom right, one gradient per layer. It is also the X of the logo.

| Palette | From | To | Use it on |
|---|---|---|---|
${row('dark', 'ink 0 and any dark surface')}
${row('light', 'paper and any light surface')}

Ground: \`${p.ground.dark}\` dark, \`${p.ground.light}\` light. One-color versions: \`#f8f8f2\` on dark, \`#17181f\` on light.

## The name

The logo is the word Slicer in Unbounded 600, tracked -0.02em, with the mark standing in as its X. The X equals the cap height and sits on the baseline. There is no separate symbol and no typed X. In the files the letters are outlines, so no font is needed.

Every lockup file carries its clear space: 8 units of the mark's 32 unit grid, a quarter of the mark's box, on every side.

## Folders

- \`svg/\` every vector: the mark, the lockups, the app icons, the tab icons, the banners, the cards
- \`png/\` the mark, tile and lockups as rasters
- \`favicon/\` \`icon.svg\` for Chrome and Firefox, \`favicon.ico\` for Safari, \`apple-icon.png\`, and the manifest icons
- \`ios/\` the app icon at 1024 px: dark, light and tinted
- \`android/\` the adaptive icon layers and the Play Store icon
- \`desktop/\` the Tauri icon set: \`icon.icns\`, \`icon.ico\`, the PNG sizes and the Windows Store logos
- \`social/\` the link preview, the GitHub social preview, the avatar and the README banners
- \`splash/\` the mark for a launch screen, on clear
`)
JS

echo "exported to $dest"
[ -d "$legacy" ] && echo "previous contents moved to $legacy"
exit 0
