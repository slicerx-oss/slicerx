// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A print file (.gcode.3mf) made from a Vault design leaves without the model. The layout is the one checked on the A1
// and A1 mini (print, plate picture, Skip Objects listing every object, reprint from the printer's file list, start
// from the SD card): the same parts as the full file, in the same order, with the G-code and its MD5, the pictures,
// slice_info.config and plate_1.json unchanged; the model part keeps its metadata and Vault marks but no mesh,
// component or build item; model_settings.config keeps the plate without objects or instances. Every way the app
// writes one strips it (save, save every plate, the Print sheet, mimir's printer queue); print files of your own
// designs are as before.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Host, JobFile, MeshHandle, SliceResult } from '@slicerx/contracts'
import { exportAllPlates, exportGcode3mf, printGcode3mf } from '../src/export/actions'
import { unzipEntries } from '../src/export/import3mf'
import { md5Hex } from '../src/export/md5'
import { projectFiles, withoutThumbnails, writeProject, writeProjectCompressed, type ProjectInput } from '../src/export/threemf'
import { unzipStored } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { pilotSlicer } from '../src/workspaces/mimir/project'
import { sendToPrinter } from '../src/state/actions'
import { get, set, type PlateEntry, type PlateMeta } from '../src/state/store'

vi.mock('../src/state/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/state/actions')>()),
  slicePlate: async () => set({ slice: { status: 'done', result: { id: 'r1' } as never, stale: false } }),
}))

const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const VAULT = { modelId: '00000000-0000-4000-8000-0000000c11b0', creatorId: '00000000-0000-4000-8000-00000000c0de' }

