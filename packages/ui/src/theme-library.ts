// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The theme library: the bundled themes (JSON files in packages/ui/themes) plus the person's own,
// and the choice of which one is showing.

import atomOneDark from '../themes/atom-one-dark.json'
import githubLight from '../themes/github-light.json'
import oneLight from '../themes/one-light.json'
import slicerxDark from '../themes/slicerx-dark.json'
import slicerxLight from '../themes/slicerx-light.json'
import solarizedLight from '../themes/solarized-light.json'
import tokyoNight from '../themes/tokyo-night.json'
import { validateThemeFile, type ThemeFile } from './themefile'

export const DEFAULT_DARK_THEME = 'slicerx-dark'
export const DEFAULT_LIGHT_THEME = 'slicerx-light'

function bundle(raw: unknown): ThemeFile {
  const r = validateThemeFile(raw)
  if (!r.ok) throw new Error(`Bundled theme is invalid: ${r.errors.join(' ')}`)
  return r.theme
}

/** Dark themes first, default first; then light themes, default first. */
export const BUNDLED_THEMES: readonly ThemeFile[] = [slicerxDark, tokyoNight, atomOneDark, slicerxLight, githubLight, solarizedLight, oneLight].map(bundle)

/** Bundled plus the person's themes. A user theme with a bundled id replaces it. */
export function allThemes(user: readonly ThemeFile[] = []): ThemeFile[] {
  const byId = new Map<string, ThemeFile>()
  for (const t of BUNDLED_THEMES) byId.set(t.id, t)
  for (const t of user) byId.set(t.id, t)
  return [...byId.values()]
}

/** The ids the default themes shipped under before the rename. Stored choices and theme files that use them still resolve. */
export const LEGACY_THEME_IDS: Readonly<Record<string, string>> = { 'subban-dark': DEFAULT_DARK_THEME, 'subban-light': DEFAULT_LIGHT_THEME }

/** The theme for an id, falling back to the default of the slot the id was meant for. */
export function findTheme(id: string, scheme: 'dark' | 'light', user: readonly ThemeFile[] = []): ThemeFile {
  const all = allThemes(user)
  const hit = all.find((t) => t.id === id) ?? all.find((t) => t.id === LEGACY_THEME_IDS[id])
  if (hit) return hit
  const fallback = scheme === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME
  return all.find((t) => t.id === fallback) ?? (BUNDLED_THEMES[0] as ThemeFile)
}

/** Which theme fills each slot. The app shows the dark slot or the light slot. */
export interface ThemeIds {
  dark: string
  light: string
}

export const DEFAULT_THEME_IDS: ThemeIds = { dark: DEFAULT_DARK_THEME, light: DEFAULT_LIGHT_THEME }

/** Picking a theme fills the slot its brightness belongs to. */
export function pickTheme(ids: ThemeIds, theme: ThemeFile): ThemeIds {
  return theme.isDark ? { ...ids, dark: theme.id } : { ...ids, light: theme.id }
}

/** The theme to show for a scheme. */
export function themeForScheme(scheme: 'dark' | 'light', ids: ThemeIds, user: readonly ThemeFile[] = []): ThemeFile {
  return findTheme(scheme === 'dark' ? ids.dark : ids.light, scheme, user)
}

/** Slugs a new theme id from a file name or title. */
export function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  return s || 'theme'
}
