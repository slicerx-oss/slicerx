// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Looking at the part after an earlier history step, and moving steps earlier or later.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { followsOf, type History, type HistoryMesh, type Step, type StepParams } from '../src/cad/history/model'
import { clearReplayCache } from '../src/cad/history/replay'
import { withStep } from '../src/cad/history/record'
import { allPlates } from '../src/plate/plates'
import { beginEdit, cancelEdit, movedSteps, moveStep, runReplay, viewStep } from '../src/cad/history/ops'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { appStore, get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('cad-history-order-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const base = (): HistoryMesh[] => [boxMesh(40, 20, 5)]
const topZ = (m: Pick<HistoryMesh, 'positions'>) => {
  let z = -Infinity
  for (let i = 2; i < m.positions.length; i += 3) z = Math.max(z, m.positions[i]!)
  return z
}

const pull = (distanceMm: number, z = 5): StepParams => ({ op: 'face.push', at: [100, 100, z], normal: [0, 0, 1], distanceMm })
type Extrude = Extract<StepParams, { op: 'shape.extrude' }>
const boss = (z: number): Extrude => ({ op: 'shape.extrude', frame: { origin: [100, 100, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 6 }, placement: {}, spec: { distanceMm: 4, operation: 'join' } })
const hole = (z: number): Extrude => ({ op: 'shape.extrude', frame: { origin: [100, 100, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 4 }, placement: { center: [12, 0] }, spec: { distanceMm: 3, operation: 'cut' } })

/** Pull the top 5 mm, a boss on the new top, a hole beside it. */
function bracket(): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: base() as MeshPart[], transform: T }
  for (const p of [pull(5), boss(10), hole(10)]) e = { ...e, history: withStep(e, 0, p) }
  return e.history!
}

beforeEach(async () => {
  clearReplayCache()
  const h = bracket()
  const r = await runReplay({ history: h })
  set({ plate: [{ id: 'a', name: 'Bracket', handle: handle('a'), parts: r.parts as MeshPart[], colors: ['#bd93f9'], transform: T, history: h }], selection: 'a', selectedIds: ['a'], historyEdit: null, objectTool: null })
})

describe('looking at an earlier step', () => {
  it('shows the part after the step outside undo and saves, opens no tool, and goes back', async () => {
    const undo = createHistory(appStore)
    try {
      const original = get().plate[0]!
      expect(topZ(original.parts[0]!)).toBeCloseTo(14)
      await viewStep(host, 'a', 0)
      expect(get().historyEdit).toMatchObject({ objectId: 'a', index: 0, view: true })
      expect(get().objectTool).toBeNull()
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(10)
      expect(undo.canUndo()).toBe(false)
      expect(allPlates()[0]!.objects[0]).toBe(original)
      // Another step, then editing one, replaces the view.
      await viewStep(host, 'a', 1)
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(14)
      await beginEdit(host, 'a', 2)
      expect(get().historyEdit?.view).toBeUndefined()
      cancelEdit()
      expect(get().plate[0]).toBe(original)
      // The last step is the part as it is now: nothing to roll back.
      await viewStep(host, 'a', 2)
      expect(get().historyEdit).toBeNull()
    } finally {
      undo.dispose()
    }
  })
})

describe('moving a step', () => {
  it('keeps every other step in order and lets go of a face it no longer comes after', () => {
    const s = (id: string, follow?: string): Step => ({ id, part: 0, transform: T, params: pull(1), ...(follow ? { follow: { step: follow, distanceMm: 1 } } : {}) })
    const steps = [s('a'), s('b', 'a'), s('c')]
    expect(movedSteps(steps, 2, 0).map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(followsOf(movedSteps(steps, 2, 0)[2]!).map((f) => f.step)).toEqual(['a'])
    const before = movedSteps(steps, 1, 0)
    expect(before.map((x) => x.id)).toEqual(['b', 'a', 'c'])
    expect(before[0]!.follow).toBeUndefined()
    expect(movedSteps(steps, 0, 9).map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('runs the history in the new order in one undo step', async () => {
    const undo = createHistory(appStore)
    try {
      const ids = get().plate[0]!.history!.steps.map((x) => x.id)
      const r = await moveStep(host, 'a', 2, 1)
      expect(r.status.map((x) => x.state)).toEqual(['done', 'done', 'done'])
      expect(get().plate[0]!.history!.steps.map((x) => x.id)).toEqual([ids[0], ids[2], ids[1]])
      expect(topZ(get().plate[0]!.parts[0]!)).toBeCloseTo(14)
      expect(undo.canUndo()).toBe(true)
      undo.undo()
      expect(get().plate[0]!.history!.steps.map((x) => x.id)).toEqual(ids)
    } finally {
      undo.dispose()
    }
  })
})
