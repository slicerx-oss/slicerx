// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { parseBrimEars, readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { setGeomProvider } from '../src/geom/client'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { projectFiles, writeProject } from '../src/export/threemf'
import { addEar, autoGenerateEars, clearEars, defaultHeadDiameter, moveEar, removeEar, removeSelectedEars, resizeSelectedEars, selectEars, worldEars } from '../src/plate/brim-ears'
import { boxMesh } from '../src/plate/mesh-ops'
import { apply, bounds, compose, type Mat4 } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

function entry(id: string, at: [number, number, number] = [50, 60, 5]): PlateEntry {
  return { id, name: 'Box', handle: handle(id), parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: at, rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

describe('brim ears on the plate', () => {
  beforeEach(() => set({ plate: [entry('a')], selection: 'a' }))

  it('keeps the point in the object space, on the bed under the click', () => {
    expect(addEar('a', 58, 60)).toBe(true)
    const p = get().plate[0]!.brimPoints![0]!
    expect(p[0]).toBeCloseTo(8, 4)
    expect(p[1]).toBeCloseTo(0, 4)
    expect(p[2]).toBeCloseTo(-5.0001, 3)
    expect(p[3]).toBeCloseTo(defaultHeadDiameter() / 2, 4)
    expect(addEar('a', 58, 60)).toBe(false)
  })

  it('removes one ear, resizes them all, and clears', () => {
    addEar('a', 58, 60)
    addEar('a', 40, 60)
    removeEar('a', 0)
    expect(get().plate[0]!.brimPoints).toHaveLength(1)
    clearEars('a')
    expect(get().plate[0]!.brimPoints).toBeUndefined()
  })

  it('selects ears, resizes and removes only the selected ones', () => {
    addEar('a', 58, 60)
    addEar('a', 40, 60)
    addEar('a', 45, 70)
    selectEars('a', [0, 2])
    resizeSelectedEars('a', 12)
    expect(get().plate[0]!.brimPoints!.map((q) => q[3])).toEqual([6, defaultHeadDiameter() / 2, 6])
    selectEars('a', [2], 'remove')
    removeSelectedEars('a')
    expect(get().plate[0]!.brimPoints).toHaveLength(2)
    expect(get().plate[0]!.brimPoints![0]![3]).toBeCloseTo(defaultHeadDiameter() / 2, 4)
  })

  it('moves an ear to the hit point, keeping its height', () => {
    addEar('a', 58, 60)
    const z = get().plate[0]!.brimPoints![0]![2]
    moveEar('a', 0, 70, 66, false)
    moveEar('a', 0, 72, 68, true)
    const p = get().plate[0]!.brimPoints![0]!
    expect([p[0], p[1], p[2]]).toEqual([22, 8, z])
  })

  it('auto-generates ears at the corners of the first layer: four for a box, none twice', () => {
    expect(autoGenerateEars('a', { maxAngle: 125, detection: 1 })).toBe(4)
    const xs = get().plate[0]!.brimPoints!.map((q) => `${Math.round(q[0])},${Math.round(q[1])}`).sort()
    expect(xs).toEqual(['-5,-5', '-5,5', '5,-5', '5,5'])
    expect(autoGenerateEars('a', { maxAngle: 125, detection: 1 })).toBe(0)
  })

  it('flags an ear that does not reach the first layer', () => {
    addEar('a', 56, 60, 6)
    addEar('a', 90, 60, 6)
    const ears = worldEars(get().plate[0]!)
    expect(ears.map((e) => e.error)).toEqual([false, true])
  })

  it('chains ears: one that overlaps a connected ear is connected', () => {
    addEar('a', 56, 60, 6)
    addEar('a', 61, 60, 6)
    expect(worldEars(get().plate[0]!).every((e) => !e.error)).toBe(true)
  })
})

describe('brim ears in a project file', () => {
  it('are written per build item and read back unchanged', async () => {
    const a = { ...entry('o1'), brimPoints: [[1.5, 2.5, -0.1, 6], [3, 4, 0, 5.5]] as [number, number, number, number][] }
    const b = entry('o2', [150, 60, 5])
    const c = { ...entry('o3', [200, 60, 5]), brimPoints: [[0, 0, -0.0001, 8]] as [number, number, number, number][] }
    const input = { plates: [{ id: 'p1', name: 'Plate 1', objects: [a, b, c], settings: { sequence: 'by-layer' as const } }], bed, settings: {} }
    const text = String(projectFiles(input).find((f) => f.name === 'Metadata/brim_ear_points.txt')!.data)
    expect(text.split('\n')).toEqual(['brim_points_format_version=0', 'object_id=1|1.5 2.5 -0.1 6 3 4 0 5.5', 'object_id=3|0 0 -0.0001 8', ''])
    const p = await readProject(writeProject(input), bed)
    const objs = p.plates[0]!.objects
    expect(objs[0]!.brimPoints).toEqual([[1.5, 2.5, -0.1, 6], [3, 4, 0, 5.5]])
    expect(objs[1]!.brimPoints).toBeUndefined()
    expect(objs[2]!.brimPoints).toEqual([[0, 0, -0.0001, 8]])
  })

  it('drops bad numbers and absurd radii from a file', () => {
    const bytes = new TextEncoder().encode('brim_points_format_version=0\nobject_id=1|1 2 3 4 x 2 3 4 1 1 1 999 5 5 -0.1 7\nobject_id=2|junk\n')
    expect([...parseBrimEars(bytes)]).toEqual([[1, [[1, 2, 3, 4], [5, 5, -0.1, 7]]]])
  })
})

describe('brim ears in each file format', () => {
  const read = (text: string) => [...parseBrimEars(new TextEncoder().encode(text))]

  it('reads format 1 as five numbers per ear', () => {
    expect(read('brim_points_format_version=1\nobject_id=1|-13 -7 -10 4 -1 17 -7 -10 3 -1 2 -7 -8 2.5 -1\n')).toEqual([[1, [[-13, -7, -10, 4], [17, -7, -10, 3], [2, -7, -8, 2.5]]]])
  })

  it('reads format 0 and a file without a format line as four numbers per ear', () => {
    const four = [[2, [[1, 2, 3, 4], [5, 6, 7, 8]]]]
    expect(read('brim_points_format_version=0\nobject_id=2|1 2 3 4 5 6 7 8\n')).toEqual(four)
    expect(read('object_id=2|1 2 3 4 5 6 7 8\n')).toEqual(four)
  })

  it('reads no ears from a format it does not know, and says so', async () => {
    expect(read('brim_points_format_version=7\nobject_id=1|1 2 3 4 -1\n')).toEqual([])
    const files = turnedProjectFiles('brim_points_format_version=7\nobject_id=1|1 2 3 4 -1\n')
    readProjectsWithGeom(false)
    const p = await readProject(zip(files), bed)
    expect(p.plates[0]!.objects[0]!.brimPoints).toBeUndefined()
    expect(p.earsNote).toMatch(/brim ears/)
  })
})

/**
 * A project like the ones that showed the bug: flat meshes, an item turned on two axes that stands them up, components
 * that only move them, a per part matrix in the settings that disagrees with the components (it must be ignored), and
 * format 1 brim ears.
 */
function turnedProjectFiles(ears: string) {
  const box = (id: number, lo: number[], hi: number[]) => {
    const v = Array.from({ length: 8 }, (_, i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]])
    const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
    return `<object id="${id}" type="model"><mesh><vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${t.map((q) => `<triangle v1="${q[0]}" v2="${q[1]}" v3="${q[2]}"/>`).join('')}</triangles></mesh></object>`
  }
  const ns = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'
  return [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="millimeter" ${ns}><resources><object id="10" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 2 3 -10"/><component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 2 3 -12"/></components></object></resources><build><item objectid="10" transform="0.866025404 0.5 0 0 0 1 0.5 -0.866025404 0 100 80 7"/></build></model>` },
    { name: '3D/Objects/object_1.model', data: `<?xml version="1.0"?><model unit="millimeter" ${ns}><resources>${box(1, [-15, -10, -2], [15, 10, 2])}${box(2, [-5, -5, -1.5], [5, 5, 1.5])}</resources><build/></model>` },
    { name: 'Metadata/model_settings.config', data: '<?xml version="1.0"?><config><object id="10"><metadata key="name" value="turned"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="matrix" value="1 0 0 6 0 1 0 9 0 0 1 -30 0 0 0 1"/><metadata key="extruder" value="1"/></part><part id="2" subtype="normal_part"><metadata key="name" value="inlay"/><metadata key="matrix" value="1 0 0 6 0 1 0 9 0 0 1 -36 0 0 0 1"/><metadata key="extruder" value="2"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="10"/></model_instance></plate></config>' },
    { name: 'Metadata/brim_ear_points.txt', data: ears },
  ]
}

const wasm = join(__dirname, '..', '..', 'geom', 'wasm', 'pkg', 'sx_geom_core.wasm')
const engine = existsSync(wasm) ? ((await WebAssembly.instantiate(readFileSync(wasm), {})).instance.exports as unknown as GeomExports) : null

for (const reader of ['typescript', 'engine'] as const) {
  describe.skipIf(reader === 'engine' && !engine)(`a turned object with moved parts and format 1 ears, read by the ${reader} reader`, () => {
    afterAll(() => {
      setGeomProvider(null)
      readProjectsWithGeom(true)
    })
    const open = (bytes: Uint8Array) => {
      readProjectsWithGeom(reader === 'engine')
      setGeomProvider(reader === 'engine' ? { call: async <T,>(op: string, r: unknown) => callEngine(engine!, op, r) as T } : null)
      return readProject(bytes, bed)
    }
    const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 0.01)
    // Where item x component puts each part and each ear, worked out apart from the readers.
    const PARTS = [[82.7417, 80.4282, 0, 110.7224, 98.8923, 20], [90.6519, 87.5933, 5, 100.8122, 95.1913, 15]]
    const EARS = [[83.7417, 82.1603, 0, 4], [109.7224, 97.1603, 0, 3], [97.7321, 87.9282, 0, 2.5]]
    // A project without print settings is moved onto the bed as a whole, so x and y are checked from the first part.
    const check = (p: Awaited<ReturnType<typeof readProject>>) => {
      const o = p.plates[0]!.objects[0]!
      const t = o.transform as Mat4
      const first = bounds([o.parts[0]!], t)!
      const dx = first.min[0] - PARTS[0]![0]!
      const dy = first.min[1] - PARTS[0]![1]!
      const off = (v: number[], k: number) => (k % 3 === 0 ? v[k]! - dx : k % 3 === 1 ? v[k]! - dy : v[k]!)
      o.parts.forEach((part, i) => {
        const b = bounds([part], t)!
        const got = [...b.min, ...b.max].map((_, k, all) => off(all, k))
        expect(near(got, PARTS[i]!), `${part.name} ${got.join(' ')}`).toBe(true)
      })
      const ears = (o.brimPoints ?? []).map((q) => {
        const w = apply(t, [q[0], q[1], q[2]])
        return [w[0] - dx, w[1] - dy, w[2], q[3]]
      })
      expect(ears).toHaveLength(3)
      ears.forEach((e, i) => expect(near(e, EARS[i]!), e.join(' ')).toBe(true))
      return o
    }

    it('puts every part and ear where item x component puts it, and keeps them through a save', async () => {
      const first = await open(zip(turnedProjectFiles('brim_points_format_version=1\nobject_id=1|-13 -7 -10 4 -1 17 -7 -10 3 -1 2 -7 -8 2.5 -1\n')))
      const o = check(first)
      const saved = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [{ id: 'o1', name: o.name, parts: o.parts, transform: o.transform, ...(o.brimPoints ? { brimPoints: o.brimPoints } : {}) }], settings: { sequence: 'by-layer' } }], bed, settings: {} } as never)
      check(await open(saved))
    })
  })
}
