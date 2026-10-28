// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One project on one printer gives the same G-code through the app, the MCP server and the command line. The app's
// side is its real project open (the printer's layer, then the project's settings) and the config it slices with; the
// MCP server's is slicerx_slice_file with the printer's machine profile; the command line's is sx call slice_file. The
// app's config goes to sx in the MCP server's own request, so only the settings differ between them, and the G-code
// must match to the byte. Runs where sx (cargo build -p sx-cli --release) is built; the command line route also needs
// the MCP server's runtime (node packages/mcp/scripts/build.mjs).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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

const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const runtime = resolve(__dirname, '../../mcp/dist/cli.js')
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

/** sx call slice_file: the command line's route to the same tool. */
function cliSlice(file: string, profiles: string[], out: string): Buffer {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('SLICERX_'))), HOME: out, USERPROFILE: out, SLICERX_NODE_BIN: process.execPath, SLICERX_MCP_CLI: runtime } as Record<string, string>
  const args = ['call', '--no-app', '--printers', 'off', '--out-dir', join(out, 'out'), '--allow-dir', dirname(file), 'slice_file', JSON.stringify({ model: file, plate: 1, profiles, project_settings: true })]
  const line = JSON.parse(execFileSync(sxBin, args, { env, cwd: out, stdio: 'pipe' }).toString().trim().split('\n').pop()!) as { ok: boolean; output: { gcode_path?: string } }
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

const CASES: { name: string; file: () => Promise<string> | string; printer: keyof typeof PRINTERS; profiles: string[] }[] = [
  { name: 'a PrusaSlicer project on the MK4', file: () => join(repo, 'packages/settings/fixtures/preset-files/prusaslicer-2.9.6.3mf'), printer: 'prusa-mk4', profiles: ['machine:prusa-mk4'] },
  { name: 'an Orca project on the A1', file: () => join(repo, 'packages/geom/tests/corpus/orca-subtypes.3mf'), printer: 'bambu-a1', profiles: ['machine:bambu-a1'] },
  { name: 'a Bambu Studio project on the A1', file: () => join(repo, 'packages/geom/tests/corpus/bambu-subtypes.3mf'), printer: 'bambu-a1', profiles: ['machine:bambu-a1'] },
  // The app opens the project on the printer it names, from another printer; the MCP server names that printer.
  { name: 'a Bambu Studio project on the printer it names', file: namedA1Project, printer: 'prusa-mk4', profiles: ['machine:bambu-a1'] },
]

describe.skipIf(!existsSync(sxBin))('one project, one printer: the same G-code from the app, the MCP server and the command line', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const file = await c.file()
      const out = mkdtempSync(join(dir, 'case-'))
      const app = await appConfig(file, c.printer)
      const mcp = await mcpSlice(file, c.profiles, join(out, 'mcp'))
      expect(firstDifference(appSlice(mcp.request, app, join(out, 'app')), mcp.gcode)).toBeNull()
      if (existsSync(runtime)) expect(firstDifference(cliSlice(file, c.profiles, out), mcp.gcode)).toBeNull()
    }, 120_000)
  }
})
