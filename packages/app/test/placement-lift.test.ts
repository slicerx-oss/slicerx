// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every route that places a design lifts one whose body would sit more than 0.01 mm under the bed onto it, as a
// design's landing and arrange do (plate/lift.ts): a new copy, the copies an array lays out, a paste, a move over the
// app link and mimir's plates. The lift joins the design's landing moves (History.placed, its third number), so a
// saved project keeps it. A new copy or paste of a locked design is placed and lifts; the locked object it copies stays
// where it is. Objects with no design history keep the height they are given everywhere, since a person can sink a
// plain model on purpose, and mimir's landing on a new printer's bed leaves such a model where it stands.
import { designFrame, HISTORY_VERSION, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { designToolset } from '@slicerx/mcp/toolset'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { move } from '../src/app-link/plate-edits'
import { applyArray } from '../src/cad/cad-ops'
import { appDesignHost } from '../src/cad/design-host'
import { toPart } from '../src/cad/history/ops'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { NO_MARGINS, setMarginSource } from '../src/plate/arrange'
import { clearClipboard, copySelection, pasteClipboard } from '../src/plate/clipboard'
import { fillBed, setInstanceCount } from '../src/plate/edit'
import { history } from '../src/plate/history'
import { startTimeline } from '../src/plate/timeline'
import { bounds } from '../src/plate/transform'
import { appStore, get, type PlateEntry } from '../src/state/store'
import { appProject } from '../src/workspaces/mimir/project'
import { landOnNewBed } from '../src/workspaces/mimir/print-run'

vi.mock('../src/state/profile-sync', async (load) => ({ ...(await load<typeof import('../src/state/profile-sync')>()), profileReady: async () => {} }))
// the array's copies come from the geometry engine: here a row of two, the second 40 mm right and 5 mm down
vi.mock('../src/geom/cad', async (load) => ({
  ...(await load<typeof import('../src/geom/cad')>()),
  arrayCopies: async (it: { transform: Mat4 }) => {
    const t = [...it.transform]
    t[12] = (t[12] ?? 0) + 40
    t[14] = (t[14] ?? 0) - 5
    return { count: 2, transforms: [[...it.transform], t], overlapping: false }
  },
}))
// the fill nests one more copy at 150, 60, at the height of the object it copies
vi.mock('../src/plate/nest', async (load) => ({
  ...(await load<typeof import('../src/plate/nest')>()),
  nestFill: async (item: { transform: Mat4 }) => {
    const t = [...item.transform]
    t[12] = 150
    t[13] = 60
    return { transforms: [t], tooLarge: [] }
  },
}))

const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
const at = (x: number, y: number, z = 0): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string) => handle(name) }

/** A closed box from `min` to `max`. */
function box(min: [number, number, number], max: [number, number, number]): HistoryMesh {
  const [a, b] = [min, max]
  const positions = [a[0], a[1], a[2], b[0], a[1], a[2], b[0], b[1], a[2], a[0], b[1], a[2], a[0], a[1], b[2], b[0], a[1], b[2], b[0], b[1], b[2], a[0], b[1], b[2]]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { name: 'Box', slot: 1, positions, indices }
}
/** A design standing at `transform`, its body `part`, with the landing moves `placed`. */
function design(id: string, part: HistoryMesh, transform: Mat4, more: Partial<PlateEntry> = {}, placed?: [number, number]): PlateEntry {
  return { id, name: id, handle: handle(id), parts: [toPart(part)], colors: ['#bd93f9'], transform, history: { version: HISTORY_VERSION, base: [part], steps: [], ...(placed ? { placed } : {}) }, ...more }
}
/** An object with no design history. */
function plain(id: string, part: HistoryMesh, transform: Mat4, more: Partial<PlateEntry> = {}): PlateEntry {
  return { id, name: id, handle: handle(id), parts: [toPart(part)], colors: ['#bd93f9'], transform, ...more }
}
/** A design built centered on z 0, so 10 mm under the bed, landed in X and Y at 60, 60 (a project saved that way opens so). */
const sunk = (id = 'sunk', more: Partial<PlateEntry> = {}) => design(id, box([-10, -10, -10], [10, 10, 10]), at(60, 60), more, [60, 60])
/** A plain model a person sank 5 mm into the bed. */
const sunkPlain = (id = 'plain', x = 150, y = 150) => plain(id, box([0, 0, -5], [20, 20, 10]), at(x, y))

