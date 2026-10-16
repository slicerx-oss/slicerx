// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, clearTheme, subban, subbanLight } from '@slicerx/ui'
import type { EditionConfig } from '@slicerx/edition-config'
import { applyPreset, clearPreset, resolvePreset } from '@slicerx/ui/look'
import { brandAccent, editionTheme, NEUTRAL, setCurrentEdition } from '../src/edition'
import { sceneThemeFromCss } from '../src/viewport/scene-theme'
import { syncViewportLook } from '../src/viewport/viewport-look'
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

// A lime partner edition: its studio and accent come from the config, per scheme, and read back over the app link.
const lime: EditionConfig = {
  ...NEUTRAL,
  id: 'lime',
  brand: {
    ...NEUTRAL.brand,
    theme: {
      base: 'subban',
      tokens: { scene: { grid: '#4a5363' } },
      dark: { visuals: { '--accent': '#b8f34a' }, scene: { top: '#1a1d23', bottom: '#0a0c10', glow: '#22262e', plate: '#2a2e37', edge: '#050608' } },
      light: { visuals: { '--accent': '#456b0b' }, scene: { top: '#f1f4ee', bottom: '#cdd6c4', grid: '#a9b89c' } },
    },
  },
}

describe('edition studio colors', () => {
  it('sets the viewport scene from the edition per scheme, SlicerX values for keys it leaves out', async () => {
    setCurrentEdition(lime)
    applyTheme(editionTheme(lime, 'dark'))
    let scene = sceneThemeFromCss()?.scene
    expect(scene).toMatchObject({ bgTop: '#1a1d23', bgBottom: '#0a0c10', bgGlow: '#22262e', plateSide: '#2a2e37', floorGrid: '#4a5363', edgeDark: '#050608', selection: '#b8f34a' })
    let look = await runCall('look.get', {}) as { theme: { scene: Record<string, string>; sceneOverrides: Record<string, string> } }
    expect(look.theme.scene).toMatchObject({ top: '#1a1d23', bottom: '#0a0c10', grid: '#4a5363' })
    expect(look.theme.sceneOverrides).toEqual({ grid: '#4a5363', top: '#1a1d23', bottom: '#0a0c10', glow: '#22262e', plate: '#2a2e37', edge: '#050608' })
    applyTheme(editionTheme(lime, 'light'))
    scene = sceneThemeFromCss()?.scene
    // glow, plate and edge are not set for light: the SlicerX light studio fills them
    expect(scene).toMatchObject({ bgTop: '#f1f4ee', bgBottom: '#cdd6c4', floorGrid: '#a9b89c', bgGlow: subbanLight.scene!.glow, plateSide: subbanLight.scene!.plate, selection: '#456b0b' })
    look = await runCall('look.get', {}) as { theme: { scene: Record<string, string>; sceneOverrides: Record<string, string> } }
    expect(look.theme.sceneOverrides).toEqual({ top: '#f1f4ee', bottom: '#cdd6c4', grid: '#a9b89c' })
  })

  it('records the scene the view was given for read-back', () => {
    applyTheme(editionTheme(lime, 'dark'))
    const vp = { setLook: () => undefined, look: () => ({ version: 1 }) as never }
    const state = syncViewportLook(vp, undefined, sceneThemeFromCss())
    expect(state.themeBackdrop).toBe(true)
    expect(state.scene).toMatchObject({ bgTop: '#1a1d23', bgBottom: '#0a0c10', floorGrid: '#4a5363', selection: '#b8f34a' })
  })

  it('leaves the SlicerX studio alone without edition scene keys, and drops invalid ones', () => {
    expect(editionTheme(NEUTRAL, 'dark').scene).toBeUndefined()
    expect(editionTheme(edition, 'dark').scene).toEqual(subban.scene)
    const broken = { ...lime, brand: { ...lime.brand, theme: { base: 'subban', tokens: {}, dark: { scene: { top: 'lime', bottom: '#0a0c10' } } } } } as unknown as EditionConfig
    expect(editionTheme(broken, 'dark').scene).toEqual({ top: '#2f3241', bottom: '#0a0c10', glow: '#3c3f50', plate: '#3c3f50', grid: '#9aa4c1', edge: '#16171e' })
  })
})