/** The parts of the print file the printers took, in order. */
const LAYOUT = [
  '[Content_Types].xml',
  '_rels/.rels',
  '3D/3dmodel.model',
  'Metadata/model_settings.config',
  'Metadata/project_settings.config',
  'Metadata/slice_info.config',
  'Metadata/plate_1.gcode',
  'Metadata/plate_1.gcode.md5',
  'Metadata/plate_1.json',
  'Metadata/plate_1.png',
  'Metadata/plate_1_small.png',
  'Metadata/_rels/model_settings.config.rels',
]
/** The only parts stripping changes. */
const STRIPPED = new Set(['3D/3dmodel.model', 'Metadata/model_settings.config'])

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
function clip(id: string, name: string, x: number, source?: { modelId: string; creatorId: string }): PlateEntry {
  return { id, name, handle: handle(id), parts: [{ ...boxMesh(20, 8, 8), name: 'Cable clip', slot: 1 }], colors: ['#ffffff'], transform: compose({ position: [x, 130, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), ...(source ? { source } : {}) }
}

/** Two clips as the engine slices them for a Bambu Lab printer: labels, thumbnails, footer. */
const GCODE = [
  '; HEADER_BLOCK_START',
  '; model label id: 1,2',
  '; estimated first layer printing time (normal mode) = 6m 39s',
  '; HEADER_BLOCK_END',
  '; THUMBNAIL_BLOCK_START',
  `; thumbnail begin 512x512 ${PNG.length}`,
  `; ${PNG}`,
  '; thumbnail end',
  '; THUMBNAIL_BLOCK_END',
  '',
  '; THUMBNAIL_BLOCK_START',
  `; thumbnail begin 128x128 ${PNG.length}`,
  `; ${PNG}`,
  '; thumbnail end',
  '; THUMBNAIL_BLOCK_END',
  '; start printing object, unique label id: 1',
  'G1 X96 Y126',
  'G1 X116 Y134 E1',
  '; stop printing object, unique label id: 1',
  '; start printing object, unique label id: 2',
  'G1 X140 Y126',
  'G1 X160 Y134 E1',
  '; stop printing object, unique label id: 2',
  '; filament used [mm] = 730.00',
  '; filament used [g] = 2.21',
  '; total filament used [g] = 2.21',
  '; estimated printing time (normal mode) = 14m 15s',
  '',
].join('\n')

const A1 = { printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], printable_area: ['0x0', '256x0', '256x256', '0x256'], filament_type: ['PLA'], filament_colour: ['#FFFFFF'], filament_ids: ['GFA00'], layer_height: '0.2', timelapse_type: '0' }
const MINI = { ...A1, printer_model: 'Bambu Lab A1 mini', printable_area: ['0x0', '180x0', '180x180', '0x180'] }

function input(settings: Record<string, unknown>, objects: PlateEntry[], extra: Partial<ProjectInput> = {}): ProjectInput {
  const plates: PlateMeta[] = [{ id: 'p1', name: 'Plate 1', objects, settings: {} }]
  return { plates, bed: { widthMm: 256, depthMm: 256 }, settings, gcode: { 0: GCODE }, sx: { ...VAULT, exportedBy: '' }, ...extra }
}

/** What stripping must leave of the full file's model part: its head and metadata, then empty resources and build. */
function strippedModel(full: string): string {
  return `${full.slice(0, full.indexOf('<resources>'))}<resources></resources><build></build></model>`
}

/** The full file's model_settings.config without its objects and instances. */
function strippedSettings(full: string): string {
  return full.replace(/<object id="\d+">.*?<\/object>/g, '').replace(/<model_instance>.*?<\/model_instance>/g, '')
}

/** Checks a stripped file against the full one: the proven layout, and only the model part and model_settings changed. */
function expectStripped(stripped: Map<string, Uint8Array>, full: Map<string, Uint8Array>) {
  expect([...stripped.keys()]).toEqual(LAYOUT)
  expect([...full.keys()]).toEqual(LAYOUT)
  for (const name of LAYOUT) if (!STRIPPED.has(name)) expect(dec(stripped.get(name)), name).toBe(dec(full.get(name)))
  for (const name of ['Metadata/plate_1.png', 'Metadata/plate_1_small.png']) expect([...stripped.get(name)!]).toEqual([...full.get(name)!])
  const model = dec(stripped.get('3D/3dmodel.model'))
  expect(model).toBe(strippedModel(dec(full.get('3D/3dmodel.model'))))
  expect(model).not.toMatch(/<object|<vertex|<triangle|<item|<component/)
  const cfg = dec(stripped.get('Metadata/model_settings.config'))
  expect(cfg).toBe(strippedSettings(dec(full.get('Metadata/model_settings.config'))))
  expect(cfg).not.toMatch(/<object|model_instance|identify_id/)
}

beforeAll(async () => void (await Promise.all([import('../src/state/send-actions'), import('../src/send/bed-state'), import('../src/plate/preflight'), import('../src/features/fleet/device'), import('../src/features/fleet/guard')])))

describe('the meshless print file a Vault design leaves as', () => {
  for (const [printer, settings] of [['A1', A1], ['A1 mini', MINI]] as const) {
    it(`keeps the layout the ${printer} took, with the G-code and its MD5 unchanged`, () => {
      const objects = [clip('a', 'Cable clip', 96, VAULT), clip('b', 'Cable clip 2', 140, VAULT)]
      const full = unzipStored(writeProject(input(settings, objects)))
      const stripped = unzipStored(writeProject(input(settings, objects, { meshless: true })))
      expectStripped(stripped, full)
      const run = withoutThumbnails(GCODE)
      expect(dec(stripped.get('Metadata/plate_1.gcode'))).toBe(run)
      expect(dec(stripped.get('Metadata/plate_1.gcode.md5'))).toBe(md5Hex(new TextEncoder().encode(run)).toUpperCase())
      // The model part still names the app, the design and its Vault listing.
      const model = dec(stripped.get('3D/3dmodel.model'))
      for (const m of ['<metadata name="Application">', '<metadata name="Title">Cable clip</metadata>', `<metadata name="sx:Listing">${VAULT.modelId}</metadata>`, `<metadata name="sx:Creator">${VAULT.creatorId}</metadata>`, '<metadata name="sx:ExportedBy"></metadata>'])
        expect(model).toContain(m)
      // Skip Objects reads the objects from slice_info.config and plate_1.json, which list both clips.
      const info = dec(stripped.get('Metadata/slice_info.config'))
      expect(info).toContain('<object identify_id="1" name="Cable clip" skipped="false" />')
      expect(info).toContain('<object identify_id="2" name="Cable clip 2" skipped="false" />')
      expect((JSON.parse(dec(stripped.get('Metadata/plate_1.json'))) as { bbox_objects: { id: number; name: string }[] }).bbox_objects.map((o) => [o.id, o.name])).toEqual([[1, 'Cable clip'], [2, 'Cable clip 2']])
      const cfg = dec(stripped.get('Metadata/model_settings.config'))
      expect(cfg).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<config><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Plate 1"/><metadata key="locked" value="false"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/><metadata key="thumbnail_file" value="Metadata/plate_1.png"/><metadata key="pattern_bbox_file" value="Metadata/plate_1.json"/></plate></config>')
    })
  }

  it('lists only the printing objects, as the full file does', () => {
    const objects = [clip('a', 'Cable clip', 96, VAULT), { ...clip('off', 'Parked', 200, VAULT), printable: false }, clip('b', 'Cable clip 2', 140, VAULT)]
    const full = unzipStored(writeProject(input(A1, objects)))
    const stripped = unzipStored(writeProject(input(A1, objects, { meshless: true })))
    expect(dec(stripped.get('Metadata/slice_info.config'))).toBe(dec(full.get('Metadata/slice_info.config')))
    expect(dec(stripped.get('Metadata/plate_1.json'))).toBe(dec(full.get('Metadata/plate_1.json')))
    expect(dec(stripped.get('Metadata/slice_info.config'))).not.toContain('Parked')
  })

  it('leaves out every part that carries geometry or hangs off an object', () => {
    const shaped: PlateEntry = { ...clip('a', 'Cable clip', 96, VAULT), brimPoints: [[0, 0, 0, 2]], layerRanges: [{ minZ: 0, maxZ: 2, settings: { wall_loops: '3' } }] } as PlateEntry
    const objects = [shaped, clip('b', 'Cable clip 2', 140, VAULT)]
    const extra = { objectSettings: { a: { wall_loops: '4' } }, namedValues: [{ name: 'w', expr: '20' }], layerMarks: { 0: [{ z: 2, kind: 'pause' as const }] } }
    // Split meshes (one model file per object), as a big project writes them.
    const full = projectFiles(input(A1, objects, extra), 0).map((f) => f.name)
    const stripped = projectFiles(input(A1, objects, { ...extra, meshless: true }), 0).map((f) => f.name)
    expect(full).toEqual(expect.arrayContaining(['3D/_rels/3dmodel.model.rels', 'Metadata/layer_config_ranges.xml', 'Metadata/brim_ear_points.txt', 'Metadata/slicerx_values.json']))
    expect(full.some((n) => n.startsWith('3D/Objects/'))).toBe(true)
    expect(stripped).toEqual([...LAYOUT.slice(0, 5), 'Metadata/custom_gcode_per_layer.xml', ...LAYOUT.slice(5)])
  })

  it('writes the same bytes as before without it', () => {
    const objects = [clip('a', 'Cable clip', 96), clip('b', 'Cable clip 2', 140)]
    const plain = { ...input(A1, objects) }
    delete plain.sx
    const bytes = writeProject(plain)
    expect([...writeProject({ ...plain, meshless: false })]).toEqual([...bytes])
    const model = dec(unzipStored(bytes).get('3D/3dmodel.model'))
    expect(model.match(/<object /g)).toHaveLength(4)
    expect(model.match(/<item /g)).toHaveLength(2)
  })
})

describe('every print file the app writes for a Vault design', () => {
  const result = { id: 'r1', engine: 'sx', layerCount: 45, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 855, filamentMm: [730], filamentG: [2.21], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] } as SliceResult
  const blob = () => new Blob([GCODE], { type: 'text/x-gcode' })
  const printHost = (saved: { name: string; blob: Blob }[]) =>
    ({
      kind: 'web',
      capabilities: { threads: 1 },
      files: { save: async (name: string, b: Blob) => (saved.push({ name, blob: b }), { id: name, name, size: b.size }) },
      slicer: { exportGcode: async () => ({ fileName: 'plate.gcode', bytes: GCODE.length, sha256: 'x', blob: blob() }), loadParts: async (name: string) => handle(name) },
    }) as unknown as Host
  const sliced = (plate: PlateEntry[]) => set({ plate, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', selection: null, selectedIds: [], slice: { status: 'done', result, stale: false }, toast: null, approval: null, printSheet: null })
  const vaultPlate = () => [clip('a', 'Cable clip', 96, VAULT), clip('b', 'Cable clip 2', 140, VAULT)]
  const ownPlate = () => [clip('a', 'Cable clip', 96), clip('b', 'Cable clip 2', 140)]
  /** The plate as the app's writer takes it, for the full file to compare against. */
  const asWritten = (objects: PlateEntry[]): PlateMeta[] => [{ id: 'p1', name: 'Plate 1', objects, settings: {} }]
  const files = async (b: Blob | Uint8Array) => unzipEntries(b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : b)

  async function full(objects: PlateEntry[], gcode: Record<number, string> = { 0: GCODE }) {
    // The settings the print paths write, read back from a file they made.
    const sample = await files(await printGcode3mf(GCODE))
    const settings = JSON.parse(dec(sample.get('Metadata/project_settings.config'))) as Record<string, unknown>
    return unzipEntries(await writeProjectCompressed({ plates: asWritten(objects), bed: get().bed, settings, gcode, sx: { ...VAULT, exportedBy: '' } }))
  }

  it('strips the saved .gcode.3mf', async () => {
    sliced(vaultPlate())
    const saved: { name: string; blob: Blob }[] = []
    expect(await exportGcode3mf(printHost(saved))).toBe(true)
    expect(saved[0]?.name).toMatch(/\.gcode\.3mf$/)
    expectStripped(await files(saved[0]!.blob), await full(vaultPlate()))
  })

  it('strips the file that saves every plate', async () => {
    sliced(vaultPlate())
    const saved: { name: string; blob: Blob }[] = []
    expect(await exportAllPlates(printHost(saved))).toBe(true)
    expectStripped(await files(saved[0]!.blob), await full(vaultPlate()))
  })

  it('strips the file the Print sheet sends, and binds the start to its bytes', async () => {
    sliced(vaultPlate())
    const uploads: JobFile[] = []
    const printers = {
      status: async () => ({ state: 'idle', slots: [] }),
      upload: async (printerId: string, file: JobFile) => (uploads.push(file), { printerId, path: file.name, name: file.name, sha256: file.sha256 }),
      start: async () => undefined,
    }
    const approvals = { register: async () => undefined, grant: async (id: string) => ({ requestId: id }), deny: async () => undefined }
    const host = { kind: 'web', printers, approvals, slicer: { exportGcode: async () => ({ blob: blob(), bytes: GCODE.length, sha256: 'x' }) } } as unknown as Host
    const done = sendToPrinter(host, { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as never)
    await vi.waitFor(() => expect(get().printSheet?.check).toBeTruthy(), { timeout: 45_000 })
    get().printSheet!.resolve({ options: {}, start: true, name: 'clip.gcode.3mf' })
    await done
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.kind).toBe('gcode.3mf')
    const sent = await files(new Uint8Array(uploads[0]!.data))
    expectStripped(sent, await full(vaultPlate()))
  })

  it("strips the file mimir's printer queue sends", async () => {
    sliced(vaultPlate())
    const host = { slicer: { exportGcode: async () => ({ fileName: 'clip.gcode', blob: blob(), bytes: GCODE.length, sha256: 'x' }) } } as unknown as Host
    const out = await pilotSlicer(host).exportGcode3mf!('r1', { plate: 1 })
    expectStripped(await files(out.blob!), await full(vaultPlate()))
  })

  it('names the first Vault design on a plate that mixes it with your own', async () => {
    sliced([clip('mine', 'Bracket', 96), clip('v', 'Cable clip', 140, VAULT)])
    const model = dec((await files(await printGcode3mf(GCODE))).get('3D/3dmodel.model'))
    expect(model).toContain(`<metadata name="sx:Listing">${VAULT.modelId}</metadata>`)
    expect(model).toContain('<metadata name="Title">Bracket</metadata>')
    expect(model).not.toMatch(/<object|<item/)
  })

  it('leaves print files of your own designs as they were, with the model', async () => {
    sliced(ownPlate())
    const sent = await printGcode3mf(GCODE)
    const settings = JSON.parse(dec((await files(sent)).get('Metadata/project_settings.config'))) as Record<string, unknown>
    const before = await writeProjectCompressed({ plates: asWritten(ownPlate()), bed: get().bed, settings, gcode: { 0: GCODE } })
    expect([...sent]).toEqual([...before])
    const saved: { name: string; blob: Blob }[] = []
    expect(await exportGcode3mf(printHost(saved))).toBe(true)
    expect([...new Uint8Array(await saved[0]!.blob.arrayBuffer())]).toEqual([...before])
    expect(dec((await files(sent)).get('3D/3dmodel.model')).match(/<item /g)).toHaveLength(2)
  })
})
