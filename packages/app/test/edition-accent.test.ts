// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition with its own accent leaves no SlicerX purple in the 3D view: the selection, bed outline and
// guides, the hidden outline derived from them, and the colors new objects and filament slots start with.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEditionConfig, type EditionConfig } from '@slicerx/edition-config'
import { applyTheme, clearTheme } from '@slicerx/ui'
import { resolveTheme } from '@slicerx/viewport/palette'
import { afterEach, describe, expect, it } from 'vitest'
import { brandAccent, editionTheme, NEUTRAL, objectPalette, setCurrentEdition } from '../src/edition'
import { viewportTheme } from '../src/viewport/scene-theme'

const LIME = '#b8f34a'
// Nocturne's purple and the hidden outline the viewport used to derive from it
const SLICERX_PURPLES = ['#bd93f9', '#6a58a0']

const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../edition-config/fixtures/acme/acme.json'), 'utf8'))
const lime: EditionConfig = parseEditionConfig({ ...acme, brand: { ...acme.brand, theme: { base: 'nocturne', tokens: { colors: { purple: LIME } } } } })

afterEach(() => {
  clearTheme()
  setCurrentEdition(NEUTRAL)
})

function viewportPalette(edition: EditionConfig, scheme: 'dark' | 'light') {
  setCurrentEdition(edition)
  applyTheme(editionTheme(edition, scheme))
  const resolved = resolveTheme(viewportTheme('standard'))
  return { scene: resolved.scene, toolColors: resolved.toolColors, objects: objectPalette() }
}

describe('edition accent in the viewport', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`a lime edition has no purple in the ${scheme} scene`, () => {
      const p = viewportPalette(lime, scheme)
      expect(p.scene.selection).toBe(LIME)
      const text = JSON.stringify(p).toLowerCase()
      for (const purple of SLICERX_PURPLES) expect(text).not.toContain(purple)
    })
  }

  it('the stock edition keeps its purple', () => {
    const p = viewportPalette(NEUTRAL, 'dark')
    expect(p.scene.selection).toBe('#bd93f9')
    expect(brandAccent()).toBe('#bd93f9')
  })

  it('new objects start in the accent', () => {
    setCurrentEdition(lime)
    expect(brandAccent()).toBe(LIME)
    expect(objectPalette()[0]).toBe(LIME)
  })
})
