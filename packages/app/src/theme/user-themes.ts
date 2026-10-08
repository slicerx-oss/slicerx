// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person's own themes: imported files and the desktop themes folder. Everything is validated
// again on load, so a hand-edited or corrupt entry is dropped and never reaches the UI.
import { allThemes, DEFAULT_THEME_IDS, parseThemeText, slugify, type ThemeFile } from '@slicerx/ui/theme'
import { BUNDLED_THEMES } from '@slicerx/ui/theme-bundle'
import { get, set } from '../state/store'

export { loadUserThemes } from './load'

/** Bundled themes plus the person's, user ones replacing bundled ones with the same id. */
export function themeList(userThemes: readonly ThemeFile[], folderThemes: readonly ThemeFile[]): ThemeFile[] {
  return allThemes([...userThemes, ...folderThemes], BUNDLED_THEMES)
}

export type ImportResult = { ok: true; theme: ThemeFile; warnings: string[] } | { ok: false; errors: string[] }

/** Parses theme text and, if it is valid, keeps it. A file with a taken id gets a numbered id, except to replace the person's own theme. */
export function importThemeText(text: string, fileName = ''): ImportResult {
  const r = parseThemeText(text)
  if (!r.ok) return r
  const state = get()
  const taken = new Set(themeList([], []).map((t) => t.id))
  const own = new Set(state.userThemes.map((t) => t.id))
  let theme = r.theme
  // A copy of a bundled theme stands on its own card; it never joins the bundled family it came from.
  if (theme.family && BUNDLED_THEMES.some((t) => t.family === theme.family)) {
    const own: ThemeFile = { ...theme }
    delete own.family
    delete own.familyName
    delete own.flavor
    theme = own
  }
  if (taken.has(theme.id) && !own.has(theme.id)) {
    const base = slugify(fileName.replace(/\.json$/i, '') || theme.name)
    let id = base === theme.id ? `${base}-custom` : base
    for (let n = 2; taken.has(id) || (own.has(id) && id !== theme.id); n++) id = `${base}-${n}`
    theme = { ...theme, id }
  }
  set({ userThemes: [...state.userThemes.filter((t) => t.id !== theme.id), theme] })
  return { ok: true, theme, warnings: r.warnings }
}

export function removeUserTheme(id: string): void {
  const s = get()
  const userThemes = s.userThemes.filter((t) => t.id !== id)
  const themeIds = { dark: s.themeIds.dark === id ? DEFAULT_THEME_IDS.dark : s.themeIds.dark, light: s.themeIds.light === id ? DEFAULT_THEME_IDS.light : s.themeIds.light }
  set({ userThemes, themeIds })
}