const entry = (id: string): PlateEntry => get().plate.find((p) => p.id === id)!
const lowest = (e: PlateEntry) => bounds(e.parts, e.transform)!.min[2]
/** The objects on the plate that were not in `before`. */
const added = (before: readonly PlateEntry[]) => get().plate.filter((p) => !before.some((b) => b.id === p.id))
const standing = (e: PlateEntry) => ({ transform: [...e.transform], placed: e.history?.placed, locked: e.locked ?? false })

let stop: (() => void) | null = null
beforeEach(() => {
  setMarginSource(() => NO_MARGINS)
  appStore.setState({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', selection: null, selectedIds: [], historyEdit: null, timeline: { bodies: [], items: [], marker: 0 }, bed: { ...get().bed, ...BED }, printerSlots: [], toast: null })
  stop = startTimeline()
  history().clear()
  clearClipboard()
})
afterEach(() => {
  stop?.()
  stop = null
  setMarginSource(() => NO_MARGINS)
})

/** The design is on the bed, lifted `by` mm as a whole from z 0: the lift is its landing moves' third number. */
function expectLifted(e: PlateEntry | undefined, by = 10) {
  expect(e).toBeDefined()
  expect(lowest(e!)).toBeCloseTo(0, 9)
  expect(e!.transform[14]).toBeCloseTo(by, 9)
  expect(e!.history?.placed?.[2]).toBeCloseTo(by, 9)
  // the frame the design tools and the next edit read keeps its height
  expect(designFrame(e!.transform, e!.history)[14]).toBeCloseTo(0, 9)
}

describe('a new copy of a design', () => {
  it('lifts the copy onto the bed and leaves the design it copies where it stands', () => {
    appStore.setState({ plate: [sunk()] })
    const was = standing(entry('sunk'))
    const before = [...get().plate]
    expect(setInstanceCount('sunk', 2)).toBe(true)
    const [copy] = added(before)
    expectLifted(copy)
    expect(copy!.history?.placed).toEqual([60, 60, 10])
    expect(standing(entry('sunk'))).toEqual(was)
    // one undo takes the copy back
    history().undo()
    expect(get().plate.map((e) => e.id)).toEqual(['sunk'])
    expect(standing(entry('sunk'))).toEqual(was)
  })

  it('lifts a copy of a locked design, and the locked one stays put', () => {
    appStore.setState({ plate: [sunk('lk', { locked: true })] })
    const was = standing(entry('lk'))
    const before = [...get().plate]
    setInstanceCount('lk', 2)
    expectLifted(added(before)[0])
    expect(standing(entry('lk'))).toEqual(was)
    expect(lowest(entry('lk'))).toBe(-10)
  })

  it('lifts the copies a fill adds', async () => {
    appStore.setState({ plate: [sunk()] })
    const before = [...get().plate]
    expect(await fillBed('sunk')).toBe(1)
    expectLifted(added(before)[0])
    expect(added(before)[0]!.transform.slice(12, 14)).toEqual([150, 60])
  })

  it('keeps a plain model\'s copy at the height it was sunk to', async () => {
    appStore.setState({ plate: [sunkPlain()] })
    const before = [...get().plate]
    setInstanceCount('plain', 2)
    expect(lowest(added(before)[0]!)).toBe(-5)
    const more = [...get().plate]
    await fillBed('plain')
    expect(lowest(added(more)[0]!)).toBe(-5)
  })
})

describe('copies an array lays out', () => {
  it('lifts a copy the array puts under the bed', async () => {
    appStore.setState({ plate: [design('row', box([0, 0, 0], [20, 20, 20]), at(40, 40))] })
    const before = [...get().plate]
    expect(await applyArray(loader, 'row', { kind: 'linear', count: 2, step: [40, 0, -5] }, false)).toBe(2)
    const [copy] = added(before)
    // back on the bed, 5 mm up from where the array put it: the lift is its landing moves' third number, so in the
    // design's own frame the copy stays where the array laid it out
    expect(lowest(copy!)).toBeCloseTo(0, 9)
    expect(copy!.transform.slice(12, 15)).toEqual([80, 40, 0])
    expect(copy!.history?.placed).toEqual([0, 0, 5])
    expect(designFrame(copy!.transform, copy!.history)[14]).toBeCloseTo(-5, 9)
    expect(entry('row').transform).toEqual(at(40, 40))
    history().undo()
    expect(get().plate.map((e) => e.id)).toEqual(['row'])
  })

  it('keeps a plain model\'s copy where the array puts it', async () => {
    appStore.setState({ plate: [plain('rowp', box([0, 0, 0], [20, 20, 20]), at(40, 40))] })
    const before = [...get().plate]
    await applyArray(loader, 'rowp', { kind: 'linear', count: 2, step: [40, 0, -5] }, false)
    expect(lowest(added(before)[0]!)).toBe(-5)
  })

  it('leaves where the design was landed and what its landing moved with the design, not its copies', async () => {
    // the saucer's landing moved the planter over; its copies were laid out, not landed, and moved nothing
    const planter = design('planter', box([0, 0, 0], [30, 30, 40]), at(120, 40), { landedAt: [...at(120, 40)] }, [40, 0])
    const step = { id: 'saucer-1', part: 0, transform: [...at(0, 0)], params: { op: 'repair' as const } }
    const saucer: PlateEntry = {
      ...design('saucer', box([0, 0, 0], [20, 20, 5]), at(60, 60), { landedAt: [...at(60, 60)], roomMoves: { step: 'saucer-1', moves: [{ id: 'planter', from: [...at(80, 40)], to: [...at(120, 40)] }], built: [...at(60, 60)] } }),
      history: { version: HISTORY_VERSION, base: [], steps: [step] },
    }
    appStore.setState({ plate: [saucer, planter] })
    const before = [...get().plate]
    await applyArray(loader, 'saucer', { kind: 'linear', count: 2, step: [40, 0, 0] }, false)
    const [copy] = added(before)
    expect(copy).toBeDefined()
    expect(copy).not.toHaveProperty('landedAt')
    expect(copy).not.toHaveProperty('roomMoves')
    expect(entry('saucer').roomMoves?.moves.map((m) => m.id)).toEqual(['planter'])
    // undoing the copy's only step takes the copy off the plate and leaves the planter where it stands
    const was = standing(entry('planter'))
    const tools = new Map(designToolset(appDesignHost(loader), {}, {}).map((t) => [t.name, t]))
    const undo = tools.get('design.undo')!
    await undo.run(undo.input.parse({ design: copy!.id }) as never, {} as never)
    expect(get().plate.some((e) => e.id === copy!.id)).toBe(false)
    expect(standing(entry('planter'))).toEqual(was)
  })
})

describe('a paste of a design', () => {
  it('lifts the pasted copy and leaves the original where it stands, in one undo step', () => {
    appStore.setState({ plate: [sunk()], selection: 'sunk', selectedIds: ['sunk'] })
    const was = standing(entry('sunk'))
    copySelection()
    const before = [...get().plate]
    const [id] = pasteClipboard()
    expectLifted(entry(id!))
    expect(added(before).map((e) => e.id)).toEqual([id])
    expect(standing(entry('sunk'))).toEqual(was)
    history().undo()
    expect(get().plate.map((e) => e.id)).toEqual(['sunk'])
  })

  it('lifts a pasted copy of a locked design, and the locked one stays put', () => {
    appStore.setState({ plate: [sunk('lk', { locked: true })], selection: 'lk', selectedIds: ['lk'] })
    const was = standing(entry('lk'))
    copySelection()
    const [id] = pasteClipboard()
    expectLifted(entry(id!))
    expect(standing(entry('lk'))).toEqual(was)
  })

  it('keeps a pasted plain model at the height it was sunk to', () => {
    appStore.setState({ plate: [sunkPlain()], selection: 'plain', selectedIds: ['plain'] })
    copySelection()
    const [id] = pasteClipboard()
    expect(lowest(entry(id!))).toBe(-5)
  })

  it('opens a project saved after the paste with the copy on the bed, the lift in its landing moves', async () => {
    appStore.setState({ plate: [sunk()], selection: 'sunk', selectedIds: ['sunk'] })
    copySelection()
    const [id] = pasteClipboard()
    const pasted = entry(id!)
    const bed = { widthMm: 256, depthMm: 256 }
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [pasted], settings: {} }], bed, settings: {}, timeline: get().timeline })
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    const o = p.plates[0]!.objects[0]!
    expect(p.histories.get(o.fileId)!.placed).toEqual(pasted.history!.placed)
    expect(o.transform[14]).toBeCloseTo(10, 6)
  })
})

describe('project.move over the app link', () => {
  it.each([
    ['into free space', { auto: true }],
    ['to x and y', { x: 128, y: 128 }],
  ])('lifts a design moved %s, and one undo takes the move and the lift back', async (_how, where) => {
    appStore.setState({ plate: [sunk(), sunkPlain()] })
    const was = standing(entry('sunk'))
    const out = await move({ object: 'sunk', ...where }, 'Client')
    expectLifted(entry('sunk'))
    expect(out.objects[0]!.minMm![2]).toBe(0)
    expect(out.objects[0]!.transform[14]).toBe(10)
    history().undo()
    expect(standing(entry('sunk'))).toEqual(was)
  })

  it.each([
    ['into free space', { auto: true }],
    ['to x and y', { x: 60, y: 200 }],
  ])('keeps a plain model moved %s at the height it was sunk to', async (_how, where) => {
    appStore.setState({ plate: [sunk(), sunkPlain()] })
    await move({ object: 'plain', ...where }, 'Client')
    expect(lowest(entry('plain'))).toBe(-5)
  })

  it('refuses a locked design and leaves it where it stands', async () => {
    appStore.setState({ plate: [sunk('lk', { locked: true })] })
    const was = standing(entry('lk'))
    await expect(move({ object: 'lk', auto: true }, 'Client')).rejects.toThrow(/locked/)
    expect(standing(entry('lk'))).toEqual(was)
  })
})

