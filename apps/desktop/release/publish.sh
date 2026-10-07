#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Publishes a desktop release from installers already built and signed on their own machines.
#   apps/desktop/release/publish.sh <version> <installers dir> <notes.md> <commit> [min version]
# Writes downloads.json, SHA256SUMS.txt and whats-changed.json into the folder, puts the "What changed" list after
# the first paragraph of the notes, and creates desktop-v<version> as the latest release at <commit>. The notes get
# {{version}} and {{commit}} filled in (release/notes.md is the standard text). A changed.md in the folder replaces
# the generated list when a release has many small lines.
# The release bot reads whats-changed.json for the fixed-in replies.
# In-app updates: when the folder holds update bundles with their .sig files (sign-updates.sh, on the release Mac), it
# also writes latest.json, attaches it, then replaces latest.json on the fixed desktop-updates release, which is the
# feed the app reads (editions/slicerx/edition.config.ts). That release is never the latest one, so engine and model
# releases cannot take the feed over. A min version (optional) goes into latest.json as min_version: installs below it
# have a known problem and get only Update now or Quit.
set -eu
[ $# -eq 4 ] || [ $# -eq 5 ] || { echo "usage: publish.sh <version> <installers dir> <notes.md> <commit> [min version]" >&2; exit 2; }
version=$1 dir=$2 notes=$3 min=${5:-}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
commit=$(git -C "$repo" rev-parse --verify "$4^{commit}")
slug=$(gh repo view --json nameWithOwner -q .nameWithOwner)
tag=desktop-v$version
git -C "$repo" fetch -q --tags
since=$(git -C "$repo" tag --list 'desktop-v*' --sort=-creatordate | head -n 1)
[ -n "$since" ] || { echo "no earlier desktop-v* tag" >&2; exit 1; }
if command -v sha256sum >/dev/null; then sum='sha256sum'; else sum='shasum -a 256'; fi

node "$here/make-manifest.mjs" "$dir" --version "$version" \
  --base-url "https://github.com/$slug/releases/download/$tag" --out "$dir/downloads.json"
(cd "$dir" && $sum SlicerX_* > SHA256SUMS.txt)
(cd "$repo" && node "$here/whats-changed.mjs" --since "$since" --to "$commit" --json) > "$dir/whats-changed.json"
updates=
pubkey=$(node "$repo/packages/edition-config/src/cli.ts" resolve "$repo/editions/slicerx/edition.config.ts" |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).release.updates?.pubkey ?? ""))')
# with an update key set, every release carries updates for macOS, Windows and Linux; an unsigned folder stops here
if [ -n "$pubkey" ] && ! ls "$dir"/SlicerX_"$version"_*.sig >/dev/null 2>&1; then
  echo "the edition has an update key, but no update bundle in $dir is signed (sign-updates.sh)" >&2; exit 1
fi
if ls "$dir"/SlicerX_"$version"_*.sig >/dev/null 2>&1; then
  [ -n "$pubkey" ] || { echo "update bundles are signed, but the edition config has no release.updates.pubkey" >&2; exit 1; }
  changes=$dir/whats-changed.json
  [ -f "$dir/changed.md" ] && changes=$dir/changed.md
  node "$here/latest-json.mjs" "$dir" --version "$version" --base-url "https://github.com/$slug/releases/download/$tag" \
    --release-url "https://github.com/$slug/releases/tag/$tag" --pubkey "$pubkey" --notes "$changes" ${min:+--min-version "$min"} --out "$dir/latest.json"
  updates=$dir/latest.json
fi
body=$(mktemp)
# a hand-written changed.md in the folder replaces the generated list when a release has many small lines
if [ -f "$dir/changed.md" ]; then cat "$dir/changed.md"; else (cd "$repo" && node "$here/whats-changed.mjs" --since "$since" --to "$commit" 2>/dev/null || true); fi |
  node -e '
    const fs = require("node:fs")
    const changed = fs.readFileSync(0, "utf8").trim()
    const [, file, version, commit] = process.argv
    const notes = fs.readFileSync(file, "utf8").trimEnd().replaceAll("{{version}}", version).replaceAll("{{commit}}", commit.slice(0, 7))
    const cut = notes.indexOf("\n\n")
    // the list goes after the first paragraph
    const out = !changed ? notes : cut < 0 ? `${notes}\n\n${changed}` : `${notes.slice(0, cut)}\n\n${changed}${notes.slice(cut)}`
    process.stdout.write(out + "\n")' "$notes" "$version" "$commit" > "$body"

gh release create "$tag" --target "$commit" --title "SlicerX $version (pre-alpha)" --notes-file "$body" --latest \
  "$dir"/SlicerX_* "$dir/SHA256SUMS.txt" "$dir/downloads.json" "$dir/whats-changed.json" ${updates:+"$updates"}
rm -f "$body"
# the feed moves only once the release it points at is up
if [ -n "$updates" ]; then
  gh release view desktop-updates >/dev/null 2>&1 ||
    gh release create desktop-updates --title "Desktop updates" --prerelease --latest=false \
      --notes "The update feed the SlicerX desktop app reads. Each desktop release replaces latest.json here; the downloads are on the desktop-v releases."
  gh release upload desktop-updates "$updates" --clobber
fi
