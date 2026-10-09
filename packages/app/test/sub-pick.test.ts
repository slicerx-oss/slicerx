// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's pick filter and picks: a click picks a face or an edge, Shift adds, Cmd or Ctrl toggles, a miss clears;
// the filter keys work in Model only and drop picks of a kind they turn off; a tool takes the picks as it opens.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindPlateKeys } from '../src/plate/keys'
import { addPick, clearPicks, pickSub, setPickKind, takePicks } from '../src/plate/sub-pick'
import { get, set, type SubPick } from '../src/state/store'

const face = (triangle: number, objectId = 'a'): SubPick => ({ kind: 'face', objectId, partIndex: 0, triangle, point: [0, 0, 0] })
const hit = (triangle: number, o: { shift?: boolean; toggle?: boolean } = {}) => ({ objectId: 'a', partIndex: 0, triangle, point: [1, 2, 3] as [number, number, number], bed: null, ...o })
const noEdge = async () => null

beforeEach(() => set({ workspace: 'prepare', modelMode: 'design', objectTool: null, setup: null, pickFilter: ['object'], subPicks: [], selection: null, selectedIds: [] }))
afterEach(() => set({ pickFilter: ['object'], subPicks: [] }))

describe('picks', () => {
  it('replaces on a plain click, adds with Shift, toggles with Cmd or Ctrl, and keeps to one object', () => {
    expect(addPick([face(1)], face(2), {})).toEqual([face(2)])
    expect(addPick([face(1)], face(2), { shift: true })).toEqual([face(1), face(2)])
    expect(addPick([face(1), face(2)], face(2), { toggle: true })).toEqual([face(1)])
    expect(addPick([face(1, 'b')], face(2), { shift: true })).toEqual([face(2)])
  })

  it('picks a face with Faces on and selects its object; a miss clears', async () => {
    setPickKind('face', 'only')
    expect(await pickSub(hit(4), noEdge)).toBe(true)
    expect(get().subPicks.map((p) => p.triangle)).toEqual([4])
    expect(get().selection).toBe('a')
    expect(await pickSub({ objectId: null, partIndex: null, triangle: null, point: null, bed: null }, noEdge)).toBe(false)
    expect(get().subPicks).toEqual([])
  })

  it('leaves clicks to object selection with Objects only', async () => {
    expect(await pickSub(hit(4), noEdge)).toBe(false)
  })

  it('picks the edge the engine finds, and nothing when there is none', async () => {
    setPickKind('edge', 'only')
    const line = { from: [0, 0, 0] as [number, number, number], to: [1, 0, 0] as [number, number, number] }
    expect(await pickSub(hit(4), async () => [line])).toBe(true)
    expect(get().subPicks).toMatchObject([{ kind: 'edge', lines: [line] }])
    expect(await pickSub(hit(5, { shift: true }), noEdge)).toBe(true)
    expect(get().subPicks).toHaveLength(1)
  })

  it('drops the picks of a kind the filter turns off, and Esc clears picks before the object', () => {
    set({ pickFilter: ['face'], subPicks: [face(1)], selection: 'a', selectedIds: ['a'] })
    setPickKind('edge', 'toggle')
    expect(get().pickFilter).toEqual(['face', 'edge'])
    expect(get().subPicks).toHaveLength(1)
    setPickKind('object', 'only')
    expect(get().subPicks).toEqual([])
    set({ subPicks: [face(1)] })
    expect(clearPicks()).toBe(true)
    expect(get().selection).toBe('a')
    expect(clearPicks()).toBe(false)
  })

  it('gives a face tool the faces and an edge tool the edges, and clears them', () => {
    const edge: SubPick = { kind: 'edge', objectId: 'a', partIndex: 0, triangle: 9, point: [0, 0, 0], lines: [] }
    set({ subPicks: [face(1), edge] })
    expect(takePicks(true).map((p) => p.kind)).toEqual(['face'])
    expect(get().subPicks).toEqual([])
    set({ subPicks: [face(1), edge] })
    expect(takePicks(false).map((p) => p.kind)).toEqual(['edge'])
    set({ subPicks: [face(1)] })
    expect(takePicks(false).map((p) => p.kind)).toEqual(['face'])
  })
})

describe('the filter keys', () => {
  let off = () => {}
  afterEach(() => off())
  const press = (code: string, shift = false) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: code.slice(-1), code, altKey: true, shiftKey: shift, bubbles: true, cancelable: true }))

  it('Alt+2 picks faces in Model, Shift+Alt+3 adds edges, and they rest in Slice and while sketching', () => {
    off = bindPlateKeys(() => ({ id: 'slicerx' }) as never)
    press('Digit2')
    expect(get().pickFilter).toEqual(['face'])
    press('Digit3', true)
    expect(get().pickFilter).toEqual(['face', 'edge'])
    set({ modelMode: 'slice' })
    press('Digit1')
    expect(get().pickFilter).toEqual(['face', 'edge'])
    set({ modelMode: 'design', objectTool: 'sketch' })
    press('Digit1')
    expect(get().pickFilter).toEqual(['face', 'edge'])
  })
})
