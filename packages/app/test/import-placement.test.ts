// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where an opened 3MF's objects land. A Bambu Studio part keeps its offset in its component's transform (m.3mf's at
// 128, 131 under an object at -53, 128); the object opens centered on itself, so its position reads where it is, and
// the off the bed check agrees with that position. A layout made for a larger bed moves onto the bed the plate slices
// for, and plates after the first are read by the size of the bed the project was laid out on.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bed, Host, MeshHandle, MeshPart } from '@slicerx/contracts'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { NO_MARGINS } from '../src/plate/arrange'
import { objectWarnings } from '../src/plate/object-list'
import { bounds, decompose } from '../src/plate/transform'
import { placeOnSelectedBed } from '../src/project/place-import'
import { startProjectPrinterSync } from '../src/project/project-printer'
import { markClean } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set, type PlateEntry } from '../src/state/store'

const A1_MINI_BED: Bed = { widthMm: 180, depthMm: 180, heightMm: 180 }

/** A cube of `size` mm centered on (cx, cy), resting on z0, as a mesh object. */
function cube(id: string, size: number, cx = 0, cy = 0, z0 = 0): string {
  const h = size / 2
  const v = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, size], [h, -h, size], [h, h, size], [-h, h, size]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x! + cx}" y="${y! + cy}" z="${z! + z0}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'

/** m.3mf's shape: a part offset by its component to (128, 130.81, 2), under an item turned 45 degrees at (-52.81, 127.69). */
function mLike(settings: Record<string, unknown>): ArrayBuffer {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources><object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 127.999996 130.810295 2"/></components></object></resources><build><item objectid="2" transform="0.707106781 -0.707106781 0 0.707106781 0.707106781 0 0 0 1 -52.81377 127.69162 0" printable="1"/></build></model>`
  const part = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources>${cube('1', 30, 0, 0, -2)}</resources></model>`
  return buf(zip([
    { name: '3D/3dmodel.model', data: main },
    { name: '3D/Objects/object_1.model', data: part },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) },
  ]))
}

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** The world center of an object, X and Y. */
const centerOf = (o: { parts: readonly Pick<MeshPart, 'positions'>[]; transform: number[] }): [number, number] => {
  const b = bounds(o.parts, o.transform)!
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
}

const BENCH = { printer_model: 'bench machine', printable_area: ['0x0', '256x0', '256x256', '0x256'], layer_height: '0.2' }

describe("an object whose part sits off its origin (m.3mf)", () => {
  it('opens centered on itself: its position is where it prints, unchanged', async () => {
    const o = (await readProject(new Uint8Array(mLike(BENCH)), A1_MINI_BED)).plates[0]!.objects[0]!
    // The file's part at (128, 130.81) turned 45 degrees and moved by (-52.81, 127.69) lands at (130.19, 129.68).
    const [x, y] = centerOf(o)
    expect(x).toBeCloseTo(130.19, 1)
    expect(y).toBeCloseTo(129.68, 1)
    // The position the panel shows is that place, not the item's -52.81, 127.69.
    const p = decompose(o.transform).position
    expect(p[0]).toBeCloseTo(x, 3)
    expect(p[1]).toBeCloseTo(y, 3)
    expect(decompose(o.transform).rotation[2]).toBeCloseTo(-45, 3)
    // The parts are centered on the object's origin in X and Y; heights are as the file has them.
    const local = bounds(o.parts, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])!
    expect((local.min[0] + local.max[0]) / 2).toBeCloseTo(0, 3)
    expect((local.min[1] + local.max[1]) / 2).toBeCloseTo(0, 3)
    expect(bounds(o.parts, o.transform)!.min[2]).toBeCloseTo(0, 3)
  })

  it('is on the A1 mini bed, so it has no "Off the bed" tag, and an object really off it has one', async () => {
    const o = (await readProject(new Uint8Array(mLike(BENCH)), A1_MINI_BED)).plates[0]!.objects[0]!
    const entry = (transform: number[]): PlateEntry => ({ id: 'm', name: 'm', handle: { id: 'h', hash: 'h', name: 'm', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [{ name: 'm', slot: 1, triangles: 12 }] }, parts: o.parts, colors: [], transform })
    const s = { bed: A1_MINI_BED, printerSlots: [] }
    expect(objectWarnings(entry(o.transform), s, NO_MARGINS)).toEqual([])
    const moved = [...o.transform]
    moved[12] = -52.81
    expect(objectWarnings(entry(moved), s, NO_MARGINS)).toContainEqual({ kind: 'off-bed', text: 'Off the bed' })
  })
})

describe('plates after the first', () => {
  it("sit by the size of the bed the project was laid out on, not the plate's", async () => {
    // Bambu Studio puts plate 2 of a 256 mm project 1.2 bed widths to the right: x 307.2 and on.
    const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources>${cube('1', 20)}${cube('2', 20)}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 407.2 100 0"/></build></model>`
    const cfg = '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="A"/></object><object id="2"><metadata key="name" value="B"/></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>'
    const bytes = zip([{ name: '3D/3dmodel.model', data: main }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(BENCH) }])
    const p = await readProject(bytes, A1_MINI_BED)
    expect(centerOf(p.plates[1]!.objects[0]!)[0]).toBeCloseTo(100, 3)
  })
})

