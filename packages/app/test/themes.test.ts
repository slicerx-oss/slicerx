// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { serializeTheme, type ThemeFile } from '@slicerx/ui/theme'
import { BUNDLED_THEMES } from '@slicerx/ui/theme-bundle'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadPrefs, savePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'
import { loadUserThemes } from '../src/theme/load'
import { themesFromFiles } from '../src/theme/folder'
import { importThemeText, removeUserTheme, themeList } from '../src/theme/user-themes'

const dark = BUNDLED_THEMES.find((t) => t.id === 'subban-dark') as ThemeFile
const mine = (id: string, name = 'Mine'): string => serializeTheme({ ...dark, id, name })

beforeEach(() => set({ userThemes: [], folderThemes: [], themeIds: { dark: 'subban-dark', light: 'subban-light' } }))

describe('user themes', () => {
  it('keeps valid saved entries and drops broken ones', () => {
    const out = loadUserThemes([{ ...dark, id: 'ok' }, { id: 'broken' }, 7, null])
    expect(out.map((t) => t.id)).toEqual(['ok'])
    expect(loadUserThemes(undefined)).toEqual([])
  })

  it('imports a valid file and lists it after the bundled themes', () => {
    const r = importThemeText(mine('night-owl', 'Night Owl'))
    expect(r.ok).toBe(true)
    expect(get().userThemes.map((t) => t.id)).toEqual(['night-owl'])
    const ids = themeList(get().userThemes, []).map((t) => t.id)
    expect(ids.at(-1)).toBe('night-owl')
    expect(ids).toHaveLength(BUNDLED_THEMES.length + 1)
  })

  it('reports why a file is rejected and keeps nothing', () => {
    const r = importThemeText('{"version":1}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(3)
    expect(importThemeText('nope').ok).toBe(false)
    expect(get().userThemes).toEqual([])
  })

  it('does not let an import silently replace a bundled theme', () => {
    const r = importThemeText(mine('subban-dark', 'My Subban'), 'my-subban.json')
    expect(r.ok && r.theme.id).toBe('my-subban')
    expect(themeList(get().userThemes, []).find((t) => t.id === 'subban-dark')?.name).toBe('Subban')
    // a copy of a bundled theme gets its own card, not a place in the family it came from
    expect(r.ok && r.theme.family).toBeUndefined()
  })

  it('importing the same file again updates the person\'s own theme', () => {
    importThemeText(mine('mine', 'First'))
    importThemeText(mine('mine', 'Second'))
    expect(get().userThemes).toHaveLength(1)
    expect(get().userThemes[0]?.name).toBe('Second')
  })

  it('removing a theme in use returns that slot to the default', () => {
    importThemeText(mine('mine'))
    set({ themeIds: { dark: 'mine', light: 'subban-light' } })
    removeUserTheme('mine')
    expect(get().userThemes).toEqual([])
    expect(get().themeIds.dark).toBe('subban-dark')
  })

  it('reads the desktop folder: valid files only, the last of an id wins', () => {
    const out = themesFromFiles([mine('a', 'A1'), '{broken', mine('b'), mine('a', 'A2')])
    expect(out.map((t) => `${t.id}:${t.name}`)).toEqual(['a:A2', 'b:Mine'])
  })

  it('folder themes extend the list', () => {
    expect(themeList([], themesFromFiles([mine('from-folder')])).map((t) => t.id)).toContain('from-folder')
  })
})

describe('stored theme preferences', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips ids, fonts and user themes', () => {
    savePrefs({ ...loadPrefs(), themeIds: { dark: 'tokyo-night', light: 'one-light' }, fonts: { ui: 'inter', mono: 'theme' }, userThemes: [{ ...dark, id: 'x' }] })
    const p = loadPrefs()
    expect(p.themeIds).toEqual({ dark: 'tokyo-night', light: 'one-light' })
    expect(p.fonts).toEqual({ ui: 'inter', mono: 'theme' })
    expect(loadUserThemes(p.userThemes).map((t) => t.id)).toEqual(['x'])
  })
  it('moves the earlier ids of the default theme to Subban', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ themeIds: { dark: 'slicerx-dark', light: 'slicerx-light' } }))
    expect(loadPrefs().themeIds).toEqual({ dark: 'subban-dark', light: 'subban-light' })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ themeIds: { dark: 'nocturne', light: 'nocturne-light' } }))
    expect(loadPrefs().themeIds).toEqual({ dark: 'subban-dark', light: 'subban-light' })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ themeIds: { dark: 'tokyo-night', light: 'catppuccin-latte' } }))
    expect(loadPrefs().themeIds).toEqual({ dark: 'tokyo-night', light: 'catppuccin-latte' })
  })
  it('ignores malformed values', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ themeIds: { dark: 3 }, fonts: 'x', userThemes: 'x' }))
    const p = loadPrefs()
    expect(p.themeIds).toBeUndefined()
    expect(p.fonts).toBeUndefined()
    expect(p.userThemes).toBeUndefined()
  })
})
