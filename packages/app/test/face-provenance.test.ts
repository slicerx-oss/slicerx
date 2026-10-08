// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made a face, found from the replays alone (cad/history/provenance.ts). With a built engine this
// pins the base keys worked out in TypeScript to the ones the engine makes.
import type { MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { faceKeyAt, type History, type HistoryMesh, type StepParams } from '../src/cad/history/model'
import { clearReplayCache } from '../src/cad/history/replay'
import { withStep } from '../src/cad/history/record'
import { runReplay } from '../src/cad/history/ops'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { baseKeys, madeBy, usedBy } from '../src/cad/history/provenance'
import { useGeomEngine } from './geom-engine'

useGeomEngine('face-provenance-replies')

const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
type Extrude = Extract<StepParams, { op: 'shape.extrude' }>
const pull: StepParams = { op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm: 5 }
const boss: Extrude = { op: 'shape.extrude', frame: { origin: [100, 100, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 6 }, placement: {}, spec: { distanceMm: 4, operation: 'join' } }
const hole: Extrude = { op: 'shape.extrude', frame: { origin: [100, 100, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 4 }, placement: { center: [12, 0] }, spec: { distanceMm: 3, operation: 'cut' } }

function bracket(): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(40, 20, 5)] as MeshPart[], transform: T }
  for (const p of [pull, boss, hole]) e = { ...e, history: withStep(e, 0, p) }
  return e.history!
}

/** The parts after each step, from replays of the history cut after it. */
async function partsAfter(h: History): Promise<HistoryMesh[][]> {
  const out: HistoryMesh[][] = []
  for (let k = 0; k < h.steps.length; k++) out.push((await runReplay({ history: { ...h, steps: h.steps.slice(0, k + 1) } })).parts)
  return out
}

let h: History
let parts: HistoryMesh[]
beforeEach(async () => {
  clearReplayCache()
  h = bracket()
  parts = (await runReplay({ history: h })).parts
})

describe('the step that made a face', () => {
  it('names the boss for its top and the hole for its floor', async () => {
    const made = madeBy(h.steps, await partsAfter(h))
    const bossTop = faceKeyAt(parts[0]!, T, [100, 100, 14], [0, 0, 1])
    const holeFloor = faceKeyAt(parts[0]!, T, [112, 100, 7], [0, 0, 1])
    expect(bossTop).toBeDefined()
    expect(holeFloor).toBeDefined()
    expect(made.get(bossTop!)).toBe(h.steps[1]!.id)
    expect(made.get(holeFloor!)).toBe(h.steps[2]!.id)
  })

  it('names the push for the top it moved, and nothing for a face the base still has', async () => {
    const made = madeBy(h.steps, await partsAfter(h))
    const top = faceKeyAt(parts[0]!, T, [90, 95, 10], [0, 0, 1])
    const bottom = faceKeyAt(parts[0]!, T, [90, 95, 0], [0, 0, -1])
    expect(top).toBeDefined()
    expect(bottom).toBeDefined()
    expect(made.get(top!)).toBe(h.steps[0]!.id)
    expect(made.has(bottom!)).toBe(false)
  })

  it('reads the base keys the way the engine makes them', async () => {
    const first = (await runReplay({ history: { ...h, steps: h.steps.slice(0, 1) } })).parts[0]!
    const bottom = faceKeyAt(first, T, [90, 95, 0], [0, 0, -1])
    expect(baseKeys(0, first.faces?.table.length ?? 0).has(bottom!)).toBe(true)
    // and only the faces the push left alone: the top it moved and its new sides are the push's own
    const top = faceKeyAt(first, T, [90, 95, 10], [0, 0, 1])
    expect(baseKeys(0, first.faces?.table.length ?? 0).has(top!)).toBe(false)
  })
})

describe('the steps that used a face', () => {
  it('reads the keys a push, a shell and a fillet saved', () => {
    const steps = [
      { id: 'p', params: { op: 'face.push', at: [0, 0, 0], normal: [0, 0, 1], distanceMm: 2, faceKey: 7 } },
      { id: 's', params: { op: 'shell', wallMm: 1.2, open: [{ key: 7 }, { key: 9 }] } },
      { id: 'f', params: { op: 'edge.fillet', radiusMm: 1, edges: [{ keys: [9, 11] }] } },
      { id: 'x', params: { op: 'repair' } },
    ] as unknown as Parameters<typeof usedBy>[0]
    const used = usedBy(steps)
    expect(used.get(7)).toEqual(['p', 's'])
    expect(used.get(9)).toEqual(['s', 'f'])
    expect(used.get(11)).toEqual(['f'])
    expect(used.size).toBe(3)
  })
})

describe('made by, on keys alone', () => {
  it('gives a key to the first step it shows after, and none to base keys', () => {
    const base = [...baseKeys(0, 2)]
    const faces = (keys: number[]) => [{ faces: { ids: [], table: keys.map(() => null), keys } }]
    const made = madeBy([{ id: 'a' }, { id: 'b' }], [faces([...base, 100]), faces([base[0]!, 100, 200])])
    expect([...made]).toEqual([[100, 'a'], [200, 'b']])
  })
})
