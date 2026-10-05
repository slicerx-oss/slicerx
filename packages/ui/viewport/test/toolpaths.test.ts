// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { FEATURE } from '@slicerx/contracts'
import type { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from 'three'
import { Toolpaths } from '../src/toolpaths'
import { buildPreview, type Seg } from './sxpv-fixture'

const seg = (x: number): Seg => ({ a: [x, 0], b: [x + 1, 0], feature: FEATURE.outerWall })
const preview = buildPreview([[seg(0), seg(1), seg(2)], [seg(3), seg(4)], [seg(5), seg(6), seg(7), seg(8)]])

function drawn(t: Toolpaths): { visible: boolean; count: number; offset: number } {
  const mesh = t.root.children.find((c) => (c as Mesh).isMesh && c.name !== 'nozzle') as Mesh
  const geo = mesh.geometry as InstancedBufferGeometry
  const a = geo.getAttribute('aSegA') as InterleavedBufferAttribute
  return { visible: mesh.visible, count: geo.instanceCount, offset: a.offset / 8 }
}

describe('Toolpaths ranges', () => {
  it('shows every layer after set()', () => {
    const t = new Toolpaths()
    t.set(preview)
    expect(t.visibleRange()).toEqual([0, 9])
    expect(drawn(t)).toEqual({ visible: true, count: 9, offset: 0 })
  })

  it('draws one contiguous instance range for a layer range and a move cut', () => {
    const t = new Toolpaths()
    t.set(preview)
    t.setRange(1, 2, 2)
    expect(t.visibleRange()).toEqual([3, 7])
    expect(drawn(t)).toEqual({ visible: true, count: 4, offset: 3 })
  })

  it('clamps out-of-range layers and hides an empty range', () => {
    const t = new Toolpaths()
    t.set(preview)
    t.setRange(-5, 99, null)
    expect([t.lo, t.hi]).toEqual([0, 2])
    t.setRange(2, 2, 0)
    expect(t.visibleRange()).toEqual([5, 5])
    expect(drawn(t).visible).toBe(false)
  })

  it('reports speed and flow ranges from the segments', () => {
    const t = new Toolpaths()
    t.set(buildPreview([[{ ...seg(0), speed: 40, flow: 3 }, { ...seg(1), speed: 180, flow: 9 }]]))
    const r = t.ranges()
    expect(r.speed[0]).toBeCloseTo(40)
    expect(r.speed[1]).toBeCloseTo(180)
    expect(r.flow).toEqual([3, 9])
  })
})

describe('Toolpaths pick', () => {
  const at = (x: number, y: number, z: number, feature: number = FEATURE.outerWall): Seg => ({ a: [x, y], b: [x + 10, y], feature })

  it('returns the drawn path a ray hits first, with its layer and feature', async () => {
    const { Vector3 } = await import('three')
    const layers = [[at(0, 0, 0), at(0, 5, 0, FEATURE.sparseInfill)], [at(0, 0, 0)]]
    const b = buildPreview(layers)
    const t = new Toolpaths()
    t.set(b)
    const z1 = b.layerZ[1] ?? 0
    // Straight down onto the first wall: the top layer is hit first.
    const down = new Vector3(0, 0, -1)
    const top = t.pick(new Vector3(5, 0, 50), down, 0)
    expect(top).toMatchObject({ layer: 1, feature: FEATURE.outerWall })
    expect(top!.point[2]).toBeCloseTo(z1, 3)
    expect(t.pick(new Vector3(5, 5, 50), down, 0)).toMatchObject({ layer: 0, feature: FEATURE.sparseInfill, segment: 1 })
    // Nothing between the paths; hidden layers and hidden features cannot be hit.
    expect(t.pick(new Vector3(5, 2.5, 50), down, 0)).toBeNull()
    t.setRange(0, 0, null)
    expect(t.pick(new Vector3(5, 0, 50), down, 0)).toMatchObject({ layer: 0 })
    t.setFeatureMask(0x7fff & ~(1 << FEATURE.sparseInfill))
    expect(t.pick(new Vector3(5, 5, 50), down, 0)).toBeNull()
  })
})
