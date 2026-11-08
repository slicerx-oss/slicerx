// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A modeling job reads an object, waits on the engine, then writes. What the person did meanwhile stays: a move or a
// recolor during the wait is kept, an object deleted meanwhile takes nothing, nor do others get duplicated, and a body
// hidden for an edit of its first step comes back with the result.
import { afterEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { IDENTITY, clearReplayCache, type HistoryMesh, type StepParams } from '@slicerx/cad-history'
import { applyArray, applyExtrude } from '../src/cad/cad-ops'
import { goneError } from '../src/cad/commit'
import { applyEdges } from '../src/cad/edges'
import { applyHistory, beginEdit, cancelEdit, saveEdit } from '../src/cad/history/ops'
import { applyPush } from '../src/cad/push'
import { createHistory, quietly } from '../src/plate/history'
import { applyShell } from '../src/cad/holes'
import { setGeomProvider } from '../src/geom/client'
import { cutSelected, repairSelected } from '../src/plate/geom-ops'
import { get, set, type PlateEntry } from '../src/state/store'

const mesh = (): HistoryMesh => ({ name: 'body', slot: 1, positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10], indices: [0, 1, 2, 0, 2, 3, 0, 1, 4] })
const part = (): MeshPart => ({ name: 'body', slot: 1, positions: new Float32Array(mesh().positions), indices: new Uint32Array(mesh().indices) })
const handle: MeshHandle = { id: 'h', name: 'body', hash: 'h', triangles: 3, bboxMm: [10, 10, 10], openEdges: 0, parts: [] }
const entry = (id: string): PlateEntry => ({ id, name: id, parts: [part()], handle, colors: ['#ffffff'], transform: [...IDENTITY] })
const moved = () => {
  const t = [...IDENTITY]
  t[12] = 50
  return t
}

/** A loader whose loadParts waits until `finish` is called, with `atLoad` resolving when the job reaches it. */
function gate() {
  let ready!: () => void
  let finish!: () => void
  const atLoad = new Promise<void>((r) => (ready = r))
  const loaded = new Promise<void>((r) => (finish = r))
  const host = {
    loadParts: async () => {
      ready()
      await loaded
      return handle
    },
  }
  return { host, atLoad, finish }
}

afterEach(() => {
  setGeomProvider(null)
  clearReplayCache()
  set({ plate: [], historyEdit: null, selection: null, selectedIds: [] })
})

it('a history replay that lands late keeps a newer move and recolor', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const original = entry('body')
  set({ plate: [original] })
  const g = gate()
  const task = applyHistory(g.host, original.id, { version: 1, base: [mesh()], steps: [] })
  await g.atLoad
  set({ plate: [{ ...original, transform: moved(), colors: ['#123456'], name: 'Renamed' }] })
  g.finish()
  await task
  const now = get().plate[0]!
  expect(now.transform[12]).toBe(50)
  expect(now.colors).toEqual(['#123456'])
  expect(now.name).toBe('Renamed')
  expect(now.history?.base).toHaveLength(1)
})

it('a history replay for an object deleted meanwhile writes nothing', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const a = entry('a')
  const b = entry('b')
  set({ plate: [a, b] })
  const g = gate()
  const task = applyHistory(g.host, a.id, { version: 1, base: [mesh()], steps: [] })
  await g.atLoad
  set({ plate: [b] })
  g.finish()
  await expect(task).rejects.toThrow()
  expect(get().plate.map((p) => p.id)).toEqual(['b'])
})

it('a repair that lands late keeps a newer move', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh, report: {} }) as T })
  const original = entry('body')
  set({ plate: [original], selection: original.id, selectedIds: [original.id] })
  const g = gate()
  const task = repairSelected(g.host)
  await g.atLoad
  set({ plate: [{ ...original, transform: moved() }] })
  g.finish()
  await task
  expect(get().plate[0]!.transform[12]).toBe(50)
})

it('a cut of an object deleted meanwhile changes nothing and duplicates nothing', async () => {
  const half = (z: number) => ({ positions: [0, 0, z, 10, 0, z, 0, 10, z], indices: [0, 1, 2] })
  setGeomProvider({ call: async <T>() => ({ below: half(0), above: half(5) }) as T })
  const a = entry('a')
  const b = entry('b')
  const c = entry('c')
  set({ plate: [a, b, c], selection: a.id, selectedIds: [a.id] })
  const g = gate()
  const task = cutSelected(g.host, { axis: 'z', atMm: 5, keep: 'both' })
  await g.atLoad
  set({ plate: [b, c] })
  g.finish()
  expect(await task).toBe(0)
  expect(get().plate.map((p) => p.id)).toEqual(['b', 'c'])
})

it('a cut of an object moved meanwhile changes nothing', async () => {
  const half = (z: number) => ({ positions: [0, 0, z, 10, 0, z, 0, 10, z], indices: [0, 1, 2] })
  setGeomProvider({ call: async <T>() => ({ below: half(0), above: half(5) }) as T })
  const a = entry('a')
  set({ plate: [a], selection: a.id, selectedIds: [a.id] })
  const g = gate()
  const task = cutSelected(g.host, { axis: 'z', atMm: 5, keep: 'both' })
  await g.atLoad
  set({ plate: [{ ...a, transform: moved() }] })
  g.finish()
  expect(await task).toBe(0)
  expect(get().plate.map((p) => [p.id, p.transform[12]])).toEqual([['a', 50]])
})

