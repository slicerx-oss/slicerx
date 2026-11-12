// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's CAD look: every part takes one neutral gray with dark feature edges, drawn even in the shaded style; Slice's
// looks keep the filament colors and their edges only in the edges style. mimir's CAD look is the same look with each
// part in its filament color.
import { describe, expect, it } from 'vitest'
import { BoxGeometry, Color, type MeshPhysicalMaterial } from 'three'
import { CAD_EDGE_ON_DARK, CAD_EDGE_PX, cadEdgesFor, cadLook, edgeLook, isCad, MaterialCache, setMaterialLook, sharedMaterials } from '../src/materials'
import { contrastRatio, displayHex, SCENE } from '../src/palette'
import { BASELINE_LOOK } from '../src/look'
import { buildObject, wideEdges } from '../src/model'

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

  it('in filament colors, draws each part in its own color with the CAD finish, one material per color', () => {
    const cache = new MaterialCache()
    const a = cache.get('cadColor', { color: '#c0392b', finish: 'silk' }) as MeshPhysicalMaterial
    const b = cache.get('cadColor', { color: '#2e86c1', finish: 'basic' }) as MeshPhysicalMaterial
    const shared = sharedMaterials().cad
    expect(a).not.toBe(b)
    expect(a).not.toBe(shared)
    // the same color is the same material, whatever the finish: the CAD look has one finish
    expect(cache.get('cadColor', { color: '#c0392b', finish: 'matte' })).toBe(a)
    expect('#' + a.color.getHexString()).toBe('#c0392b')
    expect('#' + b.color.getHexString()).toBe('#2e86c1')
    for (const m of [a, b]) {
      expect(m.roughness).toBe(shared.roughness)
      expect(m.clearcoat).toBe(shared.clearcoat)
      expect(m.envMapIntensity).toBe(shared.envMapIntensity)
      expect(m.polygonOffset).toBe(true)
    }
    // the gray look stays one material for every color
    expect(cache.get('cad', { color: '#c0392b', finish: 'basic' })).toBe(shared)
    expect(cache.get('studio', { color: '#c0392b', finish: 'basic' })).not.toBe(a)
    // both draw the CAD edges and outline
    expect(isCad('cadColor')).toBe(true)
    expect(isCad('cad')).toBe(true)
    expect(isCad('studio')).toBe(false)
    expect(edgeLook('cadColor', 'shaded')).toEqual({ edge: 'cad', visible: true })
    expect(edgeLook('cadColor', 'wireframe').visible).toBe(false)
    cache.dispose()
  })

  it('in filament colors, keeps each part on the CAD finish when a look changes it', () => {
    const cache = new MaterialCache()
    const m = cache.get('cadColor', { color: '#7d3c98', finish: 'basic' }) as MeshPhysicalMaterial
    const look = structuredClone(BASELINE_LOOK)
    look.materials.cad.roughness = 0.81
    look.materials.cad.clearcoat = 0.05
    setMaterialLook(look, '#2f3241', null)
    try {
      expect(m.roughness).toBe(0.81)
      expect(m.clearcoat).toBe(0.05)
      expect('#' + m.color.getHexString()).toBe('#7d3c98')
    } finally {
      setMaterialLook(null, '#2f3241', null)
      cache.dispose()
    }
  })

  for (const [studio, bgTop] of [['dark', '#2f3241'], ['light', '#f4f5f7']] as const) {
    it(`in filament colors, gives a near-black part light edges that show on it, and a light part the dark ones (${studio} studio)`, () => {
      setMaterialLook(null, bgTop, null)
      try {
        const sh = sharedMaterials()
        const edge = cadLook(bgTop).edge
        // a black hull: the dark edge is lost on it, so the light edge draws, thin and wide
        const black = cadEdgesFor('cadColor', '#101012')
        expect(contrastRatio(displayHex('#101012'), edge)).toBeLessThan(3)
        expect(black.light).toBe(true)
        expect(black.thin).toBe(sh.edgeCadLight)
        expect(black.wide).toBe(sh.edgeCadWideLight)
        expect('#' + black.wide.color.getHexString()).toBe(CAD_EDGE_ON_DARK)
        expect(contrastRatio(displayHex('#101012'), CAD_EDGE_ON_DARK)).toBeGreaterThanOrEqual(3)
        // a cream lamp shade keeps today's dark edge
        const cream = cadEdgesFor('cadColor', '#efe6cf')
        expect(cream.light).toBe(false)
        expect(cream.thin).toBe(sh.edgeCad)
        expect(cream.wide).toBe(sh.edgeCadWide)
        // the gray look keeps its own edge whatever the part's filament
        expect(cadEdgesFor('cad', '#101012').light).toBe(false)
        // the light edges follow the look's width and opacity
        expect(sh.edgeCadWideLight.linewidth).toBe(sh.edgeCadWide.linewidth)
        expect(sh.edgeCadLight.opacity).toBe(sh.edgeCad.opacity)
      } finally {
        setMaterialLook(null, SCENE.bgTop, null)
      }
    })
  }

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

  it('builds the wide 1.5 px edges once per part, from the same feature edges', () => {
    const box = new BoxGeometry(10, 10, 10)
    const positions = box.getAttribute('position').array as Float32Array
    const indices = new Uint32Array(box.getIndex()!.array)
    const obj = buildObject({ id: 'a', name: 'Box', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], parts: [{ name: 'Box', positions, indices, color: '#ff0000' }] } as never, () => sharedMaterials().cad, sharedMaterials().edgeCad)
    const part = obj.parts[0]!
    const mat = sharedMaterials().edgeCadWide
    const w = wideEdges(part, mat)
    expect(wideEdges(part, mat)).toBe(w)
    expect(w.parent).toBe(part.mesh)
    // one quad per feature edge segment
    const segments = part.edges.geometry.getAttribute('position').count / 2
    expect(segments).toBeGreaterThanOrEqual(12)
    expect((w.geometry as unknown as { instanceCount: number }).instanceCount).toBe(segments)
    expect(mat.linewidth).toBe(CAD_EDGE_PX)
    expect(CAD_EDGE_PX).toBe(1.5)
  })
})
