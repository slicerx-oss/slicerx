// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Arrange lifts a design whose body sits under the bed onto it, as a design's landing does (cad-history landing.ts):
// from an arc that dips a tenth of a millimeter under the body's lowest line to a part built centered on z 0. It is
// raised only, so a part built standing above the bed keeps its height, and a locked part stays where it is. The lift
// joins the design's landing moves (History.placed, its third number), so the design's own frame, the one its next edit
// reads, keeps its height, and a project saved after the arrange opens with the part on the bed. Runs the box packer
// (no geometry engine here), as the app does when the engine cannot run; every arrange route lands through the same
// step.
import { designFrame, HISTORY_VERSION, withBodyIds, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toPart } from '../src/cad/history/ops'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { NO_MARGINS, printsOnBed, setMarginSource } from '../src/plate/arrange'
import { arrangePlate } from '../src/plate/edit'
import { history } from '../src/plate/history'
import { objectWarnings } from '../src/plate/object-list'
import { startTimeline } from '../src/plate/timeline'
import { bounds } from '../src/plate/transform'
import { appStore, get, type PlateEntry } from '../src/state/store'

vi.mock('../src/state/profile-sync', async (load) => ({ ...(await load<typeof import('../src/state/profile-sync')>()), profileReady: async () => {} }))

const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
const at = (x: number, y: number, z = 0): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

/** A closed box from `min` to `max`, as a design's base part. */
function box(min: [number, number, number], max: [number, number, number]): HistoryMesh {
  const [a, b] = [min, max]
  const positions = [a[0], a[1], a[2], b[0], a[1], a[2], b[0], b[1], a[2], a[0], b[1], a[2], a[0], a[1], b[2], b[0], a[1], b[2], b[0], b[1], b[2], a[0], b[1], b[2]]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { name: 'Box', slot: 1, positions, indices }
}

/** A design on the plate standing at `transform`, its body `part`, with the landing moves `placed`. */
function design(id: string, part: HistoryMesh, transform: Mat4, more: Partial<PlateEntry> = {}, placed?: [number, number]): PlateEntry {
  return { id, name: id, handle: handle(id), parts: [toPart(part)], colors: ['#bd93f9'], transform, history: { version: HISTORY_VERSION, base: [part], steps: [], ...(placed ? { placed } : {}) }, ...more }
}

const entry = (id: string): PlateEntry => get().plate.find((p) => p.id === id)!
const lowest = (id: string) => bounds(entry(id).parts, entry(id).transform)!.min[2]
/** Two transforms the same, with -0 read back as 0. */
const expectAt = (t: readonly number[], want: readonly number[]) => expect(t.map((v) => v + 0)).toEqual(want.map((v) => v + 0))
const offBed = (id: string) => objectWarnings(entry(id), get(), NO_MARGINS).some((w) => w.text === 'Off the bed')

