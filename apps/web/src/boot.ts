// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs before the app's code loads: picks the opening frame index.html paints (setup's card on a first launch, the
// Slice panes after) and its light or dark ground, from the saved preferences. The app removes the frame
// (packages/app/src/shell/boot.tsx).
const root = document.documentElement
try {
  const raw = localStorage.getItem('slicerx.prefs.v1')
  const prefs = raw ? (JSON.parse(raw) as { scheme?: string; themeFollowsSystem?: boolean }) : null
  root.dataset['boot'] = prefs ? 'studio' : 'setup'
  const light = prefs?.themeFollowsSystem ? matchMedia('(prefers-color-scheme: light)').matches : prefs?.scheme === 'light'
  if (light) root.dataset['bootScheme'] = 'light'
} catch {
  root.dataset['boot'] = 'setup'
}
