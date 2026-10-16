// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// setTheme takes a ViewportTheme or a full UI theme (createTheme, as a host passes its app theme straight through), and
// keeps the current look with a warning for anything else.
import { describe, expect, it, vi } from 'vitest'
import { resolveTheme, sceneFromUiTheme, viewportThemeOf } from '../src/palette'

// a full light UI theme, shaped as @slicerx/ui createTheme returns it, with a partner's studio block
const uiLight = {
  name: 'partner-light',
  scheme: 'light' as const,
  colors: { ink0: '#f4f6f2', ink1: '#ffffff', ink2: '#edf1e9', line: '#ccd4c6', fg: '#20271c', purple: '#456b0b', cyan: '#2f7d6a' },
  gradient: { from: '#456b0b', to: '#2f7d6a', angle: '120deg' },
  fonts: { display: 'Inter', body: 'Inter', mono: 'monospace' },
  radius: { md: '6px', lg: '10px' },
  scene: { top: '#f1f4ee', bottom: '#cdd6c4', glow: '#ffffff', plate: '#dfe6d8', grid: '#a9b89c', edge: '#7d8c70' },
}

describe('setTheme input', () => {
  it('passes a ViewportTheme through', () => {
    const theme = { scene: { bgTop: '#101010', selection: '#b8f34a' } }
    expect(viewportThemeOf(theme)).toEqual({ theme })
    expect(viewportThemeOf(undefined)).toEqual({ theme: undefined })
  })

  it('turns a full UI theme into its scene colors, which resolve without throwing', () => {
    const got = viewportThemeOf(uiLight)
    expect(got?.theme?.scene).toMatchObject({ bgTop: '#f1f4ee', bgBottom: '#cdd6c4', plateSide: '#dfe6d8', floorGrid: '#a9b89c', edgeDark: '#7d8c70', selection: '#456b0b', liveLayer: '#2f7d6a' })
    expect(() => resolveTheme(got?.theme)).not.toThrow()
    // a UI theme without a studio block, light: a studio built from its surfaces
    const { scene: _, ...plain } = uiLight
    expect(sceneFromUiTheme(plain)?.scene?.bgTop).toMatch(/^#[0-9a-f]{6}$/)
    // an --accent wins over the palette purple, and invalid colors are left out
    expect(sceneFromUiTheme({ colors: { purple: 'green' }, visuals: { '--accent': '#b8f34a' } })).toEqual({ scene: { selection: '#b8f34a' } })
    expect(sceneFromUiTheme({ colors: { purple: 'green' } })).toBeUndefined()
  })

  it('keeps the look and warns for any other shape', () => {
    const warn = vi.fn()
    expect(viewportThemeOf({ top: '#ffffff', accent: '#b8f34a' }, warn)).toBeNull()
    expect(viewportThemeOf('dark', warn)).toBeNull()
    expect(viewportThemeOf([], warn)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
