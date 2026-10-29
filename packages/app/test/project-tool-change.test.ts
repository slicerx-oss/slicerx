// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tool change a project plans at a height (Metadata/custom_gcode_per_layer.xml type 2, a filament change on a plate of
// one filament) opens as a mark on the layer slider and goes to the engine as `toolChanges`.
// One saved under another mode than the one-filament mode is kept for the file but not sent, and the slice notes it
// with the engine's tool_change_skipped code. The projects are the engine's own fixtures
// (packages/core/cli/tests/fixtures/layer-tool-change): a 20 x 20 x 10 mm box on filament 2 of an A1 with a change at
// 5 mm to filament 4. The real slice runs where sx (cargo build -p sx-cli --release) is built.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { createFakeSlicer } from '../../core/web/src/fake'

const { openModelBytes, slicePlate } = await import('../src/state/actions')
const { profileReady, startProfileSync } = await import('../src/state/profile-sync')
const { startProjectPrinterSync } = await import('../src/project/project-printer')
const { get, set } = await import('../src/state/store')
const { resolveSlots, usedSlots } = await import('../src/filament/slots')
const { slotUsage } = await import('../src/filament/rail')
const { sendToPrinter } = await import('../src/state/send-actions')

const fixtures = resolve(__dirname, '../../core/cli/tests/fixtures/layer-tool-change')
const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? resolve(__dirname, '../../../target/release/sx')
const dir = mkdtempSync(join(tmpdir(), 'project-tool-change-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** Waits for the printer layer the store writes ask for, and the ones those builds start in turn. */
async function settled(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30))
    await profileReady()
  }
}

/** Opens `case`.3mf on a fresh plate with an A1 selected and slices it with the stand-in engine: the request the app sent. */
async function openAndSlice(name: string): Promise<SliceRequest> {
  const fake = createFakeSlicer({ delayMs: 0, layers: 50 })
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { ...fake, slice: (r: SliceRequest, o?: never) => (requests.push(r), fake.slice(r, o)) } } as unknown as Host
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', layerMarks: {}, printerSlots: [], slotSetup: {}, printSheet: null, calibration: {}, resume: null, slice: { status: 'idle' }, projectSettings: null, projectPrinter: null, projectOpenAsk: null, fileSlotColors: [], printerId: 'my-a1', printerModel: { id: 'my-a1', vendor: 'Bambu Lab', model: 'A1' }, printerNozzles: {}, nozzleReported: {}, easyTouched: [], goal: 'standard', goalBase: 'standard', overrides: {}, vouchedGcode: {}, toast: null }))
  startProfileSync()
  startProjectPrinterSync()
  await settled()
  const file = join(fixtures, `${name}.3mf`)
  await openModelBytes(host, basename(file), buf(readFileSync(file)), undefined, { fresh: true })
  await settled()
  await slicePlate(host)
  await vi.waitFor(() => expect(get().slice.status).toBe('done'), { timeout: 30_000 })
  return requests[requests.length - 1]!
}

/** The layer (1-based), tool and `M620 S<n>A` block of each tool command between the first layer change and the machine end G-code. */
function changes(gcode: string): [number, number, number | null][] {
  const out: [number, number, number | null][] = []
  let layer = 0
  let wrap: number | null = null
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; CHANGE_LAYER')) layer++
    if (line.startsWith('; MACHINE_END_GCODE_START')) break
    const code = line.split(';')[0]!.trim()
    const m620 = /^M620 S(\d+)A?$/.exec(code)
    if (m620) wrap = Number(m620[1])
    else if (/^M621 S\d+A?$/.test(code)) wrap = null
    else if (layer > 0 && /^T\d+$/.test(code) && Number(code.slice(1)) < 255) out.push([layer, Number(code.slice(1)), wrap])
  }
  return out
}

