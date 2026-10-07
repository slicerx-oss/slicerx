// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The theme library: the bundled themes (JSON files in packages/ui/themes) plus the person's own,
// and the choice of which one is showing.

import subbanDark from '../themes/subban-dark.json'
import subbanLight from '../themes/subban-light.json'
import dracula from '../themes/dracula.json'
import alucard from '../themes/alucard.json'
import catppuccinMocha from '../themes/catppuccin-mocha.json'
import catppuccinMacchiato from '../themes/catppuccin-macchiato.json'
import catppuccinFrappe from '../themes/catppuccin-frappe.json'
import catppuccinLatte from '../themes/catppuccin-latte.json'
import nord from '../themes/nord.json'
import nordLight from '../themes/nord-light.json'
import atomOneDark from '../themes/atom-one-dark.json'
import oneLight from '../themes/one-light.json'
import tokyoNight from '../themes/tokyo-night.json'
import tokyoNightDay from '../themes/tokyo-night-day.json'
import githubDark from '../themes/github-dark.json'
import githubLight from '../themes/github-light.json'
import solarizedDark from '../themes/solarized-dark.json'
import solarizedLight from '../themes/solarized-light.json'
import night from '../themes/night.json'
import nightLight from '../themes/night-light.json'
import gothic from '../themes/gothic.json'
import gothicDark from '../themes/gothic-dark.json'
import newsprint from '../themes/newsprint.json'
import newsprintDark from '../themes/newsprint-dark.json'
import pixyll from '../themes/pixyll.json'
import pixyllDark from '../themes/pixyll-dark.json'
import whitey from '../themes/whitey.json'
import whiteyDark from '../themes/whitey-dark.json'
import { validateThemeFile, type ThemeFile } from './themefile'

export const DEFAULT_DARK_THEME = 'subban-dark'
export const DEFAULT_LIGHT_THEME = 'subban-light'

function bundle(raw: unknown): ThemeFile {
  const r = validateThemeFile(raw)
  if (!r.ok) throw new Error(`Bundled theme is invalid: ${r.errors.join(' ')}`)
  return r.theme
}

/** Family by family, Subban first; within a family the dark modes, then the light one. */
export const BUNDLED_THEMES: readonly ThemeFile[] = [
  subbanDark,
  subbanLight,
  dracula,
  alucard,
  catppuccinMocha,
  catppuccinMacchiato,
  catppuccinFrappe,
  catppuccinLatte,
  nord,
  nordLight,
  atomOneDark,
  oneLight,
  tokyoNight,
  tokyoNightDay,
  githubDark,
  githubLight,
  solarizedDark,
  solarizedLight,
  night,
  nightLight,
  gothic,
  gothicDark,
  newsprint,
  newsprintDark,
  pixyll,
  pixyllDark,
  whitey,
  whiteyDark,
].map(bundle)

/** Bundled plus the person's themes. A user theme with a bundled id replaces it. */
export function allThemes(user: readonly ThemeFile[] = []): ThemeFile[] {
  const byId = new Map<string, ThemeFile>()
  for (const t of BUNDLED_THEMES) byId.set(t.id, t)
  for (const t of user) byId.set(t.id, t)
  return [...byId.values()]
}

/**
 * Ids the default themes shipped under before: SlicerX dark and light, and Nocturne. Stored choices
 * and theme files that use them still resolve, to Subban.
 */
export const LEGACY_THEME_IDS: Readonly<Record<string, string>> = {
  'slicerx-dark': DEFAULT_DARK_THEME,
  'slicerx-light': DEFAULT_LIGHT_THEME,
  nocturne: DEFAULT_DARK_THEME,
  'nocturne-dark': DEFAULT_DARK_THEME,
  'nocturne-light': DEFAULT_LIGHT_THEME,
}

/** A stored id under its current name. */
export function migrateThemeId(id: string): string {
  return LEGACY_THEME_IDS[id] ?? id
}

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

/** One card in the picker: a theme's light and dark modes, and its flavors when it has more than one of a brightness. */
export interface ThemeFamily {
  id: string
  name: string
  dark: ThemeFile[]
  light: ThemeFile[]
}

/** The family a theme belongs to: its `family`, or its own id for a theme without one. */
export function familyId(t: ThemeFile): string {
  return t.family ?? t.id
}

/** Themes grouped into families, in the order of their first theme. */
export function themeFamilies(themes: readonly ThemeFile[]): ThemeFamily[] {
  const byId = new Map<string, ThemeFamily>()
  for (const t of themes) {
    const id = familyId(t)
    let f = byId.get(id)
    if (!f) {
      f = { id, name: t.familyName ?? t.name, dark: [], light: [] }
      byId.set(id, f)
    }
    ;(t.isDark ? f.dark : f.light).push(t)
  }
  return [...byId.values()]
}

/**
 * Picking a family fills both slots with its modes. The dark slot takes `flavor` when given, keeps
 * the current dark theme when it is already of this family, else the family's first dark theme.
 * A family with only one brightness fills only that slot.
 */
export function pickFamily(ids: ThemeIds, family: ThemeFamily, flavor?: string): ThemeIds {
  const choose = (list: ThemeFile[], current: string, want?: string) => (want && list.some((t) => t.id === want) ? want : list.some((t) => t.id === current) ? current : list[0]?.id)
  return { dark: choose(family.dark, ids.dark, flavor) ?? ids.dark, light: choose(family.light, ids.light, flavor) ?? ids.light }
}

/** Slugs a new theme id from a file name or title. */
export function slugify(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  return s || 'theme'
}
