// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs before the app's code loads: picks the opening frame index.html paints (setup's card on a first launch, the
// Slice panes after) and its light or dark ground, from the saved preferences, then shows the window, which opens
// hidden, on that ground. The app removes the frame (packages/app/src/shell/boot.tsx); Rust shows the window anyway
// if this never runs.
import { getCurrentWindow } from '@tauri-apps/api/window'

const root = document.documentElement
let light = false
try {
  const raw = localStorage.getItem('slicerx.prefs.v1')
  const prefs = raw ? (JSON.parse(raw) as { scheme?: string; themeFollowsSystem?: boolean }) : null
  root.dataset['boot'] = prefs ? 'studio' : 'setup'
  light = prefs?.themeFollowsSystem ? matchMedia('(prefers-color-scheme: light)').matches : prefs?.scheme === 'light'
  if (light) root.dataset['bootScheme'] = 'light'
} catch {
  root.dataset['boot'] = 'setup'
}
const win = getCurrentWindow()
// The same grounds as the frame: Subban's --ink-0, dark and light.
void (light ? win.setBackgroundColor('#fbf8ff') : Promise.resolve())
  .catch(() => undefined)
  .then(() => win.show())
  .catch(() => undefined)
