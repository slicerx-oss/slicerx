// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project saves every filament on the rail, in order, with each filament's own settings, so every per-filament list in
// project_settings.config has one entry per filament. Other slicers read those lists together, by index: paint on a
// filament no part uses (filament 25 of 32) needs that filament's entry in every list. Our reopen, the MCP server's
// inspect_project and the geometry engine's 3MF reader all read the saved file back the same way.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { createContext, serverTools } from '@slicerx/mcp'
import { settingDef } from '@slicerx/settings'
import { binBuilt, GEOM_BUILD } from './binaries'

const { saveProject } = await import('../src/export/actions')
const { readProject } = await import('../src/export/import3mf')
const { unzipEntries } = await import('../src/export/unzip')
const { boxMesh } = await import('../src/plate/mesh-ops')
const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta } = await import('../src/plate/plates')
const { appStore, get, set } = await import('../src/state/store')
type PlateEntry = import('../src/state/store').PlateEntry

const bed = { widthMm: 256, depthMm: 256 }
const A1 = { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }
const RAIL = 32
/** Paint code `7FC` is filament 25 on a whole triangle. */
const PAINT = { 0: { color: { 2: '7FC', 3: '7FC' } } }

const saved: { blob?: Blob } = {}
const host = {
  kind: 'web',
  capabilities: { threads: 1 },
  files: { save: vi.fn(async (_name: string, blob: Blob) => ((saved.blob = blob), { id: '1', name: 'rail.sx3mf', size: blob.size })) },
  slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) },
} as unknown as Host

/** Two parts, in filaments 1 and 2; the paint is on filament 25, which no part prints. */
function twoParts(): PlateEntry {
  return {
    id: 'a',
    name: 'Widget',
    handle: { id: 'h1', hash: 'h1', name: 'h1', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [{ name: 'Box', slot: 1, triangles: 12 }, { name: 'Box 2', slot: 2, triangles: 12 }] },
    parts: [boxMesh(20, 20, 20), { ...boxMesh(10, 10, 10), name: 'Box 2', slot: 2 }],
    colors: ['#bd93f9', '#303241'],
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1],
    paint: PAINT,
  }
}

/** 32 filaments added by hand: PLA in gray, except filament 25, a green PETG. */
const rail = () => Object.fromEntries(Array.from({ length: RAIL }, (_, i) => [i + 1, i === 24 ? { type: 'PETG', brand: '', color: '#00FF00' } : { type: 'PLA', brand: '', color: '#808080' }]))

async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

function fresh(slotSetup: Record<number, { type: string; brand: string; color: string }>, plate: PlateEntry[]): void {
  set((s) => ({ plate, plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', projectFile: null, slotSetup, printerSlots: [], projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], fileSlotTypes: [], fileSlotVendors: [], layerMarks: {}, printerId: A1.id, printerModel: A1, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
}

async function save(): Promise<Uint8Array> {
  expect(await saveProject(host)).toBe(true)
  return new Uint8Array(await saved.blob!.arrayBuffer())
}

async function projectSettings(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const entries = await unzipEntries(bytes)
  return JSON.parse(new TextDecoder().decode(entries.get('Metadata/project_settings.config')!)) as Record<string, unknown>
}

/**
 * The per-filament lists of a project's settings: every filament setting, and the project's own filament lists. An
 * empty list (a filament override no filament sets) sets nothing for any filament, so it is left out.
 */
function filamentLists(settings: Record<string, unknown>): Record<string, unknown> {
  const project = new Set(['filament_colour', 'filament_type', 'filament_vendor', 'filament_ids', 'filament_settings_id', 'filament_map', 'filament_nozzle_map'])
  return Object.fromEntries(Object.entries(settings).filter(([k, v]) => (project.has(k) || settingDef(k)?.section === 'filament') && !(Array.isArray(v) && v.length === 0)))
}

const lengths = (lists: Record<string, unknown>): Record<string, number> => Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]))

const asBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** An MCP server tool as a client calls it. */
type Tool = { name: string; input: { parse: (a: unknown) => unknown }; run: (a: unknown, c: unknown) => Promise<Record<string, unknown>> }
const toolsOf = (ctx: Awaited<ReturnType<typeof createContext>>): Tool[] => serverTools(ctx) as unknown as Tool[]
const named = (tools: Tool[], name: string): Tool => tools.find((t) => [name, `slicerx_${name}`].includes(t.name.replace(/\./g, '_')))!

beforeEach(() => {
  startProfileSync()
  startProjectPrinterSync()
})

