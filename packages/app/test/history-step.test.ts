// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An undo step given to the writes that belong to it (plate/history.ts newStep): nothing holds it open across an
// await, so steps that overlap or finish in any order never leave one open, and edits made meanwhile keep their own.
import { beforeEach, describe, expect, it } from 'vitest'
import { history, inStep, newStep, withLast } from '../src/plate/history'
import { identity } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const box = { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]), indices: new Uint32Array([0, 1, 2, 0, 1, 3]), name: 'Box', slot: 1 }
const entry = (id: string) => ({ id, name: id, parts: [box], transform: identity() }) as PlateEntry
/** One plate edit: an object added. */
const add = (id: string) => set((s) => ({ plate: [...s.plate, entry(id)] }))
const ids = () => get().plate.map((e) => e.id)
const undo = history()

beforeEach(() => {
  set({ plate: [], plates: [], activePlate: 'p1', selection: null, selectedIds: [], plateLoading: false, historyEdit: null, objectSettings: {}, slotSetup: {}, timeline: { items: [], bodies: [], marker: 0 }, rollback: null })
  undo.clear()
})

describe('an undo step given to its writes', () => {
  it('joins its writes into one step while nothing comes between them', () => {
    const step = newStep()
    step.write(() => add('a'))
    step.write(() => add('b'))
    expect(undo.state().undo).toBe(1)
    undo.undo()
    expect(ids()).toEqual([])
  })

  it('is never held open: an edit after a write, or between two, is a step of its own', () => {
    const step = newStep()
    step.write(() => add('a'))
    add('x')
    expect(undo.state().undo).toBe(2)
    // a later write of the step starts a new one rather than folding the edit in
    step.write(() => add('b'))
    expect(undo.state().undo).toBe(3)
    add('y')
    expect(undo.state().undo).toBe(4)
    undo.undo()
    expect(ids()).toEqual(['a', 'x', 'b'])
  })

  it('leaves nothing open when steps overlap and finish in any order', () => {
    const a = newStep()
    const b = newStep()
    a.write(() => add('a1'))
    b.write(() => add('b1'))
    // a finishes after b started, then b after a: neither leaves a step behind for later edits to join
    a.write(() => add('a2'))
    b.write(() => add('b2'))
    expect(undo.state().undo).toBe(4)
    add('x')
    add('y')
    expect(undo.state().undo).toBe(6)
    undo.undo()
    expect(ids()).toEqual(['a1', 'b1', 'a2', 'b2', 'x'])
  })

  it('runs its first change once, inside the step, just before the first write', () => {
    const seen: string[][] = []
    const step = newStep(() => {
      seen.push(ids())
      add('lead')
    })
    expect(ids()).toEqual([])
    step.write(() => add('a'))
    step.write(() => add('b'))
    expect(seen).toEqual([[]])
    expect(ids()).toEqual(['lead', 'a', 'b'])
    expect(undo.state().undo).toBe(1)
    undo.undo()
    expect(ids()).toEqual([])
  })

  it('never runs its first change when nothing is written', () => {
    let ran = false
    newStep(() => {
      ran = true
    })
    add('x')
    expect(ran).toBe(false)
    expect(undo.state().undo).toBe(1)
  })

  it('closes after a write that throws, so the next edit is its own step', () => {
    const step = newStep()
    expect(() =>
      step.write(() => {
        add('a')
        throw new Error('refused')
      }),
    ).toThrow('refused')
    add('x')
    expect(undo.state().undo).toBe(2)
  })

  it('stays its own inside another step, and what follows a write through withLast joins it', () => {
    const outer = {}
    const step = newStep()
    inStep(outer, () => add('o1'))
    inStep(outer, () => step.write(() => add('s1')))
    expect(undo.state().undo).toBe(2)
    // a projection following the body the write changed undoes with that write
    withLast(() => add('follow'))
    expect(undo.state().undo).toBe(2)
    inStep(outer, () => add('o2'))
    expect(undo.state().undo).toBe(3)
    undo.undo()
    undo.undo()
    expect(ids()).toEqual(['o1'])
  })
})
