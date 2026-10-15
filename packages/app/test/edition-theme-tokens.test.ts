// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, clearTheme, subban, subbanLight } from '@slicerx/ui'
import type { EditionConfig } from '@slicerx/edition-config'
import { applyPreset, clearPreset, resolvePreset } from '@slicerx/ui/look'
import { brandAccent, editionTheme, NEUTRAL, setCurrentEdition } from '../src/edition'
import { sceneThemeFromCss } from '../src/viewport/scene-theme'
import { runCall } from '../src/app-link/methods'

const edition: EditionConfig = {
  ...NEUTRAL,
  brand: {
    ...NEUTRAL.brand,
    theme: {
      base: 'subban',
      tokens: { visuals: { '--ti-sk': '#abcdef' } },
      dark: { visuals: { '--accent': '#88ddcc', '--glyph-halo': '#112233dd' } },
      light: { visuals: { '--accent': '#146676', '--ti-sk': '#123456' } },
    },
  },
}

afterEach(() => { clearTheme(); clearPreset(); setCurrentEdition(NEUTRAL) })

describe('edition theme modes', () => {
  it('merges shared values with the selected mode and clears values absent from the next mode', () => {
    const root = document.documentElement
    applyTheme(editionTheme(edition, 'dark'))
    applyPreset(resolvePreset('slicerx'))
    expect(root.style.getPropertyValue('--accent')).toBe('#88ddcc')
    expect(root.style.getPropertyValue('--ti-sk')).toBe('#abcdef')
    expect(root.style.getPropertyValue('--glyph-halo')).toBe('#112233dd')
    applyTheme(editionTheme(edition, 'light'))
    applyPreset(resolvePreset('slicerx'))
    expect(root.style.getPropertyValue('--accent')).toBe('#146676')
    expect(root.style.getPropertyValue('--ti-sk')).toBe('#123456')
    expect(root.style.getPropertyValue('--glyph-halo')).toBe('')
  })

  it('keeps both stock themes unchanged when the edition has no overrides', () => {
    expect(editionTheme(NEUTRAL, 'dark')).toEqual(subban)
    expect(editionTheme(NEUTRAL, 'light')).toEqual(subbanLight)
  })

  it('passes the active accent and glyph overrides to the renderer and reads them back', async () => {
    setCurrentEdition(edition)
    for (const scheme of ['dark', 'light'] as const) {
      applyTheme(editionTheme(edition, scheme))
      applyPreset(resolvePreset('slicerx'))
      const expected = scheme === 'dark' ? '#88ddcc' : '#146676'
      expect(sceneThemeFromCss()?.scene?.selection).toBe(expected)
      expect(brandAccent()).toBe(expected)
      expect(sceneThemeFromCss()?.glyphs).toEqual(scheme === 'dark' ? { halo: '#112233dd' } : undefined)
      const look = await runCall('look.get', {}) as { theme: { scheme: string; visuals: Record<string, string>; overrides: Record<string, string> } }
      expect(look.theme.scheme).toBe(scheme)
      expect(look.theme.visuals['--accent']).toBe(expected)
      expect(look.theme.overrides['--accent']).toBe(expected)
      expect(look.theme.overrides['--ti-sk']).toBe(scheme === 'dark' ? '#abcdef' : '#123456')
    }
    applyTheme(editionTheme(NEUTRAL, 'dark'))
    expect(sceneThemeFromCss()?.glyphs).toBeUndefined()
  })
})