describe('saving every filament on the rail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-rail-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes 32 entries in every per-filament list for 32 filaments with paint on 25, which no part uses', async () => {
    fresh(rail(), [twoParts()])
    await settled()
    const sliced = plateSliceConfig(get(), activeMeta(get())) as Record<string, unknown>
    const settings = await projectSettings(await save())
    const lists = filamentLists(settings)
    expect(Object.keys(lists).length).toBeGreaterThan(20)
    expect(Object.entries(lengths(lists)).filter(([, n]) => n !== RAIL)).toEqual([])
    // In rail order, each filament with its own color and type: 25 is the green PETG.
    expect((settings['filament_colour'] as string[])[24]?.toUpperCase()).toBe('#00FF00')
    expect((settings['filament_type'] as string[])[24]).toBe('PETG')
    expect((settings['filament_type'] as string[]).filter((t) => t === 'PLA')).toHaveLength(RAIL - 1)
    // and PETG's own settings, not PLA's
    const temps = (settings['nozzle_temperature'] as string[]).map(Number)
    expect(temps[24]).toBeGreaterThan(temps[0]!)
    // The filaments the parts print keep the values the plate slices with.
    for (const key of ['nozzle_temperature', 'filament_flow_ratio', 'filament_max_volumetric_speed']) {
      expect((settings[key] as string[]).slice(0, 2).map(Number), key).toEqual((sliced[key] as unknown[]).slice(0, 2).map(Number))
    }
    // The flush volumes are one 32 by 32 block for the A1's one nozzle.
    expect(settings['flush_volumes_matrix']).toHaveLength(RAIL * RAIL)
  })

  it('reads back as 32 filaments in our reopen and the MCP inspect, with the paint on 25', async () => {
    fresh(rail(), [twoParts()])
    await settled()
    const bytes = await save()

    // Our reader: 32 filaments listed.
    const read = await readProject(bytes, bed)
    expect((read.settings['filament_colour'] as unknown[]).length).toBe(RAIL)
    expect(read.colors).toHaveLength(RAIL)

    // Our open, on a fresh plate with nothing set by hand: the paint stays, with no note, and the file's 32 filaments
    // are the project's. Saving again writes all 32 once more.
    fresh({}, [])
    await settled()
    const toasts: string[] = []
    const stop = appStore.subscribe((s, prev) => void (s.toast && s.toast !== prev.toast && toasts.push(s.toast.text)))
    try {
      await openModelBytes(host, 'rail.sx3mf', asBuffer(bytes), undefined, { fresh: true })
    } finally {
      stop()
    }
    await settled()
    expect(get().plate[0]?.paint).toEqual(PAINT)
    expect(toasts.filter((t) => /opens unpainted|this project has/.test(t))).toEqual([])
    expect(get().fileSlotColors).toHaveLength(RAIL)
    expect(Object.values(lengths(filamentLists(await projectSettings(await save())))).filter((n) => n !== RAIL)).toEqual([])

    // The MCP server's inspect_project: 32 filament slots, 25 the green PETG.
    const file = join(dir, 'rail.sx3mf')
    writeFileSync(file, bytes)
    const ctx = await createContext({ engine: 'stub', allowDirs: [dir], outDir: join(dir, 'out'), printers: 'off' })
    const inspect = named(toolsOf(ctx), 'inspect_project')
    const r = (await inspect.run(inspect.input.parse({ file }), { progress: () => {} })) as { structured: { filaments: { slot: number; type?: string; color?: string }[] } }
    expect(r.structured.filaments).toHaveLength(RAIL)
    expect(r.structured.filaments[24]).toMatchObject({ slot: 25, type: 'PETG' })
    expect(r.structured.filaments[24]!.color?.toUpperCase()).toBe('#00FF00')
  })
})

// The geometry engine's 3MF reader (sx-geom format.read3mf, through the MCP server's design.open and paint.regions)
// reads the paint on filament 25 of the 32 the file lists.
const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release', process.platform === 'win32' ? 'sx.exe' : 'sx')
const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? join(dirname(sxBin), process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom')
describe.skipIf(!binBuilt(geomBin, GEOM_BUILD))('the geometry engine reading the saved file', () => {
  it('reads the paint on filament 25', async () => {
    fresh(rail(), [twoParts()])
    await settled()
    const bytes = await save()
    const dir = mkdtempSync(join(tmpdir(), 'sx-rail-geom-'))
    try {
      const file = join(dir, 'rail.3mf')
      writeFileSync(file, bytes)
      const ctx = await createContext({ engine: 'stub', sxGeomBin: geomBin, allowDirs: [dir], outDir: join(dir, 'out'), printers: 'off' })
      const tools = toolsOf(ctx)
      const open = named(tools, 'design_open')
      const regions = named(tools, 'paint_regions')
      const opened = (await open.run(open.input.parse({ path: file }), { progress: () => {} })) as { output: { designs: { design: string }[] } }
      const design = opened.output.designs[0]!.design
      const paint = (await regions.run(regions.input.parse({ design, layer: 'color' }), { progress: () => {} })) as { output: { totalsMm2: Record<string, number> } }
      expect(Object.keys(paint.output.totalsMm2)).toEqual(['25'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
