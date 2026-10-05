// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loads the desktop themes folder at startup and when the window regains focus, so a file the
// person drops in shows up without a restart. The browser has no folder and does nothing.
import type { Host } from '@slicerx/contracts'
import { parseThemeText, type ThemeFile } from '@slicerx/ui/theme'
import { useEffect } from 'react'
import { set } from '../state/store'

/** Valid themes from the files' text, the last file winning when ids repeat. */
export function themesFromFiles(texts: readonly string[]): ThemeFile[] {
  const byId = new Map<string, ThemeFile>()
  for (const text of texts) {
    const r = parseThemeText(text)
    if (r.ok) byId.set(r.theme.id, r.theme)
  }
  return [...byId.values()]
}

export function useFolderThemes(host: Host): void {
  useEffect(() => {
    const themes = host.themes
    if (!themes) return
    let live = true
    const load = () => themes.list().then((texts) => live && set({ folderThemes: themesFromFiles(texts) })).catch(() => undefined)
    void load()
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [host])
}
