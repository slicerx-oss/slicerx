// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The native window follows the app's light or dark mode, so the Windows and Linux title bar (and the macOS
// traffic lights and menus) match the theme, now and on every switch.
import { onThemeChange } from '@slicerx/ui/theme'
import { getCurrentWindow } from '@tauri-apps/api/window'

type SetTheme = (theme: 'light' | 'dark') => Promise<void>

/** Sets the window theme for each applied app theme, skipping repeats. Returns an unsubscribe. */
export function followAppTheme(setTheme: SetTheme = (t) => getCurrentWindow().setTheme(t), target?: EventTarget): () => void {
  let last: 'light' | 'dark' | null = null
  return onThemeChange((theme) => {
    if (theme.scheme === last) return
    last = theme.scheme
    void setTheme(theme.scheme).catch(() => undefined)
  }, target)
}
