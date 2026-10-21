// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The files an MCP client saves (slicerx_design_save, and the .gcode.3mf of slicerx_slice_file) are the files the
// app writes for the same plate: the same entries in the same order, the same XML and JSON, the same bytes for
// G-code, pictures and the CAD history. The MCP server deflates its archive and the app's writeProject stores, so
// the entries are compared after reading.
import { inflateRawSync } from 'node:zlib'
import { IDENTITY, type HistoryMesh } from '@slicerx/cad-history'
import type { SettingValue } from '@slicerx/contracts'
import { design3mf, gcode3mf, type Design } from '@slicerx/mcp'
import { describe, expect, it } from 'vitest'
import { settingDef, toOrca } from '../src/adapters/settings'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import type { PlateEntry, PlateMeta } from '../src/state/store'

/** The entries of a ZIP, stored or deflated, in archive order. */
function entries(bytes: Uint8Array): [string, Uint8Array][] {
  const b = Buffer.from(bytes)
  let eocd = b.length - 22
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--
  const out: [string, Uint8Array][] = []
  let p = b.readUInt32LE(eocd + 16)
  for (let n = b.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = b.readUInt16LE(p + 10)
    const size = b.readUInt32LE(p + 20)
    const nameLen = b.readUInt16LE(p + 28)
    const name = b.toString('utf8', p + 46, p + 46 + nameLen)
    const at = b.readUInt32LE(p + 42)
    const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28)
    const raw = b.subarray(start, start + size)
    out.push([name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : new Uint8Array(raw)])
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32)
  }
  return out
}

const TEXT = /\.(model|config|rels|xml)$/
const dec = new TextDecoder()
/** XML with the white space between tags dropped; JSON parsed; everything else as bytes. */
const normal = (name: string, data: Uint8Array): unknown => (TEXT.test(name) ? dec.decode(data).replace(/>\s+</g, '><').trim() : name.endsWith('.json') ? JSON.parse(dec.decode(data)) : Array.from(data))

function expectSameFile(mcp: Uint8Array, app: Uint8Array): void {
  const a = entries(mcp)
  const b = entries(app)
  expect(a.map(([n]) => n)).toEqual(b.map(([n]) => n))
  for (const [i, [name, data]] of a.entries()) expect(normal(name, data), name).toEqual(normal(name, b[i]![1]))
}

function box(name: string, slot: number, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): HistoryMesh {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [i & 1 ? x1! : x0!, i & 2 ? y1! : y0!, i & 4 ? z1! : z0!])
  const indices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]
  return { name, slot, positions, indices }
}

const bed = { widthMm: 256, depthMm: 256 }

/** A design as a plate entry of the app's store: the same parts, paint, placement and history. */
function asEntry(d: Design): PlateEntry {
  return {
    id: d.id,
    name: d.name,
    handle: { id: d.id, name: d.name, triangles: 0 } as unknown as PlateEntry['handle'],
    parts: d.parts.map((p) => ({ name: p.name, slot: p.slot, positions: new Float32Array(p.positions), indices: new Uint32Array(p.indices) })),
    colors: [],
    transform: [...d.transform],
    paint: Object.fromEntries(d.parts.flatMap((p, i) => (p.paint ? [[i, p.paint]] : []))),
    history: d.history,
  }
}

