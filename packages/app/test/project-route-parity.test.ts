// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One project on one printer gives the same G-code through the app, the MCP server and the command line. The app's
// side is its real project open (the printer's layer, then the project's settings) and the config it slices with; the
// MCP server's is slicerx_slice_file with the printer's machine profile; the command line's is sx call slice_file. The
// app's config goes to sx in the MCP server's own request, so only the settings differ between them, and the G-code
// must match to the byte. Runs where sx (cargo build -p sx-cli --release) is built. The command line route runs the MCP
// server's source through tsx, as the in-process route does: its build in packages/mcp/dist is git-ignored and nothing
// in a test run rebuilds it, so a checkout that reuses one compares today's settings with an older day's.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Host, MeshHandle } from '@slicerx/contracts'
import { createContext, serverTools } from '@slicerx/mcp'

const { openModelBytes } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { plateSliceConfig } = await import('../src/state/slice-plate')
const { activeMeta } = await import('../src/plate/plates')
const { unzipEntries } = await import('../src/export/unzip')
const { zip } = await import('../src/export/zip')
const { loadFlushData } = await import('../src/filament/flush')

const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const mcpDir = resolve(__dirname, '../../mcp')
const runtime = join(mcpDir, 'src/cli.ts')
const repo = resolve(__dirname, '../../..')
const dir = mkdtempSync(join(tmpdir(), 'project-route-parity-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PRINTERS = {
  'prusa-mk4': { id: 'my-mk4', vendor: 'Prusa Research', model: 'MK4' },
  'bambu-a1': { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' },
} as const

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
// A mesh handle names each part's filament slot, as the engine's does, so the plate's slots are the file's.
const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { loadParts: async (name: string, parts: { name: string; slot?: number }[]) => ({ ...handle(name), parts: parts.map((p) => ({ name: p.name, slot: p.slot ?? 1, triangles: 12 })) }) } } as unknown as Host
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** Waits for the printer layer the store writes ask for, and the ones those builds start in turn. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

/** The config the app slices `file` with, opened on a fresh plate with `printer` selected. */
async function appConfig(file: string, printer: keyof typeof PRINTERS): Promise<Record<string, unknown>> {
  const p = PRINTERS[printer]
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], printerId: p.id, printerModel: p, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
  startProfileSync()
  startProjectPrinterSync()
  await settled()
  await openModelBytes(host, basename(file), buf(readFileSync(file)), undefined, { fresh: true })
  await settled()
  // The measured flush tables, loaded by the time a person slices a plate of several filaments.
  await loadFlushData()
  const s = get()
  return plateSliceConfig(s, activeMeta(s)) as unknown as Record<string, unknown>
}

type SliceFile = { input: { parse: (a: unknown) => unknown }; run: (a: unknown, c: unknown) => Promise<{ structured: Record<string, unknown> }> }

/** slicerx_slice_file in the MCP server: its G-code, and the request it sent sx. */
async function mcpSlice(file: string, profiles: string[], out: string): Promise<{ gcode: Buffer; request: Record<string, unknown> }> {
  const ctx = await createContext({ engine: 'sx', sxBin, allowDirs: [dirname(file)], outDir: out, printers: 'off' })
  const tool = serverTools(ctx).find((t) => t.name.endsWith('slice_file')) as unknown as SliceFile
  const r = await tool.run(tool.input.parse({ model: file, plate: 1, profiles, project_settings: true }), { progress: () => {} })
  const path = r.structured['gcode_path'] as string
  return { gcode: readFileSync(path), request: JSON.parse(readFileSync(join(dirname(path), 'request.json'), 'utf8')) as Record<string, unknown> }
}

/** The same request with the app's config in place of the server's. */
function appSlice(request: Record<string, unknown>, config: Record<string, unknown>, out: string): Buffer {
  mkdirSync(out, { recursive: true })
  const path = join(out, 'app-request.json')
  writeFileSync(path, JSON.stringify({ ...request, config }))
  execFileSync(sxBin, ['slice', '--request', path, '--out-dir', out], { stdio: 'pipe' })
  return readFileSync(join(out, 'slice.gcode'))
}

