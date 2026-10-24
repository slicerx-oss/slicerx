// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The native window follows the app's light or dark mode, so the Windows and Linux title bar (and the macOS
// traffic lights and menus) match the theme, now and on every switch. Its background follows the page's own, and the
// shell keeps it for the next launch (src-tauri/src/prefs.rs), so the window never opens in a color the app is not.
import { invoke } from '@tauri-apps/api/core'
import { onThemeChange, pageBackground } from '@slicerx/ui/theme'
import { getCurrentWindow } from '@tauri-apps/api/window'

type SetTheme = (theme: 'light' | 'dark') => Promise<void>
type SaveBackground = (color: string) => Promise<unknown>

/** Sets the window theme and background for each applied app theme, skipping repeats. Returns an unsubscribe. */
export function followAppTheme(
  setTheme: SetTheme = (t) => getCurrentWindow().setTheme(t),
  target?: EventTarget,
  saveBackground: SaveBackground = (color) => invoke('window_background_save', { color }),
  background: () => string | null = () => pageBackground(),
): () => void {
  let last: 'light' | 'dark' | null = null
  let lastBg: string | null = null
  return onThemeChange((theme) => {
    if (theme.scheme !== last) {
      last = theme.scheme
      void setTheme(theme.scheme).catch(() => undefined)
    }
    const bg = background()
    if (bg === null || bg === lastBg) return
    lastBg = bg
    try {
      void saveBackground(bg).catch(() => undefined)
    } catch {
      // a page outside the shell has no window to paint
    }
  }, target)
}
