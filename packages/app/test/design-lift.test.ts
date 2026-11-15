// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design body under the bed is lifted onto it when the plate lands it: from an arc that dips a tenth of a millimeter
// under the body's lowest line to a part built centered on z 0, raised only, so a part built standing above the bed
// stays where it is. The lift is a landing move like the move onto the bed, kept in the design's history
// (History.placed, its third number), so the design's own coordinates stay the ones it was built in, and a saved
// project keeps it. Opening a project lands nothing: a part saved under the bed opens where it was saved, still off the
// bed in the object list, and its first edit lifts it. The bodies are boxes given as base parts and the edit adds a
// part, so no step here asks the geometry engine.
import { HISTORY_VERSION, withBodyIds, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { toPart } from '../src/cad/history/ops'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { NO_MARGINS, printsOnBed, setMarginSource } from '../src/plate/arrange'
import { objectWarnings } from '../src/plate/object-list'
import { startTimeline } from '../src/plate/timeline'
import { bounds } from '../src/plate/transform'
import { appStore, get, type PlateEntry } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

const engine = useGeomEngine('design-lift-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
const at = (x: number, y: number, z = 0): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

/** A closed box from `min` to `max`, as a design's base part. */
function box(min: [number, number, number], max: [number, number, number]): HistoryMesh {
  const [a, b] = [min, max]
  const positions = [a[0], a[1], a[2], b[0], a[1], a[2], b[0], b[1], a[2], a[0], b[1], a[2], a[0], a[1], b[2], b[0], a[1], b[2], b[0], b[1], b[2], a[0], b[1], b[2]]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { name: 'Box', slot: 1, positions, indices }
}

const entry = (id: string): PlateEntry => get().plate.find((p) => p.id === id)!
const lowest = (id: string) => bounds(entry(id).parts, entry(id).transform)!.min[2]
const offBed = (id: string) => objectWarnings(entry(id), get(), NO_MARGINS).some((w) => w.text === 'Off the bed')

let stop: (() => void) | null = null
beforeEach(() => {
  appStore.setState({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', selection: null, selectedIds: [], historyEdit: null, timeline: { bodies: [], items: [], marker: 0 }, bed: { ...get().bed, ...BED }, printerSlots: [] })
  stop = startTimeline()
})
afterEach(() => {
  stop?.()
  stop = null
  setMarginSource(() => NO_MARGINS)
})

describe('a new design body under the bed', () => {
  it.each<[string, HistoryMesh, { dxMm: number; dyMm: number; dzMm: number }]>([
    ['a part built centered on z 0, 10 mm under the bed, around the origin', box([-60, -10, -10], [60, 10, 10]), { dxMm: 128, dyMm: 128, dzMm: 10 }],
    ['a part built 28 mm under the bed, around the origin', box([-40, -30, -28], [40, 30, 15]), { dxMm: 128, dyMm: 128, dzMm: 28 }],
    ['a part built centered on z 0 on the middle of the bed', box([98, 118, -10], [158, 138, 10]), { dxMm: 0, dyMm: 0, dzMm: 10 }],
    ['a body whose arcs dip 0.118 mm under its lowest line', box([100, 100, -0.118], [140, 130, 8]), { dxMm: 0, dyMm: 0, dzMm: 0.12 }],
  ])('lifts %s onto the bed as a whole, and keeps the design in its own frame', async (_what, part, landed) => {
    const host = appDesignHost(loader)
    const d = await host.create('Body', [part])
    expect(d.landed).toEqual(landed)
    expect(lowest(d.id)).toBeCloseTo(0, 9)
    expect(printsOnBed(entry(d.id), get().bed)).toBe(true)
    expect(offBed(d.id)).toBe(false)
    // the lift to the float32 the plate's parts hold
    const placed = entry(d.id).history?.placed
    expect(placed?.slice(0, 2)).toEqual([landed.dxMm, landed.dyMm])
    expect(placed?.[2]).toBeCloseTo(-Math.min(...Array.from(part.positions).filter((_, i) => i % 3 === 2)), 6)
    // the design's coordinates stay the ones it was built in, to the float noise of the kept lift
    host.get(d.id).transform.forEach((v, i) => expect(v).toBeCloseTo(at(0, 0, 0)[i]!, 6))
  })

  it('leaves a part 0.01 mm or less under the bed, and one built standing above it, where they were built', async () => {
    const host = appDesignHost(loader)
    const near = await host.create('Near', [box([100, 100, -0.005], [120, 120, 5])])
    const above = await host.create('Above', [box([140, 140, 5], [160, 160, 15])])
    for (const d of [near, above]) {
      expect(d.landed).toBeUndefined()
      expect(entry(d.id).transform).toEqual(at(0, 0, 0))
      expect(entry(d.id).history).not.toHaveProperty('placed')
    }
    expect(lowest(above.id)).toBe(5)
    expect(engine.ops()).toEqual([])
  })
})

describe('a project saved with a part under the bed', () => {
  /** `objects` and the timeline written as a project and read back by the TypeScript reader, as the app opens one. */
  async function reopen(objects: PlateEntry[]) {
    const bed = { widthMm: 256, depthMm: 256 }
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects, settings: {} }], bed, settings: {}, timeline: get().timeline })
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    const o = p.plates[0]!.objects[0]!
    return { o, history: p.histories.get(o.fileId)!, timeline: p.timeline! }
  }
  /** Opens a project read back onto an empty plate, as the app opens one, as object `id`. */
  function open(r: Awaited<ReturnType<typeof reopen>>, id: string) {
    stop?.()
    appStore.setState({ plate: [{ id, name: r.o.name, handle: handle(id), parts: r.o.parts, colors: ['#bd93f9'], transform: r.o.transform, history: r.history }], timeline: withBodyIds(r.timeline, (f) => (f === r.o.fileId ? id : undefined)) })
    stop = startTimeline()
  }

  it('opens it where it was saved, off the bed, lifts it at its first edit, and saves the lift', async () => {
    // a part built centered on z 0 around the origin and moved onto the bed in X and Y, as the app landed it before
    // lifts: two numbers of landing moves, the part still 10 mm under the bed
    const part = box([-10, -10, -10], [10, 10, 10])
    appStore.setState({ plate: [{ id: 'old', name: 'Handle', handle: handle('old'), parts: [toPart(part)], colors: ['#bd93f9'], transform: at(128, 128), history: { version: HISTORY_VERSION, base: [part], steps: [], placed: [128, 128] } }] })
    const saved = await reopen(get().plate)
    expect(saved.history.placed).toEqual([128, 128])
    open(saved, 'opened')
    // opening lands nothing: the part stands as saved, and the object list says it is off the bed
    expect(entry('opened').transform).toEqual(at(128, 128))
    expect(lowest('opened')).toBe(-10)
    expect(offBed('opened')).toBe(true)
    expect(printsOnBed(entry('opened'), get().bed)).toBe(false)
    const host = appDesignHost(loader)
    expect(host.get('opened').transform).toEqual(at(0, 0, 0))
    // its first edit lifts it onto the bed, in the same frame
    const d = host.get('opened')
    await host.add(d, -1, { op: 'parts.add', label: 'Add part', parts: [box([-2, -2, 10], [2, 2, 14])] })
    expect(d.landed).toEqual({ dxMm: 0, dyMm: 0, dzMm: 10, edit: true })
    expect(entry('opened').transform).toEqual(at(128, 128, 10))
    expect(lowest('opened')).toBe(0)
    expect(offBed('opened')).toBe(false)
    expect(entry('opened').history?.placed).toEqual([128, 128, 10])
    expect(host.get('opened').transform).toEqual(at(0, 0, 0))
    // a project saved now keeps the lift, and opens with it
    const again = await reopen(get().plate)
    expect(again.history.placed).toEqual([128, 128, 10])
    expect(again.o.transform).toEqual(at(128, 128, 10))
    expect(engine.ops()).toEqual([])
  })
})
