#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Installs the system libraries the desktop shell (slicerx-desktop) links on a hosted Linux runner.
#
#   scripts/ci/apt-desktop-libs.sh
#
# Through apt-install.sh: from the .deb files in SX_APT_CACHE (by default ~/.cache/sx-apt/desktop, which the workflow
# keeps with actions/cache per runner image) when they are there, so a warm cache needs no package mirror; otherwise
# from the mirror with cut-off retries and a fallback mirror. The workflow gives the step 10 minutes.
set -uo pipefail
exec bash "$(dirname "$0")/apt-install.sh" --cache "${SX_APT_CACHE:-$HOME/.cache/sx-apt/desktop}" \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev
