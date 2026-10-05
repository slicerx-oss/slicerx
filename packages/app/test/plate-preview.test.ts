// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, PreviewBuffers, SliceResult } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { switchPlate } from '../src/plate/plates'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { forgetPlateSlices, keptSlice, trackPlateSlices } from '../src/workspaces/preview/plate-slices'
import { footprint, hull } from '../src/workspaces/preview/plate-thumb'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const at = (x: number, deg = 0) => compose({ position: [x, 50, 0], rotation: [0, 0, deg], scale: [1, 1, 1] })

function entry(id: string, extra: Partial<PlateEntry> = {}): PlateEntry {
  return { id, name: id, handle: handle(id), parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#ff79c6'], transform: at(50), ...extra }
}

describe('plate thumbnails', () => {
  it('outlines a point set with its convex hull', () => {
    const h = hull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [1, 0]])
    expect(h).toHaveLength(4)
    expect(h).toEqual(expect.arrayContaining([[0, 0], [2, 0], [2, 2], [0, 2]]))
  })

  it('draws the outline each object casts on the bed, where it stands', () => {
    const f = footprint(entry('a'))
    const xs = f.points.map((p) => p[0])
    const ys = f.points.map((p) => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 5)
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(50, 5)
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(50, 5)
    expect(f.color).toBe('#ff79c6')
    // Turned 45 degrees, the square's outline reaches its half diagonal.
    const turned = footprint(entry('b', { transform: at(50, 45) }))
    expect(Math.max(...turned.points.map((p) => p[0])) - 50).toBeCloseTo(5 * Math.SQRT2, 4)
    expect(footprint(entry('c', { printable: false })).printable).toBe(false)
  })
})

describe('switching plates in Preview', () => {
  const preview = { segmentCount: 1, layerCount: 3 } as unknown as PreviewBuffers
  const result = { id: 'r1', stats: { timeS: 1, filamentG: [1] } } as unknown as SliceResult
  let stop: () => void

  beforeEach(() => {
    forgetPlateSlices()
    stop = trackPlateSlices()
    set({
      plate: [entry('a')],
      plates: [
        { id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } },
        { id: 'p2', name: 'Plate 2', objects: [entry('b')], settings: { sequence: 'by-layer' } },
      ],
      activePlate: 'p1',
      slice: { status: 'done', result, stale: false },
      preview,
      layerHi: 2,
      layerLo: 1,
      moveCut: 0.5,
    })
  })
  afterEach(() => stop())

  it('keeps a plate slice while another plate is in view and brings it back as it was', () => {
    switchPlate('p2')
    expect(get().preview).toBeNull()
    expect(keptSlice('p1')).toEqual({ stale: false })
    switchPlate('p1')
    const s = get()
    expect(s.preview).toBe(preview)
    expect(s.slice).toMatchObject({ status: 'done', stale: false })
    expect([s.layerHi, s.layerLo, s.moveCut]).toEqual([2, 1, 0.5])
  })

  it('marks the kept slice stale when a setting it read changed meanwhile', () => {
    switchPlate('p2')
    set({ overrides: { wall_loops: 5 } })
    expect(keptSlice('p1')).toEqual({ stale: true })
    switchPlate('p1')
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
  })

  it('ends a norn comparison made on the plate left behind', () => {
    set({ norn: { pick: null, ghost: true, before: { timeS: 1, grams: 1, preview, overrides: {}, objectSettings: {} } } })
    switchPlate('p2')
    expect(get().norn).toMatchObject({ before: null, ghost: false })
  })

  it('lets go of a deleted plate', () => {
    switchPlate('p2')
    set((s) => ({ plates: s.plates.filter((p) => p.id !== 'p1') }))
    expect(keptSlice('p1')).toBeNull()
  })
})
