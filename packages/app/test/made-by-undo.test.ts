// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The step that made a picked face, through the store as a person reaches it: a face picked on a step's result, then
// that step undone, deleted, rolled back or the plate swapped. useMadeBy never hands back a step the object's history
// no longer has, not even for the one render before it looks again, and Model's selection pill keeps working.
// The face lookup itself replays the history on the geometry engine and has its own tests (face-provenance); here it
// answers from the history it is given, so these tests run without the engine.
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { History, Step, StepParams } from '@slicerx/cad-history'
import { EditionContext, NEUTRAL } from '../src/edition'
import { HostContext } from '../src/host'
import { boxMesh } from '../src/plate/mesh-ops'
import { history } from '../src/plate/history'
import { get, set, type PlateEntry } from '../src/state/store'

// The last live step made the face, as the replay says of a face on that step's own result.
vi.mock('../src/cad/history/made-by', async (actual) => ({
  ...(await actual<object>()),
  faceSource: async (entry: PlateEntry) => {
    const last = entry.history?.steps.at(-1)
    return last ? { made: last.id, used: [] } : null
  },
}))

const { SelectPill } = await import('../src/workspaces/design/select-pill')
const { useMadeBy } = await import('../src/workspaces/design/use-made-by')

const HOST = { kind: 'web', capabilities: { secureStorage: false }, files: { save: async () => undefined } } as unknown as Host
const wrap = (el: ReturnType<typeof createElement>) => createElement(HostContext.Provider, { value: HOST }, createElement(EditionContext.Provider, { value: NEUTRAL }, el))

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const pull = (d: number): StepParams => ({ op: 'face.push', at: [100, 100, 5], normal: [0, 0, 1], distanceMm: d })
const step = (id: string, d: number): Step => ({ id, part: 0, transform: T, params: pull(d) })
const box = (steps: Step[], id = 'box'): PlateEntry => {
  const history: History = { version: 1, base: [boxMesh(40, 20, 5)], steps }
  // a new result is new parts, as a replay lands it
  return { id, name: 'Box', handle: {} as PlateEntry['handle'], parts: [boxMesh(40, 20, 5 + steps.length)] as PlateEntry['parts'], colors: ['#ffffff'], transform: T, history }
}
const face = { kind: 'face' as const, objectId: 'box', partIndex: 0, triangle: 3, point: [100, 100, 5] as [number, number, number] }

/** What useMadeBy handed back on each render, beside how many steps the object had on that render. */
let seen: { index: number | null; steps: number | null }[] = []
function Probe() {
  const made = useMadeBy()
  const entry = get().plate.find((p) => p.id === made?.objectId)
  seen.push({ index: made?.index ?? null, steps: made ? (entry?.history?.steps.length ?? null) : null })
  return null
}
/** Every answer named a step its object had when it was read. */
const allLive = () => seen.filter((s) => s.index !== null && s.index >= 0 && (s.steps === null || s.index >= s.steps))

beforeEach(() => {
  seen = []
  set({ plate: [box([step('s1', 5)])], plateLoading: false, selection: 'box', selectedIds: ['box'], subPicks: [], historyEdit: null })
  history().clear()
  // a second step, as a tool commits it: one undo step
  set({ plate: [box([step('s1', 5), step('s2', 3)])] })
  set({ subPicks: [face] })
})
afterEach(() => cleanup())

describe('the step that made a picked face, after the history changes', () => {
  it('pill: undoing the step that made the picked face keeps Model working', async () => {
    render(wrap(createElement(SelectPill)))
    expect((await screen.findByTestId('model-select-made-by')).textContent).toBe('made by Pull 3 mm')
    expect(history().canUndo()).toBe(true)
    act(() => {
      history().undo()
    })
    expect(get().plate[0]!.history!.steps.length).toBe(1)
    expect(screen.getByTestId('model-select-pill')).toBeTruthy()
    // looked again on the object as it is now
    expect((await screen.findByText('made by Pull 5 mm')).getAttribute('data-step')).toBe('0')
  })

  it('never names a step past the history after an undo', async () => {
    render(createElement(Probe))
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(1))
    act(() => {
      history().undo()
    })
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(0))
    expect(allLive()).toEqual([])
  })

  it('never names a step past the history after the step is deleted', async () => {
    render(createElement(Probe))
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(1))
    act(() => set({ plate: [box([step('s1', 5)])] }))
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(0))
    expect(allLive()).toEqual([])
  })

  it('never names a step past the history when the timeline rolls back before it', async () => {
    render(createElement(Probe))
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(1))
    // a rolled back body shows itself as its history up to the marker
    act(() => set({ plate: [box([step('s1', 5)])] }))
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(0))
    expect(allLive()).toEqual([])
  })

  it('names nothing once the object is off the plate, as after a plate swap', async () => {
    render(createElement(Probe))
    await vi.waitFor(() => expect(seen.at(-1)?.index).toBe(1))
    seen = []
    act(() => set({ plate: [box([step('t1', 2)], 'other')] }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.index === null)).toBe(true)
  })
})