/** sx call slice_file: the command line's route to the same tool, run in the MCP package, where tsx resolves. */
function cliSlice(file: string, profiles: string[], out: string): Buffer {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('SLICERX_'))), HOME: out, USERPROFILE: out, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import tsx`, SLICERX_NODE_BIN: process.execPath, SLICERX_MCP_CLI: runtime } as Record<string, string>
  const args = ['call', '--no-app', '--printers', 'off', '--out-dir', join(out, 'out'), '--allow-dir', dirname(file), 'slice_file', JSON.stringify({ model: file, plate: 1, profiles, project_settings: true })]
  const line = JSON.parse(execFileSync(sxBin, args, { env, cwd: mcpDir, stdio: 'pipe' }).toString().trim().split('\n').pop()!) as { ok: boolean; output: { gcode_path?: string } }
  expect(line.ok).toBe(true)
  return readFileSync(line.output.gcode_path!)
}

/** Where two G-code files part, or null when they are the same bytes. */
function firstDifference(a: Buffer, b: Buffer): string | null {
  if (a.equals(b)) return null
  const x = a.toString().split('\n')
  const y = b.toString().split('\n')
  const i = x.findIndex((l, n) => l !== y[n])
  const at = i < 0 ? Math.min(x.length, y.length) : i
  return `line ${at + 1}: ${JSON.stringify(x[at])} vs ${JSON.stringify(y[at])} (${x.length} and ${y.length} lines)`
}

/** A Bambu Studio project for the A1 by name, without G-code of its own, so it opens on its own printer. */
async function namedA1Project(): Promise<string> {
  const entries = await unzipEntries(readFileSync(join(repo, 'packages/geom/tests/corpus/bambu-subtypes.3mf')))
  const files = [...entries].map(([name, data]) => {
    if (name !== 'Metadata/project_settings.config') return { name, data: Uint8Array.from(data) }
    const settings = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>
    const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => !k.endsWith('_gcode')))
    return { name, data: JSON.stringify({ ...kept, printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1' }) }
  })
  const path = join(dir, 'named-a1.3mf')
  writeFileSync(path, zip(files))
  return path
}

const COLORS = ['#00AE42', '#C12E1F', '#0A2989', '#F4EE2A']
const cubeMesh = (s: number) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return `<mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
}
const model = (app: string, objects: string, items: string) => `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">${app}</metadata><resources>${objects}</resources><build>${items}</build></model>`
const spot = (k: number) => `1 0 0 0 1 0 0 0 1 ${100 + 20 * k} 110 0`

/**
 * A Bambu Studio project of `n` 12 mm cubes, cube k printing with filament k. `forA1` names the A1 and carries a flush
 * matrix and a tower spot, as Bambu Studio saves a project for the printer; else it names no printer. `named` is how
 * many filaments the file lists, fewer than `n` for a file that names no color for the last slots.
 */
