// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's look follows the theme: Dark precision on a dark theme, Light studio on a light one, a theme other than
// Subban keeps its own backdrop colors, and the look in use reads back over the app link (look.get).
import { afterEach, describe, expect, it } from 'vitest'
import { DARK_PRECISION_LOOK, LIGHT_STUDIO_LOOK, type ViewportLook } from '@slicerx/viewport'
import { runCall } from '../src/app-link/methods'
import { clearViewportLook, syncViewportLook, themeLook, viewportLookState } from '../src/viewport/viewport-look'

const root = (scheme?: string, name?: string): HTMLElement => {
  const el = document.createElement('div')
  if (scheme) el.dataset['scheme'] = scheme
  if (name) el.dataset['sxTheme'] = name
  return el
}

/** A stand-in for the view: it keeps what it is given and reads it back. */
const fakeView = () => {
  let set: ViewportLook | null = null
  const calls: (ViewportLook | null)[] = []
  return {
    calls,
    setLook: (l: ViewportLook | null) => {
      calls.push(l)
      set = l ? structuredClone(l) : null
    },
    look: () => structuredClone(set ?? DARK_PRECISION_LOOK),
  }
}

afterEach(() => clearViewportLook())

describe('the 3D view look', () => {
  it('picks the preset from the scheme, the Subban themes taking it whole', () => {
    expect(themeLook(root())).toMatchObject({ preset: 'dark-precision', themeBackdrop: false, look: DARK_PRECISION_LOOK })
    expect(themeLook(root('dark', 'subban-dark'))).toMatchObject({ preset: 'dark-precision', themeBackdrop: false, look: DARK_PRECISION_LOOK })
    expect(themeLook(root('light', 'subban-light'))).toMatchObject({ preset: 'light-studio', themeBackdrop: false, look: LIGHT_STUDIO_LOOK })
  })

  it('leaves the backdrop colors to any other theme, and applies the rest of the preset', () => {
    const t = themeLook(root('light', 'catppuccin-latte'))
    expect(t.preset).toBe('light-studio')
    expect(t.themeBackdrop).toBe(true)
    expect(t.look.backdrop).toMatchObject({ top: null, bottom: null, center: null })
    expect(t.look.lighting).toEqual(LIGHT_STUDIO_LOOK.lighting)
    expect(t.look.plate).toEqual(LIGHT_STUDIO_LOOK.plate)
  })

  it('sets the look through one call and reads back what the view draws with', () => {
    const vp = fakeView()
    expect(viewportLookState()).toBeNull()
    syncViewportLook(vp, root('dark', 'subban-dark'))
    expect(vp.calls).toEqual([DARK_PRECISION_LOOK])
    syncViewportLook(vp, root('light', 'subban-light'))
    expect(vp.calls).toHaveLength(2)
    expect(viewportLookState()).toEqual({ preset: 'light-studio', themeBackdrop: false, look: LIGHT_STUDIO_LOOK })
    // a read-back is a copy
    viewportLookState()!.look.plate.borderGlow = 9
    expect(viewportLookState()!.look.plate.borderGlow).toBe(LIGHT_STUDIO_LOOK.plate.borderGlow)
  })

  it('reads back over the app link while a 3D view is up, and not after', async () => {
    expect(await runCall('look.get', {})).not.toHaveProperty('viewport')
    syncViewportLook(fakeView(), root('dark', 'subban-dark'))
    expect(await runCall('look.get', {})).toMatchObject({ viewport: { preset: 'dark-precision', themeBackdrop: false, look: DARK_PRECISION_LOOK } })
    clearViewportLook()
    expect(await runCall('look.get', {})).not.toHaveProperty('viewport')
  })
})
