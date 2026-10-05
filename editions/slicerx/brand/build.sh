#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Rebuilds every brand file: the SVGs in svg/, the rasters in out/, the credit kit's badges, and the
# copies the apps ship.
# The SVGs are the source of truth; the PNGs, .ico and .icns exist for places that cannot take one.
# Needs Node 24 and network access the first time, to install sharp and opentype.js into .cache/,
# which stays out of the repository.
#
#   ./build.sh           SVGs, rasters, and the copies into the apps
#   ./build.sh --no-wire SVGs and rasters only
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .cache/node_modules/sharp ] || [ ! -d .cache/node_modules/opentype.js ]; then
  npm install --prefix .cache --no-save --no-audit --no-fund opentype.js@1 sharp
fi

node emit.mjs
node raster.mjs
node credit.mjs
if [ "${1:-}" != "--no-wire" ]; then
  node wire.mjs
fi