describe('a project tool change in the app', () => {
  it('opens on the slider and slices as one change inside the change G-code on its layer', { timeout: 120_000 }, async () => {
    const req = await openAndSlice('a1-cc')
    expect(get().layerMarks['plate-1']!.map(({ z, kind, slot, skip }) => ({ z, kind, slot, skip }))).toEqual([{ z: 5, kind: 'tool_change', slot: 4, skip: undefined }])
    expect(req.options?.toolChanges).toEqual([{ zMm: 5, filament: 4 }])
    expect(req.options?.layerGcode ?? []).toEqual([])
    const done = get().slice
    expect(done.status === 'done' && done.result.warnings.filter((w) => w.code === 'tool_change_skipped')).toEqual([])
    if (!existsSync(sxBin)) return
    // The app's settings and tool changes, on the project's own plate; `toolChanges` keeps sx from reading the file's.
    const path = join(dir, 'a1-cc.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, meshes: { m: `${join(fixtures, 'a1-cc.3mf')}#1` }, plate: { objects: [{ id: 'm', mesh: 'm' }] }, config: req.config, options: { emitGcode: true, toolChanges: req.options?.toolChanges ?? [] } }))
    const out = join(dir, 'a1-cc')
    execFileSync(sxBin, ['slice', '--request', path, '--out-dir', out], { stdio: 'pipe' })
    expect(changes(readFileSync(join(out, 'slice.gcode'), 'utf8'))).toEqual([[25, 3, 3]])
  })

  it('counts the filament it changes to among the plate\'s filaments', { timeout: 120_000 }, async () => {
    await openAndSlice('a1-cc')
    // The box is on filament 2 and the change goes to filament 4: the plate prints both, and filament 4 has a slot.
    expect(resolveSlots(get()).map((r) => [r.index, r.used])).toEqual([[1, false], [2, true], [3, false], [4, true]])
    expect([...usedSlots(get())].sort()).toEqual([2, 4])
  })

  it.skipIf(!existsSync(sxBin))('shows the use of the filament it changes to', { timeout: 120_000 }, async () => {
    const req = await openAndSlice('a1-cc')
    {
      // The rail's use per slot reads the engine's grams for every slot up to the last, filament 4's too.
      const path = join(dir, 'a1-cc-use.json')
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, meshes: { m: `${join(fixtures, 'a1-cc.3mf')}#1` }, plate: { objects: [{ id: 'm', mesh: 'm' }] }, config: req.config, options: { toolChanges: req.options?.toolChanges ?? [] } }))
      const report = JSON.parse(execFileSync(sxBin, ['slice', '--request', path], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()) as { stats: { filamentG: number[] } }
      const g = report.stats.filamentG
      expect(g[3]).toBeGreaterThan(0)
      const use = slotUsage({ filamentG: g }, Math.max(...resolveSlots(get()).map((r) => r.index)))
      expect(use).toHaveLength(4)
      expect(use[3]!.grams).toBe(g[3])
    }
  })

  it('asks where the filament it changes to goes when the plate is sent', { timeout: 120_000 }, async () => {
    await openAndSlice('a1-cc')
    // A send asks where each filament the plate prints goes, filament 4 included.
    set({ printerSlots: [1, 2, 3, 4].map((n) => ({ id: `A${n}`, material: 'PLA', color: '#808080' })) })
    const printer = { id: 'p1', name: 'Bay 1', vendor: 'Test', model: 'T1', plugin: 'demo', nozzleCount: 1 } as never
    const host = { kind: 'web', printers: { status: async () => ({ state: 'idle' }) }, approvals: {}, slicer: { exportGcode: async () => ({ fileName: 'x.gcode', bytes: 1, sha256: '', blob: new Blob(['G28']) }) } } as unknown as Host
    const sent = sendToPrinter(host, printer)
    await vi.waitFor(() => expect(get().printSheet).not.toBeNull(), { timeout: 45_000 })
    const sheet = get().printSheet!
    expect(sheet.filaments.map((f) => f.index)).toEqual([2, 4])
    expect(sheet.auto).toEqual({ 2: 'A2', 4: 'A4' })
    sheet.resolve(null)
    await sent
  })

  it('keeps one saved for a plate of several filaments, sends none and notes it', { timeout: 120_000 }, async () => {
    const req = await openAndSlice('a1-ccmulti')
    expect(get().layerMarks['plate-1']!.map(({ z, kind, slot, skip }) => ({ z, kind, slot, skip }))).toEqual([{ z: 5, kind: 'tool_change', slot: 4, skip: 'the project saved it for a plate that prints several filaments' }])
    expect(req.options?.toolChanges).toBeUndefined()
    const s = get().slice
    expect(s.status === 'done' && s.result.warnings.filter((w) => w.code === 'tool_change_skipped')).toEqual([
      { code: 'tool_change_skipped', message: 'Tool change at 5 mm to filament 4 skipped: the project saved it for a plate that prints several filaments.' },
    ])
  })

  it('is written back under the mode it applies in', async () => {
    const { writeProject, projectFiles } = await import('../src/export/threemf')
    const { readProject } = await import('../src/export/import3mf')
    const { boxMesh } = await import('../src/plate/mesh-ops')
    const { compose } = await import('../src/plate/transform')
    const entry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 2 }], colors: ['#fff'], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) } as never
    const bed = { widthMm: 256, depthMm: 256 }
    const plate = (id: string) => ({ id, name: id, objects: [entry], settings: { sequence: 'by-layer' as const } })
    const input = {
      plates: [plate('p1'), plate('p2')],
      bed,
      settings: {},
      layerMarks: { 0: [{ z: 2, kind: 'pause' as const }, { z: 5, kind: 'tool_change' as const, slot: 4 }], 1: [{ z: 5, kind: 'tool_change' as const, slot: 3, skipped: true }] },
    }
    const xml = String(projectFiles(input).find((f) => f.name === 'Metadata/custom_gcode_per_layer.xml')!.data)
    expect(xml).toContain('top_z="5" type="2" extruder="4"')
    expect(xml.match(/<mode value="(\w+)"\/>/g)).toEqual(['<mode value="MultiAsSingle"/>', '<mode value="MultiExtruder"/>'])
    const read = await readProject(writeProject(input), bed)
    expect(read.plates.map((p) => p.marks)).toEqual([
      [{ z: 2, kind: 'pause' }, { z: 5, kind: 'tool_change', slot: 4 }],
      [{ z: 5, kind: 'tool_change', slot: 3, skip: 'the project saved it for a plate that prints several filaments' }],
    ])
  })
})
