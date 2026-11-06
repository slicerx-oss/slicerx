// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the project reader left out of a file is said when it opens, in one plain note: the geometry engine's own notes
// (paint in a newer facets JSON version it skipped, for example) and parts of a type this version does not read, with
// the TypeScript reader too. The part type the file names is never shown. With the engine built
// (packages/geom/wasm/scripts/build.sh, or SX_GEOM_CORE_WASM) the part type case also runs on the real engine.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import type { GeomPart, GeomProject } from '../src/export/geom-project'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { setGeomProvider } from '../src/geom/client'
import { callEngine, type GeomExports } from '../src/geom/engine-call'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { openModelBytes } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'
import { wasmBuilt } from './geom-engine'

const SKIPPED_PAINT = 'paint in a newer facets JSON version was skipped'

const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
const mesh = `<mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources><object id="1" name="box" type="model">${mesh}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 40 0"/></build></model>`
/** A box object of two parts, the second of a part type no slicer writes. */
const TWO_PARTS = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" ${NS}><resources><object id="1" type="model">${mesh}</object><object id="2" type="model">${mesh}</object><object id="3" type="model"><components><component objectid="1"/><component objectid="2" transform="1 0 0 0 1 0 0 0 1 30 0 0"/></components></object></resources><build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 30 40 0"/></build></model>`
const SETTINGS = `<?xml version="1.0"?><config><object id="3"><metadata key="name" value="Bracket"/><part id="1" subtype="normal_part"><metadata key="name" value="Body"/></part><part id="2" subtype="lattice_part"><metadata key="name" value="Gear"/></part></object></config>`

const plainBox = (): Uint8Array => zip([{ name: '3D/3dmodel.model', data: MODEL }])
const bracket = (): Uint8Array => zip([{ name: '3D/3dmodel.model', data: TWO_PARTS }, { name: 'Metadata/model_settings.config', data: SETTINGS }])
const bed = { widthMm: 256, depthMm: 256 }

const part = (name: string, kindText: string | null = null): GeomPart => ({
  id: 1,
  name,
  meshName: '',
  range: null,
  kind: 'normal',
  kindText,
  slot: null,
  settings: [],
  paint: null,
  transformed: false,
  positions: new Float32Array(vertices.flat()),
  indices: new Uint32Array(triangles.flat()),
})

/** The box as the engine reads it, with `notes` and `parts` as given. */
const geomBox = (notes: string[], parts: GeomPart[] = [part('box')]): GeomProject => ({
  layout: 'plain',
  unitScale: 1,
  doctype: false,
  metadata: [],
  plates: [],
  objects: [{ id: 1, name: 'box', transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 30, 40, 0], printable: true, plate: null, slot: null, settings: [], metadata: [], parts }],
  notes,
})

/** Reads projects with a stand-in for the engine that answers `answer`. */
function engineAnswers(answer: GeomProject): void {
  readProjectsWithGeom(true)
  setGeomProvider({ call: async <T,>() => answer as T })
}

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string) => handle(name) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

beforeEach(async () => {
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], toast: null, openNote: null, unsavedPrompt: null }))
  await profileReady()
  startDirtyTracking()
  markClean()
})

afterEach(() => {
  setGeomProvider(null)
  readProjectsWithGeom(true)
})

describe('what the engine left out of a project, as the file is read', () => {
  it('gives the engine notes in one plain note', async () => {
    engineAnswers(geomBox([SKIPPED_PAINT, `${SKIPPED_PAINT}.`, 'a second thing was skipped']))
    const p = await readProject(plainBox(), bed)
    expect(p.plates[0]!.objects.map((o) => o.name)).toEqual(['box'])
    expect(p.readerNote).toBe(`Not everything in this file was read: ${SKIPPED_PAINT}; a second thing was skipped.`)
  })

  it('says nothing when the engine left nothing out', async () => {
    engineAnswers(geomBox([]))
    expect((await readProject(plainBox(), bed)).readerNote).toBeUndefined()
  })

  it('says a part of a type it does not read was left out, by name, with no part type', async () => {
    const typeNote = 'Gear: part type lattice_part is not one this reader knows; read as a normal part'
    engineAnswers(geomBox([typeNote, SKIPPED_PAINT], [part('Body'), part('Gear', 'lattice_part')]))
    const p = await readProject(plainBox(), bed)
    expect(p.plates[0]!.objects[0]!.parts.map((q) => q.name)).toEqual(['Body'])
    expect(p.readerNote).toBe(`Not everything in this file was read: a part of a type this version does not read was left out (Gear); ${SKIPPED_PAINT}.`)
    expect(p.readerNote).not.toMatch(/lattice_part|normal part/)
  })

  it('says so with the TypeScript reader too', async () => {
    readProjectsWithGeom(false)
    const p = await readProject(bracket(), bed)
    expect(p.plates[0]!.objects[0]!.parts.map((q) => q.name)).toEqual(['Body'])
    expect(p.readerNote).toBe('Not everything in this file was read: a part of a type this version does not read was left out (Gear).')
    readProjectsWithGeom(false)
    expect((await readProject(plainBox(), bed)).readerNote).toBeUndefined()
  })
})

describe('what the engine left out of a project, as it opens', () => {
  it('shows a skipped JSON painting in the open note', async () => {
    engineAnswers(geomBox([SKIPPED_PAINT]))
    await openModelBytes(host, 'painted.3mf', buf(plainBox()), undefined, { fresh: true })
    expect(get().plate.map((p) => p.name)).toEqual(['box'])
    expect(get().openNote?.text).toContain(`Not everything in this file was read: ${SKIPPED_PAINT}.`)
  })

  it('shows nothing extra for a file read whole', async () => {
    engineAnswers(geomBox([]))
    await openModelBytes(host, 'plain.3mf', buf(plainBox()), undefined, { fresh: true })
    expect(get().plate.map((p) => p.name)).toEqual(['box'])
    expect(get().openNote?.text ?? '').not.toContain('Not everything in this file was read')
  })
})

const root = join(__dirname, '..', '..', '..')
const wasm = process.env['SX_GEOM_CORE_WASM'] ?? join(root, 'packages/geom/wasm/pkg/sx_geom_core.wasm')

describe.skipIf(!wasmBuilt(wasm))('what the real engine left out of a project', async () => {
  const engine = existsSync(wasm) ? ((await WebAssembly.instantiate(readFileSync(wasm), {})).instance.exports as unknown as GeomExports) : null
  it('says a part of a type it does not read was left out, by name, with no part type', async () => {
    readProjectsWithGeom(true)
    setGeomProvider({ call: async <T,>(op: string, r: unknown) => callEngine(engine!, op, r) as T })
    const p = await readProject(bracket(), bed)
    expect(p.plates[0]!.objects[0]!.parts.map((q) => q.name)).toEqual(['Body'])
    expect(p.readerNote).toBe('Not everything in this file was read: a part of a type this version does not read was left out (Gear).')
  })
})