it('a history replay while the body is off the plate for an edit of its first step brings it back with the result', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const original = entry('body')
  const other = entry('other')
  // beginEdit of a body's first step: the body leaves the plate while its step is edited on the bed
  set({ plate: [other], historyEdit: { objectId: original.id, index: 0, original } })
  await applyHistory({ loadParts: async () => handle }, original.id, { version: 1, base: [mesh()], steps: [] })
  expect(get().historyEdit).toBeNull()
  expect(get().plate.map((p) => p.id)).toEqual(['other', 'body'])
  expect(get().plate[1]!.history?.base).toHaveLength(1)
})

it('a history replay for an object deleted meanwhile with one of its steps open writes nothing and brings nothing back', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const original = entry('body')
  const other = entry('other')
  // a later step open: the body stays on the plate, rolled back
  set({ plate: [original, other], historyEdit: { objectId: original.id, index: 1, original } })
  const g = gate()
  const task = applyHistory(g.host, original.id, { version: 1, base: [mesh()], steps: [] })
  await g.atLoad
  set({ plate: [other] })
  g.finish()
  await expect(task).rejects.toThrow()
  expect(get().plate.map((p) => p.id)).toEqual(['other'])
})

it('a history replay that lands after the body’s first step opened for editing brings the body back with the result', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh }) as T })
  const original = entry('body')
  const other = entry('other')
  set({ plate: [original, other] })
  const g = gate()
  const task = applyHistory(g.host, original.id, { version: 1, base: [mesh()], steps: [] })
  await g.atLoad
  // beginEdit of the body's first step while the replay works: the body leaves the plate
  set({ plate: [other], historyEdit: { objectId: original.id, index: 0, original, hidden: true } })
  g.finish()
  await task
  expect(get().historyEdit).toBeNull()
  expect(get().plate.map((p) => p.id).sort()).toEqual(['body', 'other'])
  expect(get().plate.find((p) => p.id === 'body')!.history?.base).toHaveLength(1)
})

it('a shell that lands while the body’s first step is open for editing says so, changes nothing and keeps the body', async () => {
  setGeomProvider({ call: async <T>(_op: string, req: unknown) => ({ mesh: (req as { mesh: unknown }).mesh, report: {}, watertight: true }) as T })
  const original = entry('body')
  set({ plate: [original] })
  const g = gate()
  const task = applyShell(g.host, original.id, 0, { op: 'shell', open: [], wallMm: 2 })
  await g.atLoad
  set({ plate: [], historyEdit: { objectId: original.id, index: 0, original, hidden: true } })
  g.finish()
  await expect(task).rejects.toThrow('The first step of body is open for editing, so nothing changed. Finish or cancel that edit, then try again.')
  expect(get().historyEdit?.original).toBe(original)
  expect(get().plate).toEqual([])
})

const EDIT = 'The first step of body is open for editing, so nothing changed. Finish or cancel that edit, then try again.'
const hide = (original: PlateEntry) => quietly(() => set((s) => ({ plate: s.plate.filter((p) => p.id !== original.id), historyEdit: { objectId: original.id, index: 0, original, hidden: true } })))
const top = { origin: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }

describe('why a write found no object', () => {
  it('names the open first-step edit only for that object while it hides it, and gives the caller’s words otherwise', () => {
    const a = entry('body')
    set({ plate: [], historyEdit: { objectId: 'body', index: 0, original: a, hidden: true } })
    expect(goneError('body').message).toBe(EDIT)
    expect(goneError('body', 'That object is gone. Pick a face again.').message).toBe(EDIT)
    expect(goneError('other').message).toBe('That object is gone.')
    set({ plate: [a], historyEdit: { objectId: 'body', index: 1, original: a } })
    expect(goneError('body').message).toBe('That object is gone.')
    set({ historyEdit: null })
    expect(goneError('body').message).toBe('That object is gone.')
    expect(goneError('body', 'That object is gone. Pick a face again.').message).toBe('That object is gone. Pick a face again.')
  })
})

