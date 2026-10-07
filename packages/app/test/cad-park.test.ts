// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Leaving Design parks the open modeling tool with its fields and ends a history step's rollback, so Slice never
// shows or slices the part rolled back; opening Design brings both back. Parked drafts live in memory only.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { History } from '../src/cad/history/model'
import { fullPlate, get, set, setModelMode, type PlateEntry } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const begun: { objectId: string; index: number; view: boolean }[] = []
vi.mock('../src/cad/history/ops', async (load) => {
  const real = await load<typeof import('../src/cad/history/ops')>()
  const open = (view: boolean) => async (_host: unknown, objectId: string, index: number) => {
    begun.push({ objectId, index, view })
    const e = get().plate.find((p) => p.id === objectId)!
    set({ historyEdit: { objectId, index, original: e, ...(view ? { view } : {}) }, plate: get().plate.map((p) => (p.id === objectId ? { ...p, parts: [] } : p)), ...(view ? {} : { objectTool: real.toolFor(e.history!.steps[index]!.params) }) })
  }
  return { ...real, beginEdit: open(false), viewStep: open(true) }
})

const { follow, resume, useDraft, useDraftObject } = await import('../src/cad/park')

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const history: History = {
  version: 1,
  base: [],
  steps: [
    { id: 's1', part: 0, transform: I, params: { op: 'face.push', at: [0, 0, 20], normal: [0, 0, 1], distanceMm: 5 } },
    { id: 's2', part: 0, transform: I, params: { op: 'edge.fillet', edges: [], radiusMm: 2 } },
  ],
} as unknown as History
const box = (): PlateEntry => ({ id: 'a', name: 'Box', handle: handle('a'), parts: [{} as MeshPart], colors: ['#bd93f9'], transform: [...I], history }) as PlateEntry
const host = { loadParts: async (name: string) => handle(name) }

// A stand-in tool: one plain field and one pick in world coordinates.
let seen: { size: string; at: number[] | null } = { size: '', at: null }
let setSize: (v: string) => void = () => undefined
let setAt: (v: number[]) => void = () => undefined
function Tool() {
  const [size, set] = useDraft('size', '1')
  const [at, place] = useDraft<number[] | null>('at', [10, 0, 0], follow((p, now) => p && now.point(p as [number, number, number])))
  useDraftObject('a')
  seen = { size, at }
  setSize = set
  setAt = place
  return null
}

let root: Root | null = null
function mount(): void {
  const el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  act(() => root!.render(createElement(Tool)))
}
const unmount = () => {
  act(() => root?.unmount())
  root = null
}

beforeEach(() => {
  begun.length = 0
  set({ workspace: 'prepare', modelMode: 'design', plate: [box()], selection: 'a', historyEdit: null, objectTool: 'fillet', parked: null })
})
afterEach(() => {
  unmount()
  document.body.innerHTML = ''
})

describe('leaving Design', () => {
  it('parks the open tool with its fields and closes it', () => {
    mount()
    act(() => setSize('3'))
    setModelMode('slice')
    expect(get().objectTool).toBeNull()
    expect(get().parked).toMatchObject({ tool: 'fillet', objectId: 'a', fields: { size: '3', at: [10, 0, 0] } })
  })

  it('parks from any way out: another tab, or showing the slice', () => {
    mount()
    set({ workspace: 'library' })
    expect(get().parked?.tool).toBe('fillet')
  })

  it('leaves Measure and Array open, since they work in Slice too', () => {
    set({ objectTool: 'measure' })
    setModelMode('slice')
    expect(get()).toMatchObject({ objectTool: 'measure', parked: null })
  })

  it('puts a rolled back part back whole and parks the step being edited', () => {
    const whole = box()
    set({ plate: [{ ...whole, parts: [] }], historyEdit: { objectId: 'a', index: 1, original: whole }, objectTool: 'fillet' })
    mount()
    setModelMode('slice')
    expect(get().historyEdit).toBeNull()
    expect(get().plate[0]).toBe(whole)
    expect(get().parked).toMatchObject({ tool: 'fillet', historyEdit: { stepId: 's2' } })
  })

  it('also ends a step only being looked at', () => {
    const whole = box()
    set({ plate: [{ ...whole, parts: [] }], historyEdit: { objectId: 'a', index: 0, original: whole, view: true }, objectTool: null })
    setModelMode('slice')
    expect(get().plate[0]).toBe(whole)
    expect(get().parked).toMatchObject({ tool: null, historyEdit: { stepId: 's1', view: true } })
  })
})

