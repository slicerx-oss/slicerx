// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition config themes the pieces at runtime: its accent and studio colors reach the 3D view, read back from the
// element, with SlicerX values wherever the config is silent or wrong.
import type { Viewport as Handle, ViewportTheme } from '@slicerx/viewport'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineSlicerXElements } from '../src/elements'
import { createTheme, subban, subbanLight } from '../src/index'
import { EmbedTheme, editionOverrides, editionTheme, resolveTheme, sceneFor } from '../src/theme'
import { Viewport } from '../src/viewport'

const themes: (ViewportTheme | undefined)[] = []

vi.mock('@slicerx/viewport', async (actual) => ({
  ...(await actual<typeof import('@slicerx/viewport')>()),
  createViewport: () =>
    new Proxy({} as Handle, {
      get: (_, key: string) => {
        if (key === 'on') return () => () => {}
        if (key === 'setTheme') return (t: ViewportTheme | undefined) => void themes.push(t)
        return () => undefined
      },
    }),
}))

// A lime partner edition, as its edition.json would hold it.
const lime = {
  brand: {
    theme: {
      base: 'subban',
      tokens: { scene: { grid: '#4a5363' } },
      dark: { visuals: { '--accent': '#b8f34a' }, scene: { top: '#1a1d23', bottom: '#0a0c10', glow: '#22262e', plate: '#2a2e37', edge: '#050608' } },
      light: { visuals: { '--accent': '#456b0b' }, scene: { top: '#f1f4ee', bottom: '#cdd6c4', grid: '#a9b89c' } },
    },
  },
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  themes.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('edition theme resolution', () => {
  it('takes the accent and studio colors for the scheme from the edition', () => {
    const dark = sceneFor(resolveTheme('dark', lime))?.scene
    expect(dark).toMatchObject({ bgTop: '#1a1d23', bgBottom: '#0a0c10', bgGlow: '#22262e', plateSide: '#2a2e37', floorGrid: '#4a5363', edgeDark: '#050608', selection: '#b8f34a' })
    const light = sceneFor(resolveTheme('light', lime))?.scene
    expect(light).toMatchObject({ bgTop: '#f1f4ee', bgBottom: '#cdd6c4', floorGrid: '#a9b89c', selection: '#456b0b' })
    // keys the light block leaves out keep SlicerX's light studio
    expect(light?.['bgGlow']).toBe(subbanLight.scene?.glow)
    expect(editionOverrides(lime, 'light')).toEqual({ visuals: { '--accent': '#456b0b' }, scene: { grid: '#a9b89c', top: '#f1f4ee', bottom: '#cdd6c4' } })
  })

  it('reads the theme block alone, and goes over a full theme the host passes', () => {
    expect(sceneFor(editionTheme(lime.brand.theme, 'dark'))?.scene?.['bgTop']).toBe('#1a1d23')
    const host = createTheme({ name: 'host', colors: { purple: '#6f9435' } })
    const over = resolveTheme(host, lime)
    expect(over.name).toBe('host')
    expect(sceneFor(over)?.scene).toMatchObject({ bgTop: '#1a1d23', selection: '#b8f34a' })
    // the palette purple still marks the selection when no accent is set
    expect(sceneFor(host)?.scene?.['selection']).toBe('#6f9435')
  })

  it('keeps SlicerX unchanged with no edition, a string theme or invalid values', () => {
    expect(resolveTheme('dark')).toBe(subban)
    expect(resolveTheme('dark', { brand: { theme: 'subban' } })).toBe(subban)
    expect(resolveTheme('light', null)).toBe(subbanLight)
    expect(sceneFor(subban)?.scene).toEqual({ selection: '#bd93f9', liveLayer: '#8be9fd' })
    const broken = { brand: { theme: { dark: { visuals: { '--accent': 'lime', '--nope': '#123456' }, scene: { top: 'green', sky: '#123456', bottom: '#0a0c10' } } } } }
    const scene = sceneFor(resolveTheme('dark', broken as never))?.scene
    expect(scene).toMatchObject({ bgTop: '#2f3241', bgBottom: '#0a0c10', selection: '#bd93f9' })
    expect(scene).not.toHaveProperty('sky')
  })
})

describe('the embedded view', () => {
  it('draws the edition studio and accent', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(() => root.render(<EmbedTheme theme="dark" edition={lime}><Viewport /></EmbedTheme>))
    expect(themes.at(-1)?.scene).toMatchObject({ bgTop: '#1a1d23', bgBottom: '#0a0c10', floorGrid: '#4a5363', selection: '#b8f34a' })
    const scope = host.querySelector<HTMLElement>('.sx-theme-scope')!
    expect(scope.style.getPropertyValue('--scene-top')).toBe('#1a1d23')
    expect(scope.style.getPropertyValue('--accent')).toBe('#b8f34a')
    await act(() => root.unmount())
  })

  it('loads edition-src at runtime and reads the theme in use back', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(lime), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    defineSlicerXElements()
    const el = document.createElement('sx-viewport') as HTMLElement & { activeTheme: { scheme: string; accent: string; scene: Record<string, string>; overrides: unknown }; edition: unknown }
    const loaded = new Promise((r) => el.addEventListener('edition', r, { once: true }))
    // before any edition: the SlicerX studio and accent
    expect(el.activeTheme.scene['bgTop']).toBe('#2f3241')
    expect(el.activeTheme.accent).toBe('#bd93f9')
    await act(async () => {
      el.setAttribute('edition-src', '/lime/edition.json')
      document.body.append(el)
      await loaded
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(el.activeTheme).toMatchObject({ scheme: 'dark', accent: '#b8f34a', scene: { bgTop: '#1a1d23', bgBottom: '#0a0c10', floorGrid: '#4a5363', originPlane: '#b8f34a', addPreview: '#b8f34a' } })
    await act(() => el.setAttribute('theme', 'light'))
    expect(el.activeTheme).toMatchObject({ scheme: 'light', accent: '#456b0b', scene: { bgTop: '#f1f4ee', originPlane: '#456b0b', addPreview: '#456b0b' } })
    // the property wins over the attribute
    await act(() => void (el.edition = { brand: { theme: { light: { scene: { top: '#ffffff' } } } } }))
    expect(el.activeTheme.scene['bgTop']).toBe('#ffffff')
    await act(() => void (el.edition = null))
    expect(el.activeTheme.scene['bgTop']).toBe('#f1f4ee')
    await act(() => el.remove())
  })

  it('reports an edition it cannot load and keeps the SlicerX look', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    defineSlicerXElements()
    const el = document.createElement('sx-viewport') as HTMLElement & { activeTheme: { accent: string } }
    const failed = new Promise<CustomEvent>((r) => el.addEventListener('error', (e) => r(e as CustomEvent), { once: true }))
    el.setAttribute('edition-src', '/missing/edition.json')
    await act(async () => {
      document.body.append(el)
      expect((await failed).detail).toMatch(/HTTP 404/)
    })
    expect(el.activeTheme.accent).toBe('#bd93f9')
    await act(() => el.remove())
  })
})