let stop: (() => void) | null = null
beforeEach(() => {
  appStore.setState({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', selection: null, selectedIds: [], historyEdit: null, timeline: { bodies: [], items: [], marker: 0 }, bed: { ...get().bed, ...BED }, printerSlots: [], toast: null })
  stop = startTimeline()
  history().clear()
})
afterEach(() => {
  stop?.()
  stop = null
  setMarginSource(() => NO_MARGINS)
})

/** The plate the cases share: each design built in its own frame, standing where the plate shows it. */
function plate(): PlateEntry[] {
  return [
    // built centered on z 0 around the origin, and moved onto the bed in X and Y as the app landed it before lifts
    design('centered', box([-10, -10, -10], [10, 10, 10]), at(60, 60), {}, [60, 60]),
    // a body whose arcs dip 0.118 mm under its lowest line
    design('dip', box([0, 0, -0.118], [30, 20, 8]), at(150, 40)),
    // built standing 5 mm above the bed
    design('above', box([0, 0, 5], [20, 20, 15]), at(40, 160)),
    // a locked part 10 mm under the bed
    design('locked', box([-10, -10, -10], [10, 10, 10]), at(200, 200), { locked: true }),
  ]
}

describe('arrange and a design under the bed', () => {
  it('lifts a dipping design onto the bed as a whole, keeps one above the bed and a locked one where they stand', async () => {
    appStore.setState({ plate: plate() })
    const frame = (id: string) => designFrame(entry(id).transform, entry(id).history)
    const before = Object.fromEntries(['centered', 'dip', 'above', 'locked'].map((id) => [id, { frame: frame(id), transform: [...entry(id).transform] }]))
    await arrangePlate('all')

    // a part built centered on z 0: lifted 10 mm, the lift its history's third landing move
    expect(lowest('centered')).toBeCloseTo(0, 9)
    expect(entry('centered').transform[14]).toBe(10)
    expect(entry('centered').history?.placed).toEqual([60, 60, 10])
    expect(printsOnBed(entry('centered'), get().bed)).toBe(true)
    expect(offBed('centered')).toBe(false)

    // the small arc dip: lifted by the dip, to the float32 the plate's parts hold
    expect(lowest('dip')).toBeCloseTo(0, 9)
    expect(entry('dip').transform[14]).toBeCloseTo(0.118, 6)
    expect(entry('dip').history?.placed?.slice(0, 2)).toEqual([0, 0])
    expect(entry('dip').history?.placed?.[2]).toBeCloseTo(0.118, 6)
    expect(offBed('dip')).toBe(false)

    // standing above the bed: arranged, its height and landing moves as they were
    expect(lowest('above')).toBe(5)
    expect(entry('above').transform[14]).toBe(0)
    expect(entry('above').history).not.toHaveProperty('placed')

    // locked: not moved and not lifted, still off the bed
    expect(entry('locked').transform).toEqual(before['locked']!.transform)
    expect(lowest('locked')).toBe(-10)
    expect(entry('locked').history).not.toHaveProperty('placed')
    expect(offBed('locked')).toBe(true)

    // the frame the design tools and the next edit read keeps its height: the lift is a landing move
    for (const id of ['centered', 'dip', 'above', 'locked']) expect(frame(id)[14]).toBeCloseTo(before[id]!.frame[14]!, 9)

    // one undo takes the arrange and the lifts back together
    history().undo()
    for (const id of ['centered', 'dip', 'above', 'locked']) expect(entry(id).transform).toEqual(before[id]!.transform)
    expect(entry('centered').history?.placed).toEqual([60, 60])
    expect(entry('dip').history).not.toHaveProperty('placed')
  })

  it('leaves a design 0.01 mm or less under the bed at the height it has', async () => {
    appStore.setState({ plate: [design('near', box([0, 0, -0.005], [20, 20, 5]), at(100, 100))] })
    await arrangePlate('all')
    expect(entry('near').transform[14]).toBe(0)
    expect(entry('near').history).not.toHaveProperty('placed')
  })

  it('leaves a design it does not arrange where it stands', async () => {
    appStore.setState({ plate: plate(), selection: 'dip', selectedIds: ['dip'] })
    await arrangePlate('selection')
    expect(entry('dip').transform[14]).toBeCloseTo(0.118, 6)
    expect(entry('centered').transform).toEqual(at(60, 60))
    expect(entry('centered').history?.placed).toEqual([60, 60])
  })
})

describe('a project saved after an arrange lifted a design', () => {
  /** `objects` and the timeline written as a project and read back by the TypeScript reader, as the app opens one. */
  async function reopen(objects: PlateEntry[]) {
    const bed = { widthMm: 256, depthMm: 256 }
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects, settings: {} }], bed, settings: {}, timeline: get().timeline })
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    const o = p.plates[0]!.objects[0]!
    return { o, history: p.histories.get(o.fileId)!, timeline: p.timeline! }
  }

  it('opens with the part on the bed where the arrange put it, the lift in its landing moves', async () => {
    appStore.setState({ plate: [design('centered', box([-10, -10, -10], [10, 10, 10]), at(60, 60), {}, [60, 60])] })
    await arrangePlate('all')
    const arranged = [...entry('centered').transform]
    expect(arranged[14]).toBe(10)
    const saved = await reopen(get().plate)
    expect(saved.history.placed).toEqual([60, 60, 10])
    expectAt(saved.o.transform, arranged)
    // opened onto an empty plate, as the app opens one: it stands where it was saved, on the bed, in the same frame
    stop?.()
    appStore.setState({ plate: [{ id: 'opened', name: saved.o.name, handle: handle('opened'), parts: saved.o.parts, colors: ['#bd93f9'], transform: saved.o.transform, history: saved.history }], timeline: withBodyIds(saved.timeline, (f) => (f === saved.o.fileId ? 'opened' : undefined)) })
    stop = startTimeline()
    expectAt(entry('opened').transform, arranged)
    expect(lowest('opened')).toBe(0)
    expect(offBed('opened')).toBe(false)
    expect(designFrame(entry('opened').transform, entry('opened').history)[14]).toBe(0)
  })
})
