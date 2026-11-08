#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Downloads one file from a GitHub release for a CI step: signed in with the job's token when GITHUB_TOKEN is set (an
# anonymous request fails first when GitHub's file hosting times out), and retried on every error with a fixed pause.
#
#   GITHUB_TOKEN=... sh scripts/ci/gh-download.sh <url> <output file>
#
# The token goes to curl on its standard input as a config line, never in its arguments, so it is not in the process
# list. curl drops the header when a release download redirects to another host. The file is written under a .part
# name and moved into place only after a complete download; the caller checks its sha256.
set -eu
url=${1:?usage: gh-download.sh <url> <output file>}
out=${2:?usage: gh-download.sh <url> <output file>}
mkdir -p "$(dirname "$out")"
rm -f "$out.part"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth=$(printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN")
else
  auth='# no GITHUB_TOKEN: anonymous request'
  echo "gh-download: GITHUB_TOKEN is not set, downloading without signing in" >&2
fi
printf '%s\n' "$auth" | curl --fail --silent --show-error --location --proto '=https' \
  --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 30 --max-time 180 \
  --config - --output "$out.part" "$url"
mv "$out.part" "$out"