function bambuProject(n: number, forA1: boolean, named = n): string {
  const ids = Array.from({ length: n }, (_, k) => k)
  const objects = ids.map((k) => `<object id="${2 * k + 1}" type="model">${cubeMesh(12)}</object><object id="${2 * k + 2}" type="model"><components><component objectid="${2 * k + 1}"/></components></object>`).join('')
  const items = ids.map((k) => `<item objectid="${2 * k + 2}" transform="${spot(k)}"/>`).join('')
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${ids.map((k) => `<object id="${2 * k + 2}"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/><part id="${2 * k + 1}" subtype="normal_part"><metadata key="name" value="cube ${k + 1}"/><metadata key="extruder" value="${k + 1}"/></part></object>`).join('')}<plate><metadata key="plater_id" value="1"/>${ids.map((k) => `<model_instance><metadata key="object_id" value="${2 * k + 2}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate></config>`
  const settings: Record<string, unknown> = { filament_colour: COLORS.slice(0, named), filament_type: ids.slice(0, named).map(() => 'PLA'), layer_height: '0.2', initial_layer_print_height: '0.2', enable_prime_tower: '1', prime_tower_width: '35' }
  if (forA1) Object.assign(settings, { printer_settings_id: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], flush_volumes_matrix: ids.flatMap((i) => ids.map((j) => (i === j ? '0' : String(200 + 10 * i + j)))), flush_multiplier: ['1'], wipe_tower_x: ['165'], wipe_tower_y: ['200'] })
  const path = join(dir, `bambu-${n}${forA1 ? '-a1' : ''}-${named}.3mf`)
  writeFileSync(path, zip([{ name: '3D/3dmodel.model', data: model('BambuStudio-02.08.04.61', objects, items) }, { name: 'Metadata/model_settings.config', data: cfg }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]))
  return path
}

/** A PrusaSlicer project of `n` 12 mm cubes for a multi-material printer, cube k printing with filament k, from the repo fixture's settings. */
function prusaProject(n: number): string {
  const ids = Array.from({ length: n }, (_, k) => k)
  const text = prusaConfig.replace(/^; (extruder_colour|filament_colour) = .*$/gm, (_m, k: string) => `; ${k} = ${COLORS.slice(0, n).join(';')}`).replace(/^; single_extruder_multi_material = .*$/m, '; single_extruder_multi_material = 1')
  const objects = ids.map((k) => `<object id="${k + 1}" type="model">${cubeMesh(12)}</object>`).join('')
  const items = ids.map((k) => `<item objectid="${k + 1}" transform="${spot(k)}"/>`).join('')
  const cfg = `<?xml version="1.0" encoding="UTF-8"?><config>${ids.map((k) => `<object id="${k + 1}" instances_count="1"><metadata type="object" key="name" value="cube ${k + 1}"/><metadata type="object" key="extruder" value="${k + 1}"/><volume firstid="0" lastid="11"><metadata type="volume" key="name" value="cube ${k + 1}"/><metadata type="volume" key="volume_type" value="ModelPart"/></volume></object>`).join('')}</config>`
  const path = join(dir, `prusa-${n}.3mf`)
  writeFileSync(path, zip([{ name: '3D/3dmodel.model', data: model('PrusaSlicer-2.9.6', objects, items) }, { name: 'Metadata/Slic3r_PE_model.config', data: cfg }, { name: 'Metadata/Slic3r_PE.config', data: text }]))
  return path
}

/** The repo PrusaSlicer fixture's own settings, which the generated projects reuse. */
let prusaConfig = ''

const CASES: { name: string; file: () => Promise<string> | string; printer: keyof typeof PRINTERS; profiles: string[]; slots?: number }[] = [
  { name: 'a PrusaSlicer project on the MK4', file: () => join(repo, 'packages/settings/fixtures/preset-files/prusaslicer-2.9.6.3mf'), printer: 'prusa-mk4', profiles: ['machine:prusa-mk4'] },
  { name: 'an Orca project on the A1', file: () => join(repo, 'packages/geom/tests/corpus/orca-subtypes.3mf'), printer: 'bambu-a1', profiles: ['machine:bambu-a1'] },
  { name: 'a Bambu Studio project on the A1', file: () => join(repo, 'packages/geom/tests/corpus/bambu-subtypes.3mf'), printer: 'bambu-a1', profiles: ['machine:bambu-a1'] },
  // The app opens the project on the printer it names, from another printer; the MCP server names that printer.
  { name: 'a Bambu Studio project on the printer it names', file: namedA1Project, printer: 'prusa-mk4', profiles: ['machine:bambu-a1'] },
  // Plates of several filaments: the slots' colors, types and vendors, the flush matrix and the tower spot.
  { name: 'a 2-filament Bambu Studio project saved for the A1, with its flush matrix and tower spot', file: () => bambuProject(2, true), printer: 'prusa-mk4', profiles: ['machine:bambu-a1'], slots: 2 },
  { name: 'a 4-filament Bambu Studio project on the A1', file: () => bambuProject(4, false), printer: 'bambu-a1', profiles: ['machine:bambu-a1'], slots: 4 },
  { name: 'a 3-filament Bambu Studio project on the A1 that lists one filament', file: () => bambuProject(3, false, 1), printer: 'bambu-a1', profiles: ['machine:bambu-a1'], slots: 3 },
  { name: 'a 2-filament PrusaSlicer project on the MK4 with a multi-material unit', file: () => prusaProject(2), printer: 'prusa-mk4', profiles: ['machine:prusa-mk4'], slots: 2 },
  { name: 'a 4-filament PrusaSlicer project on the MK4 with a multi-material unit', file: () => prusaProject(4), printer: 'prusa-mk4', profiles: ['machine:prusa-mk4'], slots: 4 },
]

describe.skipIf(!existsSync(sxBin))('one project, one printer: the same G-code from the app, the MCP server and the command line', () => {
  beforeAll(async () => {
    const entries = await unzipEntries(readFileSync(join(repo, 'packages/settings/fixtures/preset-files/prusaslicer-2.9.6.3mf')))
    prusaConfig = new TextDecoder().decode(entries.get('Metadata/Slic3r_PE.config'))
  })
  for (const c of CASES) {
    it(c.name, async () => {
      const file = await c.file()
      const out = mkdtempSync(join(dir, 'case-'))
      const app = await appConfig(file, c.printer)
      const mcp = await mcpSlice(file, c.profiles, join(out, 'mcp'))
      if (c.slots) {
        // the plate prints every filament, each slot with its own color and flush row
        expect((app['filament_colour'] as string[]).length).toBe(c.slots)
        expect((app['flush_volumes_matrix'] as number[]).length % (c.slots * c.slots)).toBe(0)
        for (let t = 1; t < c.slots; t++) expect(mcp.gcode.toString()).toMatch(new RegExp(`^T${t}\\b`, 'm'))
      }
      expect(firstDifference(appSlice(mcp.request, app, join(out, 'app')), mcp.gcode)).toBeNull()
      expect(firstDifference(cliSlice(file, c.profiles, out), mcp.gcode)).toBeNull()
    }, 120_000)
  }
})
