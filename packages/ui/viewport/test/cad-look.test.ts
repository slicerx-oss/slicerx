// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's CAD look: every part takes one neutral gray with dark feature edges, drawn even in the shaded style; Slice's
// looks keep the filament colors and their edges only in the edges style.
import { describe, expect, it } from 'vitest'
import { Color, type MeshPhysicalMaterial } from 'three'
import { cadLook, edgeLook, MaterialCache, sharedMaterials } from '../src/materials'

describe('the CAD look', () => {
  it('gives every part the one shared gray, whatever its filament', () => {
    const cache = new MaterialCache()
    const a = cache.get('cad', { color: '#ff0000', finish: 'silk' })
    const b = cache.get('cad', { color: '#00ff00', finish: 'basic' })
    expect(a).toBe(b)
    expect(a).toBe(sharedMaterials().cad)
    const c = (a as MeshPhysicalMaterial).color.clone().convertLinearToSRGB()
    // a gray: no channel far from the others
    expect(Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)).toBeLessThan(0.08)
    // Slice's studio look keeps the filament's color
    expect(cache.get('studio', { color: '#ff0000', finish: 'basic' })).not.toBe(a)
  })

  it('draws dark feature edges in every style but wireframe, and Slice only in the edges style', () => {
    expect(edgeLook('cad', 'shaded')).toEqual({ edge: 'cad', visible: true })
    expect(edgeLook('cad', 'edges')).toEqual({ edge: 'cad', visible: true })
    expect(edgeLook('cad', 'wireframe').visible).toBe(false)
    expect(edgeLook('studio', 'shaded')).toEqual({ edge: 'dark', visible: false })
    expect(edgeLook('studio', 'edges')).toEqual({ edge: 'dark', visible: true })
    expect(edgeLook('xray', 'shaded')).toEqual({ edge: 'xray', visible: true })
    const edge = sharedMaterials().edgeCad
    expect(edge.opacity).toBeGreaterThan(sharedMaterials().edgeDark.opacity)
  })

  it('is a neutral gray in a light studio and a cooler one in a dark studio, with much darker edges', () => {
    const lum = (hex: string) => {
      const c = new Color(hex)
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    }
    const light = cadLook('#f4f5f7')
    const dark = cadLook('#2f3241')
    expect(light.body).not.toBe(dark.body)
    // cooler: more blue than red
    expect(new Color(dark.body).b).toBeGreaterThan(new Color(dark.body).r)
    for (const l of [light, dark]) expect(lum(l.edge)).toBeLessThan(lum(l.body) / 4)
  })
})