describe('mimir\'s plates', () => {
  it('lifts a new copy of a design and leaves the design it copies where it stands', () => {
    appStore.setState({ plate: [sunk()] })
    const was = standing(entry('sunk'))
    const before = [...get().plate]
    appProject({} as never)().setPlates([{ index: 1, items: [{ objectId: 'sunk', copies: 2 }] }])
    expectLifted(added(before)[0])
    expect(standing(entry('sunk'))).toEqual(was)
    history().undo()
    expect(get().plate.map((e) => e.id)).toEqual(['sunk'])
  })

  it('lands a design off the bed and lifts it onto it', () => {
    appStore.setState({ plate: [design('off', box([-10, -10, -10], [10, 10, 10]), at(-60, 60))] })
    appProject({} as never)().setPlates([{ index: 1, items: [{ objectId: 'off', copies: 1 }] }])
    expectLifted(entry('off'))
  })

  it('keeps a plain model\'s new copy at the height it was sunk to', () => {
    appStore.setState({ plate: [sunkPlain()] })
    const before = [...get().plate]
    appProject({} as never)().setPlates([{ index: 1, items: [{ objectId: 'plain', copies: 2 }] }])
    expect(lowest(added(before)[0]!)).toBe(-5)
  })
})

describe('mimir\'s landing on a new printer\'s bed', () => {
  it('lifts a design under the bed where it stands when it prints there', () => {
    appStore.setState({ plate: [sunk(), sunkPlain()] })
    const r = landOnNewBed()
    expectLifted(entry('sunk'))
    expect(entry('sunk').transform.slice(12, 14)).toEqual([60, 60])
    expect(r.moved).toEqual([{ name: 'sunk', plate: 'Plate 1' }])
    history().undo()
    expect(entry('sunk').transform).toEqual(at(60, 60))
  })

  it('lifts a design it lands from off the bed', () => {
    appStore.setState({ plate: [design('off', box([-10, -10, -10], [10, 10, 10]), at(-60, 60))] })
    landOnNewBed()
    expectLifted(entry('off'))
  })

  it('leaves a plain model sunk on purpose fully inside the bed where it stands', () => {
    appStore.setState({ plate: [sunkPlain()] })
    const r = landOnNewBed()
    expect(entry('plain').transform).toEqual(at(150, 150))
    expect(r.moved).toEqual([])
  })

  it('lands a sunk plain model that hangs off the bed at the height it was sunk to', () => {
    appStore.setState({ plate: [sunkPlain('plain', 250, 150)] })
    landOnNewBed()
    expect(entry('plain').transform[12]).not.toBe(250)
    expect(lowest(entry('plain'))).toBe(-5)
  })

  it('leaves a locked design where it stands', () => {
    appStore.setState({ plate: [sunk('lk', { locked: true })] })
    const was = standing(entry('lk'))
    expect(landOnNewBed().moved).toEqual([])
    expect(standing(entry('lk'))).toEqual(was)
  })
})
