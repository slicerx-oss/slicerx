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

  it('knows when the layer slider or the move cut shows less than the whole print', () => {
    const t = new Toolpaths()
    expect(t.narrowed()).toBe(false)
    t.set(preview)
    expect(t.narrowed()).toBe(false)
    t.setRange(0, 1, null)
    expect(t.narrowed()).toBe(true)
    t.setRange(1, 2, null)
    expect(t.narrowed()).toBe(true)
    t.setRange(0, 2, 3)
    expect(t.narrowed()).toBe(true)
    t.setRange(0, 2, null)
    expect(t.narrowed()).toBe(false)
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

describe('Toolpaths bead size', () => {
  // An overhang wall above a bridge flow of 1 comes as a taller bead (0.459 mm wide, 0.24 mm tall at 0.2 mm layers
  // and a flow of 1.2) beside a plain outer wall (0.45 mm, 0.2 mm).
  const beads = buildPreview([
    [
      { a: [0, 0], b: [10, 0], feature: FEATURE.outerWall, widthUm: 450, heightUm: 200 },
      { a: [10, 0], b: [10, 10], feature: FEATURE.overhangWall, widthUm: 459, heightUm: 240 },
    ],
  ])

  /** Each instance's bead as the vertex shader builds it from aSegB: width, height, and bottom and top z. */
  function bead(t: Toolpaths, i: number): { width: number; height: number; bottom: number; top: number } {
    const mesh = t.root.children.find((c) => (c as Mesh).isMesh && c.name !== 'nozzle') as Mesh
    const a = (mesh.geometry as InstancedBufferGeometry).getAttribute('aSegB') as InterleavedBufferAttribute
    const words = new Uint32Array(a.data.array.buffer, a.data.array.byteOffset, a.data.array.length)
    const o = i * a.data.stride + a.offset
    const top = new Float32Array(new Uint32Array([words[o] ?? 0]).buffer)[0] ?? 0
    const wh = words[o + 1] ?? 0
    const hw = (wh & 0xffff) * 0.0005
    const hh = (wh >>> 16) * 0.0005
    return { width: 2 * hw, height: 2 * hh, bottom: top - 2 * hh, top }
  }

  it('draws a segment at its own width and height, hanging below the layer top', () => {
    const t = new Toolpaths()
    t.set(beads)
    const wall = bead(t, 0)
    const overhang = bead(t, 1)
    expect(wall.width).toBeCloseTo(0.45, 6)
    expect(wall.height).toBeCloseTo(0.2, 6)
    expect(overhang.width).toBeCloseTo(0.459, 6)
    expect(overhang.height).toBeCloseTo(0.24, 6)
    expect(overhang.top).toBeCloseTo(wall.top, 6)
    expect(overhang.bottom).toBeCloseTo(wall.top - 0.24, 6)
  })

  it('spans the width and height color ranges to the taller bead', () => {
    const t = new Toolpaths()
    t.set(beads)
    const r = t.ranges()
    expect(r.width[0]).toBeCloseTo(0.45, 6)
    expect(r.width[1]).toBeCloseTo(0.459, 6)
    expect(r.height[0]).toBeCloseTo(0.2, 6)
    expect(r.height[1]).toBeCloseTo(0.24, 6)
  })
})

describe('Toolpaths tool colors and finishes', () => {
  // The app sends the slots' colors and finishes again whenever a printer reports its slots, about once a second. Each
  // change redraws the preview, which takes seconds on software graphics, so the same colors again must not count.
  it('reports a change only when the colors or finishes differ from the ones set', () => {
    const t = new Toolpaths()
    expect(t.setToolColors(['#e07a2e', '#3e6fc0'])).toBe(true)
    expect(t.setToolColors(['#e07a2e', '#3e6fc0'])).toBe(false)
    expect(t.setToolColors(['#e07a2e', '#ffffff'])).toBe(true)
    expect(t.setToolColors([])).toBe(true)
    expect(t.setToolColors([])).toBe(false)
    expect(t.setToolFinishes(['silk', 'matte'])).toBe(true)
    expect(t.setToolFinishes(['silk', 'matte'])).toBe(false)
    expect(t.setToolFinishes(['silk'])).toBe(true)
  })
})
