#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Publishes a desktop release from installers already built and signed on their own machines.
#   apps/desktop/release/publish.sh <version> <installers dir> <notes.md> <commit>
# Writes downloads.json, SHA256SUMS.txt and whats-changed.json into the folder, puts the "What changed" list
# after the first paragraph of the notes, and creates desktop-v<version> as the latest release at <commit>.
# The release bot reads whats-changed.json for the fixed-in replies.
set -eu
[ $# -eq 4 ] || { echo "usage: publish.sh <version> <installers dir> <notes.md> <commit>" >&2; exit 2; }
version=$1 dir=$2 notes=$3
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
body=$(mktemp)
(cd "$repo" && node "$here/whats-changed.mjs" --since "$since" --to "$commit" 2>/dev/null || true) |
  node -e '
    const fs = require("node:fs")
    const changed = fs.readFileSync(0, "utf8").trim()
    const notes = fs.readFileSync(process.argv[1], "utf8").trimEnd()
    const cut = notes.indexOf("\n\n")
    // the list goes after the first paragraph
    const out = !changed ? notes : cut < 0 ? `${notes}\n\n${changed}` : `${notes.slice(0, cut)}\n\n${changed}${notes.slice(cut)}`
    process.stdout.write(out + "\n")' "$notes" > "$body"

gh release create "$tag" --target "$commit" --title "SlicerX $version (pre-alpha)" --notes-file "$body" --latest \
  "$dir"/SlicerX_* "$dir/SHA256SUMS.txt" "$dir/downloads.json" "$dir/whats-changed.json"
rm -f "$body"
