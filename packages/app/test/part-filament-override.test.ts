// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that sets a part's filament (slicerx_design_part_filament) and the filament a person picks for that part on
// the plate: the most recent wins. The step clears an override picked before it; one picked after it shows until it
// is cleared or a later step sets the slot again. Undoing the step, through the tools or with the app's undo, shows
// again what showed before it. The steps call no engine, so the stand-in engine refuses every call.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { HISTORY_VERSION, IDENTITY } from '@slicerx/cad-history'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { runCall, useDesignHost } from '../src/app-link/methods'
import { setGeomProvider } from '../src/geom/client'
import { setPartSlot } from '../src/plate/object-list'
import { createHistory } from '../src/plate/history'
import { get, set, type PlateEntry } from '../src/state/store'

const tri = (x: number) => ({ positions: [x, 0, 0, x + 10, 0, 0, x, 10, 0], indices: [0, 1, 2] })
const handle = (id: string, parts: MeshPart[]): MeshHandle => ({ id, hash: id, name: id, triangles: parts.length, bboxMm: [10, 10, 0], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot })) }) as MeshHandle
const slicer = { loadParts: async (id: string, parts: MeshPart[]) => handle(id, parts) }

beforeAll(async () => {
  setGeomProvider({ call: async (op) => { throw new Error(`no engine call expected (${op})`) } })
  await useDesignHost(slicer)
})
afterAll(() => setGeomProvider(null))

function ship(overrides?: Record<string, number>): void {
  const base = [{ name: 'Hull', slot: 1, ...tri(0) }, { name: 'Funnel', slot: 1, ...tri(20) }]
  const parts: MeshPart[] = base.map((p) => ({ ...p, positions: new Float32Array(p.positions), indices: new Uint32Array(p.indices) }))
  const e: PlateEntry = { id: 'ship', name: 'Ship', handle: handle('ship', parts), parts, colors: ['#ffffff', '#ffffff'], transform: [...IDENTITY], history: { version: HISTORY_VERSION, base, steps: [] }, ...(overrides ? { slotOverrides: overrides } : {}) }
  set({ plate: [e], selection: null, selectedIds: [], historyEdit: null })
}
const entry = () => get().plate.find((p) => p.id === 'ship')!
/** The filament each part shows: the plate's own for it, else the part's. */
const shown = () => entry().parts.map((p) => [p.name, entry().slotOverrides?.[p.name] ?? p.slot])
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await runCall(name, args)) as { ok?: boolean; summary: string }
  expect(r.ok, r.summary).not.toBe(false)
  return r
}

beforeEach(() => ship())

it('clears a filament picked on the plate before the step, and puts it back when the step is undone and redone', async () => {
  ship({ Funnel: 2, Hull: 4 })
  expect(shown()).toEqual([['Hull', 4], ['Funnel', 2]])
  await call('design.part_filament', { design: 'ship', part: 1, slot: 3 })
  expect(entry().slotOverrides).toEqual({ Hull: 4 })
  expect(shown()).toEqual([['Hull', 4], ['Funnel', 3]])
  await call('design.undo', { design: 'ship' })
  expect(entry().history!.steps).toHaveLength(0)
  expect(entry().slotOverrides).toEqual({ Hull: 4, Funnel: 2 })
  expect(shown()).toEqual([['Hull', 4], ['Funnel', 2]])
  await call('design.redo', { design: 'ship' })
  expect(shown()).toEqual([['Hull', 4], ['Funnel', 3]])
})

it("shows a filament picked after the step until it is cleared or a later step sets the slot, and an undo of that step shows the pick again", async () => {
  await call('design.part_filament', { design: 'ship', part: 1, slot: 3 })
  expect(shown()).toEqual([['Hull', 1], ['Funnel', 3]])
  expect(entry().slotOverrides).toBeUndefined()
  setPartSlot('ship', 'Funnel', 5)
  expect(shown()).toEqual([['Hull', 1], ['Funnel', 5]])
  // a later step that sets the hull leaves the funnel's pick alone
  await call('design.part_filament', { design: 'ship', part: 0, slot: 6 })
  expect(shown()).toEqual([['Hull', 6], ['Funnel', 5]])
  // a later step that sets the funnel again wins over the pick
  await call('design.part_filament', { design: 'ship', part: 1, slot: 7 })
  expect(shown()).toEqual([['Hull', 6], ['Funnel', 7]])
  await call('design.undo', { design: 'ship' })
  expect(shown()).toEqual([['Hull', 6], ['Funnel', 5]])
  // the pick set back to the part's own filament drops it, and the first step's slot shows
  setPartSlot('ship', 'Funnel', 3)
  expect(entry().slotOverrides).toBeUndefined()
  expect(shown()).toEqual([['Hull', 6], ['Funnel', 3]])
})

it("puts the pick back with the app's own undo of the step, and clears it again with its redo", async () => {
  ship({ Funnel: 2 })
  const undo = createHistory()
  try {
    await call('design.part_filament', { design: 'ship', part: 1, slot: 3 })
    expect(shown()).toEqual([['Hull', 1], ['Funnel', 3]])
    expect(undo.undo()).toBe(true)
    expect(entry().history!.steps).toHaveLength(0)
    expect(shown()).toEqual([['Hull', 1], ['Funnel', 2]])
    expect(undo.redo()).toBe(true)
    expect(shown()).toEqual([['Hull', 1], ['Funnel', 3]])
  } finally {
    undo.dispose()
  }
})
