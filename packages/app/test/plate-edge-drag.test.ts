// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag's app side: the move to another plate or a new one as one undo step, and the view following it there.
// The gesture itself is tested in @slicerx/viewport (test/edge-drag.test.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { follow, sendToPlate } from '../src/plate/edge-drag/commit'
import { appEdgeDrag } from '../src/plate/edge-drag/adapter'
import { createHistory } from '../src/plate/history'
import { allPlates } from '../src/plate/plates'
import { compose, identity, type Mat4 } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'


/** A 20 x 10 x 5 mm box centered on the origin. */
function entry(id: string, t: Mat4 = identity()): PlateEntry {
  const p: number[] = []
  for (const x of [-10, 10]) for (const y of [-5, 5]) for (const z of [-2.5, 2.5]) p.push(x, y, z)
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: [{ name: 'p', slot: 1, positions: new Float32Array(p), indices: new Uint32Array() }], colors: ['#bd93f9'], transform: t }
}
const at = (x: number, y: number) => compose({ position: [x, y, 2.5], rotation: [0, 0, 0], scale: [1, 1, 1] })

describe('sending parts to a plate', () => {
  beforeEach(() => {
    set({
      bed: { widthMm: 180, depthMm: 180, heightMm: 180 },
      plate: [entry('a', at(40, 40)), entry('b', at(100, 100)), entry('c', at(140, 40))],
      plates: [
        { id: 'plate-1', name: 'Plate 1', objects: [], settings: {} },
        { id: 'plate-2', name: 'Plate 2', objects: [entry('z', at(50, 50))], settings: {} },
      ],
      activePlate: 'plate-1',
      selection: 'a',
      selectedIds: ['a', 'b'],
      plateLoading: false,
      historyEdit: null,
    })
  })

  it('to a new plate: the plate and the move are one undo step, and undo brings back everything', () => {
    const h = createHistory(appStore)
    const before = { plates: get().plates, plate: get().plate, active: get().activePlate }
    const to = sendToPlate(['a', 'b'], 'new')
    expect(to).toBeTruthy()
    expect(get().plates.map((p) => p.name)).toEqual(['Plate 1', 'Plate 2', 'Plate 3'])
    expect(get().activePlate).toBe('plate-1')
    expect(allPlates().map((p) => p.objects.map((o) => o.id).sort())).toEqual([['c'], ['z'], ['a', 'b']])
    expect(h.state().undo).toBe(1)
    follow(to!, ['a', 'b'])
    // the view follows, with the parts selected; following is not an edit
    expect(get().activePlate).toBe(to)
    expect(get().selectedIds).toEqual(['a', 'b'])
    expect(get().selection).toBe('a')
    expect(h.state().undo).toBe(1)
    expect(h.undo()).toBe(true)
    expect(get().plates.map((p) => p.id)).toEqual(before.plates.map((p) => p.id))
    expect(get().activePlate).toBe(before.active)
    expect(get().plate.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(get().plate.map((p) => p.transform)).toEqual(before.plate.map((p) => p.transform))
    expect(h.canUndo()).toBe(false)
    h.dispose()
  })

  it('to another plate: arranged into its free space, one undo step', () => {
    const h = createHistory(appStore)
    expect(sendToPlate(['c'], { plateId: 'plate-2' })).toBe('plate-2')
    expect(allPlates().map((p) => p.objects.map((o) => o.id).sort())).toEqual([['a', 'b'], ['c', 'z']])
    expect(get().plates).toHaveLength(2)
    expect(h.state().undo).toBe(1)
    h.undo()
    expect(get().plate.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    h.dispose()
  })

  it('moves nothing to the shown plate, a plate that is gone, or objects not on the plate', () => {
    expect(sendToPlate(['a'], { plateId: 'plate-1' })).toBeNull()
    expect(sendToPlate(['a'], { plateId: 'nope' })).toBeNull()
    expect(sendToPlate(['zz'], 'new')).toBeNull()
    expect(get().plates).toHaveLength(2)
  })
})

describe('the app as the edge drag host', () => {
  beforeEach(() => {
    set({
      bed: { widthMm: 180, depthMm: 180, heightMm: 180 },
      plate: [entry('a', at(40, 40)), entry('b', at(100, 100))],
      plates: [
        { id: 'plate-1', name: 'Plate 1', objects: [], settings: {} },
        { id: 'plate-2', name: 'Shelf', objects: [], settings: {} },
      ],
      activePlate: 'plate-1',
      selection: 'a',
      selectedIds: ['a'],
      plateLoading: false,
      historyEdit: null,
    })
  })

  it('lists the plates by number, moves as one undo step, shows the plate after, and puts back what did not move', () => {
    let putBack = 0
    const host = appEdgeDrag(document.createElement('div'), () => putBack++)
    expect(host.plates()).toEqual([{ id: 'plate-1', label: 'Plate 1', order: 0 }, { id: 'plate-2', label: 'Plate 2', order: 1 }])
    expect(host.activePlate()).toBe('plate-1')
    expect(host.canMove?.(['a'])).toBe(true)
    expect(host.canMove?.(['prime-tower'])).toBe(false)
    const h = createHistory(appStore)
    const to = host.move(['a'], 'new')
    expect(typeof to).toBe('string')
    expect(get().plates).toHaveLength(3)
    expect(h.state().undo).toBe(1)
    host.onSwitch?.(to as string, ['a'])
    expect(get().activePlate).toBe(to)
    expect(get().selectedIds).toEqual(['a'])
    h.undo()
    expect(get().plates).toHaveLength(2)
    // a plate that is gone moves nothing, and the view is told to put the part back
    expect(host.move(['b'], { plate: 'nope' })).toBeUndefined()
    expect(putBack).toBe(1)
    // no plate picker on screen (Model on a phone): no drop target, and a toast says where the part went
    expect(host.dropTarget?.()).toBeNull()
    host.notify?.('Moved to Plate 2', 'plate-2')
    expect(get().toast).toMatchObject({ text: 'Moved to Plate 2', tone: 'ok' })
    h.dispose()
  })
})
