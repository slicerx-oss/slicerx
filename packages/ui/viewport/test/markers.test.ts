// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import type { Points, ShaderMaterial } from 'three'
import { layerOfZ, Toolpaths } from '../src/toolpaths'
import { buildPreview, type Seg } from './sxpv-fixture'

describe('layerOfZ', () => {
  const z = [0.2, 0.4, 0.6, 0.9]
  it('puts a marker on the layer it was printed in', () => {
    expect(layerOfZ(z, 0.2)).toBe(0)
    expect(layerOfZ(z, 0.4)).toBe(1)
    expect(layerOfZ(z, 0.9)).toBe(3)
  })
  it('rounds a height between layers up to the next layer top', () => {
    expect(layerOfZ(z, 0.5)).toBe(2)
  })
  it('clamps outside the stack', () => {
    expect(layerOfZ(z, 0)).toBe(0)
    expect(layerOfZ(z, 5)).toBe(3)
  })
})

describe('G-code markers', () => {
  const seg = (x: number): Seg => ({ a: [x, 0], b: [x + 1, 0], feature: FEATURE.outerWall })
  const preview = buildPreview([[seg(0), seg(1)], [seg(2), seg(3)]])
  const points = (t: Toolpaths) => t.root.children.filter((c) => (c as Points).isPoints) as Points[]

  it('draws wipes, tool changes and pauses from positions, hidden until turned on', () => {
    const t = new Toolpaths()
    t.set(preview)
    expect(t.hasMarkers()).toMatchObject({ wipes: false, toolChanges: false, pauses: false })
    t.setGcodeMarkers({ wipes: new Float32Array([1, 0, 0.2, 2, 0, 0.4]), pauses: new Float32Array([3, 0, 0.4]) })
    expect(t.hasMarkers()).toMatchObject({ wipes: true, toolChanges: false, pauses: true })
    expect(points(t).every((p) => !p.visible)).toBe(true)
    t.setMarkers({ pauses: true })
    const shown = points(t).filter((p) => p.visible)
    expect(shown).toHaveLength(1)
    // Pauses draw as squares, so they differ from the round retraction and seam markers by shape too.
    expect((shown[0]!.material as ShaderMaterial).uniforms.uShape?.value).toBe(1)
    // Each marker sits on the layer of its z.
    expect([...(shown[0]!.geometry.getAttribute('aLayer').array as Float32Array)]).toEqual([1])
  })

  it('drops them with the next preview and when a kind is cleared', () => {
    const t = new Toolpaths()
    t.set(preview)
    t.setGcodeMarkers({ toolChanges: new Float32Array([1, 0, 0.2]) })
    t.setGcodeMarkers({ toolChanges: null })
    expect(t.hasMarkers().toolChanges).toBe(false)
    t.setGcodeMarkers({ wipes: new Float32Array([1, 0, 0.2]) })
    t.set(preview)
    expect(t.hasMarkers().wipes).toBe(false)
    expect(points(t)).toHaveLength(0)
  })
})