describe('MCP files and the app writer', () => {
  const base = { ...box('Base', 2, [0, 0, 0], [20.25, 10, 3]), paint: { color: { 0: '8', 1: '8' }, seam: { 4: '4' } } }
  const button = box('Button', 3, [8, 3, 3], [12, 7, 5])
  const moved = [...IDENTITY]
  moved[12] = 100
  moved[13] = 90
  const design: Design = {
    id: 'd1',
    name: 'Cable clip & cap',
    history: { version: 1, base: [base], steps: [{ id: 's1', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [10, 5, 3], normal: [0, 0, 1], distanceMm: 2 } }] },
    transform: moved,
    parts: [base, button],
    status: [],
    madeBy: {},
    written: 0,
    redo: [],
  }

  it('a saved design is the project the app writes for that object on its own plate', () => {
    const plate: PlateMeta = { id: 'p1', name: '', objects: [asEntry(design)], settings: {} }
    expectSameFile(new Uint8Array(design3mf(design)), writeProject({ plates: [plate], bed }))
    // With no print settings the file has no settings part, so slicers open it as a model.
    expect(entries(new Uint8Array(design3mf(design))).map(([n]) => n)).not.toContain('Metadata/project_settings.config')
  })

  it('a saved design opens in the app with its parts, paint, placement and history', async () => {
    const p = await readProject(new Uint8Array(design3mf(design)), bed)
    const o = p.plates.flatMap((pl) => pl.objects)[0]!
    expect(o.name).toBe('Cable clip & cap')
    expect(o.parts.map((x) => [x.name, x.slot, x.indices.length])).toEqual([['Base', 2, 36], ['Button', 3, 36]])
    expect(o.paint).toEqual({ 0: { color: { 0: '8', 1: '8' }, seam: { 4: '4' } } })
    expect(p.histories.get(o.fileId)?.steps.map((s) => s.params.op)).toEqual(['face.push'])
  })

  it('a .gcode.3mf is the print file the app writes for the plate', () => {
    const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(n)])
    const block = (w: number, b: Buffer) => `; THUMBNAIL_BLOCK_START\n; thumbnail begin ${w}x${w} ${b.toString('base64').length}\n; ${b.toString('base64')}\n; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n`
    const gcode =
      `; HEADER_BLOCK_START\n; model label id: 1,2\n; estimated first layer printing time (normal mode) = 12s\n; HEADER_BLOCK_END\n${block(128, png(4))}${block(512, png(40))}` +
      `; start printing object, unique label id: 1\nG1 X10 Y10 F600\nG1 X20 Y10 E1\nG1 X20 Y20 E1\n; stop printing object, unique label id: 1\n` +
      `; start printing object, unique label id: 2\nG1 X40 Y40 F600\nG1 X50 Y45 E1\n; stop printing object, unique label id: 2\n` +
      `; filament used [mm] = 1000.00, 200.00\n; filament used [g] = 3.00, 0.50\n; total filament used [g] = 3.50\n; estimated printing time (normal mode) = 10m 0s\n`
    const config: Record<string, SettingValue> = { filament_type: ['PLA', 'PETG'], filament_colour: ['#ff0000', '#00ae42'], printer_model: 'Bambu Lab A1', nozzle_diameter: [0.4], layer_height: 0.2, enable_support: true }
    const summary = { engine: 'sx' as const, model: { name: 'bracket.stl' }, layer_count: 10, time_s: 600, time_text: '10m', filament_g: 3.5, filament_mm: 1200, filaments: [{ slot: 1, filament_mm: 1000, filament_g: 3 }, { slot: 2, filament_mm: 200, filament_g: 0.5 }], warnings: [] }
    // The settings as the app's export turns them into Orca's form (export/actions.ts orcaSettings).
    const orca = Object.fromEntries(Object.entries(config).map(([k, v]) => {
      const def = settingDef(k)
      return [k, def ? toOrca(def, v) : v]
    }))
    // A print file carries no geometry: the plate has no objects, and the G-code's objects are named after the model.
    const plate = { id: 'p1', name: '', objects: [], settings: {}, printNames: ['bracket.stl', 'bracket.stl 2'] } as PlateMeta
    const mcp = new Uint8Array(gcode3mf(gcode, summary, config))
    expectSameFile(mcp, writeProject({ plates: [plate], bed, settings: orca, gcode: { 0: gcode } }))
    const names = entries(mcp).map(([n]) => n)
    expect(names).toEqual([
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
    ])
  })
})