describe('placing an opened plate on the selected bed', () => {
  const box = (cx: number, cy: number, size = 20): { parts: MeshPart[]; transform: number[] } => {
    const h = size / 2
    const positions = new Float32Array([-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0, -h, -h, size, h, -h, size, h, h, size, -h, h, size])
    return { parts: [{ name: 'b', slot: 1, positions, indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]) }], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, 0, 1] }
  }

  it('keeps a layout that fits', () => {
    const objects = [box(40, 40), box(140, 140)]
    expect(placeOnSelectedBed(objects, A1_MINI_BED)).toBe('kept')
    expect(objects.map(centerOf)).toEqual([[40, 40], [140, 140]])
  })

  it('moves a layout made for a larger bed onto it as a group, keeping how the objects sit to each other', () => {
    // A 256 mm project: two objects 100 mm apart, the second past the A1 mini's 180 mm edge.
    const objects = [box(120, 128), box(220, 128)]
    expect(placeOnSelectedBed(objects, A1_MINI_BED)).toBe('moved')
    const [a, b] = objects.map(centerOf)
    expect(b![0] - a![0]).toBeCloseTo(100)
    expect((a![0] + b![0]) / 2).toBeCloseTo(90)
    expect(a![1]).toBeCloseTo(90)
    for (const o of objects) expect(objectWarnings({ id: 'x', name: 'x', handle: { id: 'h', hash: 'h', name: 'x', triangles: 4, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: o.parts, colors: [], transform: o.transform }, { bed: A1_MINI_BED, printerSlots: [] }, NO_MARGINS)).toEqual([])
  })

  it('arranges a layout wider than the bed', () => {
    const objects = [box(20, 100), box(230, 100)]
    expect(placeOnSelectedBed(objects, A1_MINI_BED)).toBe('arranged')
    for (const o of objects) {
      const b = bounds(o.parts, o.transform)!
      expect(b.min[0]).toBeGreaterThanOrEqual(0)
      expect(b.max[0]).toBeLessThanOrEqual(180)
      expect(b.max[1]).toBeLessThanOrEqual(180)
    }
  })

  it('arranges objects off the bed around those already on the plate, which stay put', () => {
    const existing = [box(90, 90, 40)]
    const objects = [box(300, 90)]
    expect(placeOnSelectedBed(objects, A1_MINI_BED, existing)).toBe('arranged')
    expect(centerOf(existing[0]!)).toEqual([90, 90])
    const b = bounds(objects[0]!.parts, objects[0]!.transform)!
    expect(b.max[0]).toBeLessThanOrEqual(180)
    const e = bounds(existing[0]!.parts, existing[0]!.transform)!
    const apart = b.max[0] <= e.min[0] || b.min[0] >= e.max[0] || b.max[1] <= e.min[1] || b.min[1] >= e.max[1]
    expect(apart).toBe(true)
  })
})

describe('opening a project laid out for a larger bed', () => {
  const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host

  beforeEach(async () => {
    set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, objects: [] }], overrides: {}, projectSettings: null, projectPrinter: null, printerId: 'a1-mini', printerModel: { id: 'a1-mini', vendor: 'Bambu Lab', model: 'A1 mini' }, toast: null }))
    await profileReady()
    startProjectPrinterSync()
    markClean()
  })

  it('on a printer SlicerX has no profile for, lands on the bed in use and says so', async () => {
    expect(get().bed.widthMm).toBe(180)
    const at = (x: number) => `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources>${cube('1', 20)}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${x} 128 0"/></build></model>`
    const bytes = zip([{ name: '3D/3dmodel.model', data: at(220) }, { name: 'Metadata/project_settings.config', data: JSON.stringify(BENCH) }])
    await openModelBytes(host, 'wide.3mf', buf(bytes), undefined, { fresh: true })
    const e = get().plate[0]!
    expect(objectWarnings(e, get(), NO_MARGINS)).toEqual([])
    expect(centerOf(e)[0]).toBeCloseTo(90)
    expect(get().toast?.text).toMatch(/off this bed where the file placed them, so they were moved onto it/)
  })

  it('m.3mf keeps its place, which is on the A1 mini bed', async () => {
    await openModelBytes(host, 'm.3mf', mLike(BENCH), undefined, { fresh: true })
    const e = get().plate[0]!
    expect(objectWarnings(e, get(), NO_MARGINS)).toEqual([])
    expect(decompose(e.transform).position[0]).toBeCloseTo(130.19, 1)
    expect(get().toast?.text ?? '').not.toMatch(/moved onto it/)
  })
})
