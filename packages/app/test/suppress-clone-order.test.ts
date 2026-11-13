// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part cloned in the app after a boolean was suppressed keeps its place when the design replays. The app adds the copy
// after every part with no replay, and replay puts added parts after every part too (cad-history numbering.ts), so the
// list the person sees and the one a replay or a reopen makes are the same.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { replayHistory, type History } from '@slicerx/cad-history'
import { beforeEach, describe, expect, it } from 'vitest'
import { history } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { clonePart } from '../src/plate/parts'
import { compose } from '../src/plate/transform'
import { get, set } from '../src/state/store'

const loader = {
  loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({
    id: name, hash: name, name, triangles: 12 * parts.length, bboxMm: [10, 10, 10], openEdges: 0,
    parts: parts.map((p) => ({ name: p.name, slot: p.slot, triangles: p.indices.length / 3 })),
  }),
}
const noEngine = async (): Promise<never> => {
  throw new Error('no engine call expected')
}
const named = (name: string, slot: number, w: number): MeshPart => ({ ...boxMesh(w, 10, 10), name, slot })
const entry = () => get().plate.find((p) => p.id === 'obj')!
const names = (parts: readonly { name: string }[]) => parts.map((p) => p.name)

beforeEach(() => {
  set({ plate: [], activePlate: 'shown', plates: [{ id: 'shown', name: 'Shown', objects: [], settings: {} }], selection: null, selectedIds: [], scopePart: null, objectSettings: {}, rollback: null, historyEdit: null, dragging: false, liveEdit: false, plateLoading: false })
  history().clear()
})

describe('a clone after a suppressed boolean', () => {
  it('lands after every part, and a replay keeps it there', async () => {
    const transform = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
    // Body, Lid and Knob, with Body joined with Lid, and that union turned off
    const h: History = { version: 1, base: [named('Body', 1, 30), named('Lid', 2, 12), named('Knob', 3, 8)], steps: [{ id: 'u', part: 0, transform, params: { op: 'boolean', kind: 'union', with: [1] }, suppressed: true }] }
    const shown = await replayHistory(noEngine, { history: h })
    expect(names(shown.parts)).toEqual(['Body', 'Knob', 'Lid'])
    const parts = shown.parts as MeshPart[]
    set({ plate: [{ id: 'obj', name: 'Box', parts, handle: await loader.loadParts('Box', parts), colors: ['#111111', '#333333', '#222222'], transform, history: h }] })
    expect(await clonePart(loader, 'obj', 0)).toEqual({ index: 3, name: 'Body 2' })
    expect(names(entry().parts)).toEqual(['Body', 'Knob', 'Lid', 'Body 2'])
    const again = await replayHistory(noEngine, { history: entry().history! })
    expect(again.status.map((s) => s.state)).toEqual(['suppressed', 'done'])
    expect(names(again.parts)).toEqual(['Body', 'Knob', 'Lid', 'Body 2'])
  })
})
