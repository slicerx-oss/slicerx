// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An object's own settings in a 3MF project (object metadata in Metadata/model_settings.config) open as that
// object's settings, as the object settings panel sets them, and go to the engine with it. A part's own
// settings stay on the part, and the other object prints with the plate's.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { platesState } from '../src/app-link/plate-state'
import { modifierSettings } from '../src/export/project-settings'
import { projectOf, readProject, readProjectsWithGeom, scanProjectFile } from '../src/export/import3mf'
import { setGeomProvider } from '../src/geom/client'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { writeProject } from '../src/export/threemf'
import { zip } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { objectOverrides, partOverridesOf } from '../src/plate/object-settings'
import { compose } from '../src/plate/transform'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { plateObjects } from '../src/state/slice-plate'
import { get, set, type PlateEntry } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 12], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

function box(id: number, lo: number[], hi: number[]): string {
  const v = Array.from({ length: 8 }, (_, i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]])
  const t = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

const md = (k: string, v: string) => `<metadata key="${k}" value="${v}"/>`

/** Two objects, each a build item made of components: "tuned" with settings of its own, "plain" with none and a part that has its own. */
function project(tuned: Record<string, string>): ArrayBuffer {
  const sub = `<model unit="millimeter"><resources>${box(1, [-10, -10, 0], [10, 10, 12])}${box(2, [-10, -10, 0], [10, 10, 12])}${box(3, [15, -5, 0], [25, 5, 12])}</resources></model>`
  const comp = (id: number) => `<component p:path="/3D/Objects/object_1.model" objectid="${id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
  const main = `<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="10" type="model"><components>${comp(1)}</components></object><object id="20" type="model"><components>${comp(2)}${comp(3)}</components></object></resources><build><item objectid="10" transform="1 0 0 0 1 0 0 0 1 80 128 0"/><item objectid="20" transform="1 0 0 0 1 0 0 0 1 150 128 0"/></build></model>`
  const cfg =
    `<config><object id="10">${md('name', 'tuned')}${md('extruder', '1')}${Object.entries(tuned).map(([k, v]) => md(k, v)).join('')}<part id="1" subtype="normal_part">${md('name', 'tuned body')}</part></object>` +
    `<object id="20">${md('name', 'plain')}${md('extruder', '1')}<part id="2" subtype="normal_part">${md('name', 'plain body')}</part><part id="3" subtype="normal_part">${md('name', 'plain tab')}${md('wall_loops', '3')}${md('sparse_infill_density', '60%')}</part></object>` +
    `<plate>${md('plater_id', '1')}<model_instance>${md('object_id', '10')}</model_instance><model_instance>${md('object_id', '20')}</model_instance></plate></config>`
  return buf(zip([{ name: '3D/3dmodel.model', data: main }, { name: '3D/Objects/object_1.model', data: sub }, { name: 'Metadata/model_settings.config', data: cfg }]))
}

const TUNED = { wall_loops: '5', sparse_infill_density: '40%', sparse_infill_pattern: 'gyroid', layer_height: '0.3' }
const TUNED_VALUES = { wall_loops: 5, sparse_infill_density: 40, sparse_infill_pattern: 'gyroid', layer_height: 0.3 }

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', objectSettings: {}, overrides: {}, projectSettings: null, projectPrinter: null, projectOpenAsk: null, slice: { status: 'idle' }, toast: null, unsavedPrompt: null }))
  await profileReady()
  startDirtyTracking()
  markClean()
})

describe("a project object's own settings", () => {
  it('are read from the object, apart from its name and filament', async () => {
    const p = await readProject(new Uint8Array(project(TUNED)), bed)
    const [tuned, plain] = p.plates[0]!.objects
    expect(tuned!.rawObjectSettings).toEqual(TUNED)
    expect(plain!.rawObjectSettings).toBeUndefined()
    expect(plain!.rawPartSettings).toEqual({ 'plain tab': { wall_loops: '3', sparse_infill_density: '60%' } })
  })

  it("open as that object's settings, and a part's stay on its part", async () => {
    await openModelBytes(host, 'two.3mf', project(TUNED), undefined, { fresh: true })
    const s = get()
    const tuned = s.plate.find((e) => e.name === 'tuned')!
    const plain = s.plate.find((e) => e.name === 'plain')!
    expect(objectOverrides(s, tuned)).toEqual(TUNED_VALUES)
    expect(objectOverrides(s, plain)).toEqual({})
    expect(partOverridesOf(s.plate, plain)).toEqual({ 'plain tab': { wall_loops: 3, sparse_infill_density: 60 } })
    // A client reads the same back from the plates the app link reports.
    const entries = platesState().plates[0]!.entries
    expect(entries.find((e) => e.name === 'tuned')!.settings).toEqual(TUNED_VALUES)
    expect(entries.find((e) => e.name === 'plain')!.settings).toEqual({})
  })

  it('go to the engine with the object they belong to', async () => {
    await openModelBytes(host, 'two.3mf', project(TUNED), undefined, { fresh: true })
    const s = get()
    const objects = await plateObjects({ loadModel: async () => handle('m') } as never, s, s.plates.find((p) => p.id === s.activePlate), s.plate)
    const byName = Object.fromEntries(objects.map((o) => [o.name, o]))
    expect(byName['tuned']!.settings).toEqual(TUNED_VALUES)
    expect(byName['plain']!.settings).toBeUndefined()
    expect(byName['plain']!.partSettings).toEqual({ 'plain tab': { wall_loops: 3, sparse_infill_density: 60 } })
  })

  it('never bring custom G-code, scripts or printer keys', async () => {
    await openModelBytes(host, 'two.3mf', project({ wall_loops: '4', machine_start_gcode: 'M104 S300', post_process: 'rm -rf /', nozzle_diameter: '0.8' }), undefined, { fresh: true })
    const s = get()
    expect(objectOverrides(s, s.plate.find((e) => e.name === 'tuned')!)).toEqual({ wall_loops: 4 })
  })

  it('drop a value the engine refuses, as the plate settings a project brings do', async () => {
    const requests: SliceRequest[] = []
    const slice = async (r: SliceRequest) => {
      requests.push(r)
      const bad = r.plate.objects.find((o) => Number((o.settings as Record<string, SettingValue> | undefined)?.['raft_expansion'] ?? 0) < 0)
      throw new Error(bad ? 'config key raft_expansion: -3 is outside 0 to 100' : 'stop')
    }
    const engine = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice, loadParts: async (name: string) => handle(name) } } as unknown as Host
    await openModelBytes(engine, 'two.3mf', project({ wall_loops: '5', raft_expansion: '-3' }), undefined, { fresh: true })
    const tuned = () => get().plate.find((e) => e.name === 'tuned')!
    expect(objectOverrides(get(), tuned())).toEqual({ wall_loops: 5, raft_expansion: -3 })
    await slicePlate(engine, { auto: true })
    expect(requests).toHaveLength(2)
    expect(objectOverrides(get(), tuned())).toEqual({ wall_loops: 5 })
    expect(get().toast?.text).toMatch(/^Setting not imported from two\.3mf: Raft expansion/)
  })

  it('stay with the object through a save and an open', async () => {
    const e: PlateEntry = { id: 'o1', name: 'Box', handle: handle('o1'), parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
    const bytes = writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-object' } }], bed, settings: {}, objectSettings: { o1: { wall_loops: 4, layer_height: 0.28 } } })
    const o = (await readProject(bytes, bed)).plates[0]!.objects[0]!
    expect(modifierSettings(o.rawObjectSettings!)).toEqual({ wall_loops: 4, layer_height: 0.28 })
    await openModelBytes(host, 'box.3mf', buf(bytes), undefined, { fresh: true })
    const s = get()
    expect(objectOverrides(s, s.plate[0]!)).toEqual({ wall_loops: 4, layer_height: 0.28 })
  })
})

const wasm = process.env['SX_GEOM_CORE_WASM'] ?? join(__dirname, '..', '..', '..', 'packages/geom/wasm/pkg/sx_geom_core.wasm')

describe.skipIf(!existsSync(wasm))("a project object's own settings through the geometry engine's reader", async () => {
  const instance = existsSync(wasm) ? (await WebAssembly.instantiate(readFileSync(wasm), {})).instance : null
  const x = instance?.exports as unknown as GeomExports
  afterAll(() => {
    setGeomProvider(null)
    readProjectsWithGeom(true)
  })
  it('are the ones the TypeScript reader reads', async () => {
    readProjectsWithGeom(true)
    setGeomProvider({ call: async <T,>(op: string, request: unknown) => callEngine(x, op, request) as T })
    const scanned = await scanProjectFile(new Uint8Array(project(TUNED)))
    expect(scanned.parsedIn).toBe('geom')
    const [tuned, plain] = (await projectOf(scanned, bed)).plates[0]!.objects
    expect(tuned!.rawObjectSettings).toEqual(TUNED)
    expect(plain!.rawObjectSettings).toBeUndefined()
    expect(plain!.rawPartSettings).toEqual({ 'plain tab': { wall_loops: '3', sparse_infill_density: '60%' } })
  })
})
