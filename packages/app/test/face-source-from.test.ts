// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made a face with no key of its own, as Model's selection pill and a step's menu read it. A subtract on
// a mesh that splits a wall's side leaves each piece without a key and with the key of the side it came from (faces
// `from`): the wall's step made the pieces, and no step names them, so a reference to one still asks for repair.
import type { MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, findTriangle, keyOfTriangle, madeKeyOfTriangle, type History, type HistoryMesh, type StepParams } from '@slicerx/cad-history'
import { withStep } from '../src/cad/history/record'
import { runReplay } from '../src/cad/history/ops'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { faceSource, facesMadeBy } from '../src/cad/history/made-by'
import type { PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('face-source-from-replies')

const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
// a 30 by 2 wall 8 tall on a 40 by 20 by 5 box, then a 2 mm slot through the wall's whole height at x 90 to 92
const wall: StepParams = { op: 'shape.extrude', frame: { origin: [100, 100, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 30, heightMm: 2 }, placement: {}, spec: { distanceMm: 8, operation: 'join' } }
const slot: StepParams = { op: 'subtract', solids: [{ type: 'box', min: [90, 98, 4], max: [92, 102, 14] }], label: 'Slot' }

function slotted(): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(40, 20, 5)] as MeshPart[], transform: T }
  for (const p of [wall, slot]) e = { ...e, history: withStep(e, 0, p) }
  return e.history!
}

let h: History
let part: HistoryMesh
let entry: PlateEntry
beforeEach(async () => {
  clearReplayCache()
  h = slotted()
  const r = await runReplay({ history: h })
  expect(r.status.every((s) => s.state === 'done')).toBe(true)
  part = r.parts[0]!
  entry = { id: 'o', parts: r.parts.map((p) => ({ name: p.name, slot: p.slot, positions: new Float32Array(p.positions), indices: new Uint32Array(p.indices) })), history: h } as unknown as PlateEntry
})

// the wall's -y side either side of the slot
const pieces = () => [findTriangle(part, T, [87, 99, 9], [0, -1, 0]), findTriangle(part, T, [100, 99, 9], [0, -1, 0])]

describe('the step that made a piece of a face a subtract split', () => {
  it('is the wall step, for each piece, though neither piece has a key', async () => {
    const [left, right] = pieces()
    expect(left).toBeGreaterThanOrEqual(0)
    expect(right).toBeGreaterThanOrEqual(0)
    for (const t of [left!, right!]) {
      expect(keyOfTriangle(part, t)).toBe(0)
      expect(madeKeyOfTriangle(part, t)).toBeGreaterThan(0)
      // made by the wall's step, and used by none: a reference to a piece is repaired, never kept
      expect(await faceSource(entry, 0, t)).toEqual({ made: h.steps[0]!.id, used: [] })
    }
    // both pieces came from the one side
    expect(madeKeyOfTriangle(part, left!)).toBe(madeKeyOfTriangle(part, right!))
  })

  it("lists both pieces among the faces the wall's step made", async () => {
    const faceOf = (t: number) => part.faces!.ids[t]
    const listed = new Set((await facesMadeBy(entry, h.steps[0]!.id)).filter((f) => f.partIndex === 0).map((f) => faceOf(f.triangle)))
    for (const t of pieces()) expect(listed.has(faceOf(t))).toBe(true)
    // the slot's own walls are the slot's
    const slotWall = findTriangle(part, T, [90, 100, 9], [1, 0, 0])
    expect(slotWall).toBeGreaterThanOrEqual(0)
    expect(listed.has(faceOf(slotWall))).toBe(false)
    expect((await faceSource(entry, 0, slotWall))?.made).toBe(h.steps[1]!.id)
  })
})