describe('an edit of a body’s first step', () => {
  // a stand-in engine whose new-body extrude is the test mesh
  const engine = { call: async <T>(op: string, req: unknown) => (op === 'shape.extrude' ? { mesh: mesh(), frame: 'world', report: { touches: true, volumeChangeMm3: 1, shells: 1, watertight: true } } : { mesh: (req as { mesh: unknown }).mesh, report: {}, watertight: true }) as T }
  const extrude = (i: number): StepParams => ({ op: 'shape.extrude', frame: { ...top, origin: [0, 0, 0] }, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, placement: {}, spec: { distanceMm: 5 + i, operation: 'new' } })
  const made = (n: number): PlateEntry => ({ ...entry('body'), history: { version: 1, base: [], steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, part: 0, transform: [...IDENTITY], params: extrude(i) })) } })
  const host = { loadParts: async () => handle }

  it('takes the body off the plate and marks the edit hidden; a later step keeps it on the plate', async () => {
    setGeomProvider(engine)
    set({ plate: [made(2)] })
    await beginEdit(host, 'body', 0)
    expect(get().historyEdit).toMatchObject({ objectId: 'body', index: 0, hidden: true })
    expect(get().plate).toEqual([])
    // a mesh write refuses with the edit's reason, and a history change brings the body back with its result
    await expect(applyShell(host, 'body', 0, { op: 'shell', open: [], wallMm: 2 })).rejects.toThrow(EDIT)
    await applyHistory(host, 'body', made(1).history!)
    expect(get().historyEdit).toBeNull()
    expect(get().plate.map((p) => [p.id, p.history?.steps.length])).toEqual([['body', 1]])
    set({ plate: [made(2)] })
    await beginEdit(host, 'body', 1)
    expect(get().historyEdit).toMatchObject({ objectId: 'body', index: 1 })
    expect(get().historyEdit!.hidden).toBeUndefined()
    expect(get().plate.map((p) => p.id)).toEqual(['body'])
    cancelEdit()
  })

  it('saved, puts the body back for the replay, and a body deleted while that runs stays gone', async () => {
    setGeomProvider(engine)
    set({ plate: [made(1)] })
    await beginEdit(host, 'body', 0)
    const g = gate()
    const task = saveEdit(g.host, extrude(3))
    await g.atLoad
    set((s) => ({ plate: s.plate.filter((p) => p.id !== 'body') }))
    g.finish()
    await expect(task).rejects.toThrow()
    expect(get().plate).toEqual([])
    expect(get().historyEdit).toBeNull()
  })
})

describe('a mesh write that lands while the body’s first step is open for editing', () => {
  const pass = {
    call: async <T>(op: string, req: unknown) => {
      const r = req as { mesh: unknown }
      const m = (r.mesh as { mesh?: unknown }).mesh ?? r.mesh
      return (op === 'array.merged' ? { mesh: m, count: 2 } : op === 'face.push' ? { mesh: m, moved: { frame: top, outline: [], distanceMm: 2 } } : { mesh: m, report: {}, watertight: true }) as T
    },
  }
  const runs: [string, (host: { loadParts: () => Promise<MeshHandle> }) => Promise<unknown>][] = [
    ['shell', (h) => applyShell(h, 'body', 0, { op: 'shell', open: [], wallMm: 2 })],
    ['edge round', (h) => applyEdges(h, 'body', 0, { op: 'edge.fillet', edges: [{ a: [0, 0, 0], b: [10, 0, 0], face: [0, 0, 1] }], radiusMm: 1 })],
    ['push', (h) => applyPush(h, { objectId: 'body', partIndex: 0, pick: { at: [5, 5, 10], triangle: 0, normal: [0, 0, 1] } as never, frame: top, outline: [], thicknessMm: 10 }, 2)],
    ['array merge', (h) => applyArray(h, 'body', { kind: 'linear', count: 2, step: [20, 0, 0] }, true)],
    ['repair', (h) => repairSelected(h)],
  ]
  it.each(runs)('a %s says the edit is open, writes nothing and adds no undo step', async (_name, run) => {
    setGeomProvider(pass)
    const original = entry('body')
    set({ plate: [original], selection: 'body', selectedIds: ['body'] })
    const undo = createHistory()
    try {
      const g = gate()
      const task = run(g.host)
      await g.atLoad
      hide(original)
      g.finish()
      await expect(task).rejects.toThrow(EDIT)
      expect(get().plate).toEqual([])
      expect(get().historyEdit?.original).toBe(original)
      expect(undo.state().undo).toBe(0)
    } finally {
      undo.dispose()
    }
  })

  /** An engine that answers a join after `release`, and says when the call came. */
  const holding = (report: Record<string, unknown>) => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const called = new Promise<void>((r) => (reached = r))
    setGeomProvider({
      call: async <T>() => {
        reached()
        await held
        return { mesh: mesh(), frame: 'target', report: { shells: 1, watertight: true, ...report } } as T
      },
    })
    return { release, called }
  }
  const join = () => applyExtrude({ loadParts: async () => handle }, { frame: top, shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, placement: {}, spec: { distanceMm: 2, operation: 'join' }, target: { objectId: 'body', partIndex: 0 }, name: 'Tab' })

  it('a join whose body leaves the plate while the engine works lands nowhere, not as a new body', async () => {
    const original = entry('body')
    set({ plate: [original] })
    const e = holding({ touches: true, volumeChangeMm3: 50 })
    const task = join()
    await e.called
    hide(original)
    e.release()
    await expect(task).rejects.toThrow(EDIT)
    expect(get().plate).toEqual([])
    // deleted outright, even a miss says it is gone and adds nothing
    set({ plate: [original], historyEdit: null })
    const m = holding({ touches: false, volumeChangeMm3: 0 })
    const miss = join()
    await m.called
    set({ plate: [] })
    m.release()
    await expect(miss).rejects.toThrow('That object is gone.')
    expect(get().plate).toEqual([])
  })
})