describe('opening Design again', () => {
  function parkWith(size: string): void {
    mount()
    act(() => {
      setSize(size)
      setAt([20, 0, 0])
    })
    setModelMode('slice')
    unmount()
  }

  it('opens the tool again with its fields', async () => {
    parkWith('4')
    setModelMode('design')
    await resume(host)
    expect(get()).toMatchObject({ objectTool: 'fillet', parked: null })
    mount()
    expect(seen).toEqual({ size: '4', at: [20, 0, 0] })
  })

  it('hands the fields back once: the next tool opens fresh', async () => {
    parkWith('4')
    setModelMode('design')
    await resume(host)
    mount()
    unmount()
    mount()
    expect(seen.size).toBe('1')
  })

  it('carries world picks along when the part moved in Slice', async () => {
    parkWith('4')
    set({ plate: [{ ...get().plate[0]!, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] }] })
    setModelMode('design')
    await resume(host)
    mount()
    expect(seen).toEqual({ size: '4', at: [25, 0, 0] })
  })

  it('drops world picks when the part got a new mesh, and keeps the rest', async () => {
    parkWith('4')
    set({ plate: [{ ...get().plate[0]!, parts: [{} as MeshPart] }] })
    setModelMode('design')
    await resume(host)
    mount()
    expect(seen).toEqual({ size: '4', at: [10, 0, 0] })
  })

  it('opens the step being edited again, by its id', async () => {
    const whole = box()
    set({ plate: [{ ...whole, parts: [] }], historyEdit: { objectId: 'a', index: 1, original: whole }, objectTool: 'fillet' })
    mount()
    act(() => setSize('6'))
    setModelMode('slice')
    unmount()
    // A step moved ahead of it in the meantime: the edit follows its step, not its old place.
    set({ plate: [{ ...whole, history: { ...history, steps: [history.steps[1]!, history.steps[0]!] } }] })
    setModelMode('design')
    await resume(host)
    expect(begun).toEqual([{ objectId: 'a', index: 0, view: false }])
    mount()
    expect(seen.size).toBe('6')
  })

  it('gives way to a tool or step chosen on the way in', async () => {
    parkWith('4')
    set({ workspace: 'prepare', modelMode: 'design', objectTool: 'sketch' })
    await resume(host)
    expect(get()).toMatchObject({ objectTool: 'sketch', parked: null })
  })
})

describe('a parked draft', () => {
  it('goes with its object', () => {
    mount()
    setModelMode('slice')
    set({ plate: [] })
    expect(get().parked).toBeNull()
  })

  it('stays when other objects change', () => {
    mount()
    setModelMode('slice')
    set({ plate: [...get().plate, { ...box(), id: 'b' }] })
    expect(get().parked?.tool).toBe('fillet')
  })
})

describe('the plate a slice reads', () => {
  it('is whole while a step is open for editing, or its body hidden', () => {
    const whole = box()
    expect(fullPlate({ plate: [{ ...whole, parts: [] }], historyEdit: { objectId: 'a', index: 0, original: whole } })).toEqual([whole])
    expect(fullPlate({ plate: [], historyEdit: { objectId: 'a', index: 0, original: whole } })).toEqual([whole])
    const plate = [whole]
    expect(fullPlate({ plate, historyEdit: null })).toBe(plate)
  })
})
