// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab paints a design: paint.preview, paint.apply and paint.regions, the server's paint tools on the app's
// plate. A toy boat's hull built as one extruded body is painted red below the waterline and with a white band under
// its deck, and its funnel gets a black cap, each a step of the design's history. The paint shows on the plate
// object, an undo and a redo (the design's and the toolbar's) take it off and put it back, a saved project opens with
// it, and the slice prints each painted band in its filament. A scripted run drives the tools as the tab's runtime
// does.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host, MeshHandle, PilotEvent, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type PilotTool, type ScriptStep } from '@slicerx/pilot'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runReplay } from '../src/cad/history/ops'
import { readProject } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { resolveSlots } from '../src/filament/slots'
import { history } from '../src/plate/history'
import { paintedParts, sliceHandle } from '../src/plate/painted'
import { get, set } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { clearPlans } from '../src/workspaces/mimir/plan-tool'
import { tabPilotOptions, toolsFor } from '../src/workspaces/mimir/session'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-tab-paint-replies', { compressed: true, freshCache: true })

const sxBin = process.env['SLICERX_TEST_SX_BIN'] ?? ''
const dir = mkdtempSync(join(tmpdir(), 'mimir-tab-paint-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const loader = { loadParts: async (name: string): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 10, 8], openEdges: 0, parts: [] }) }
let tools = new Map<string, PilotTool<never>>()

/** One tool call as the runtime makes it: the input checked against the tool's schema, then run. */
async function call(name: string, args: Record<string, unknown>) {
  const t = tools.get(name)
  if (!t) throw new Error(`the tab has no ${name}`)
  return t.run(t.input.parse(args) as never, {} as never)
}

const fresh = () => {
  clearPlans()
  history().clear()
  set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: null, selectedIds: [], historyEdit: null, slotSetup: {}, printerSlots: [], fileSlotColors: [], fileSlotTypes: [] })
  tools = new Map(toolsFor(loader).map((t) => [t.name, t]))
}

/** The hull outline, 210 x 24 mm with a pointed bow, and its height. */
const HULL = [[-100, -12], [90, -12], [110, 0], [90, 12], [-100, 12]] as const
const HULL_H = 14
const WATERLINE = 5
const BAND = { from: 12, to: 13 }
const PERIMETER = 190 + 2 * Math.hypot(20, 12) + 190 + 24
const BOTTOM = 190 * 24 + (20 * 24) / 2
const hullShape = { type: 'sketch', loops: [{ points: HULL.map((p) => [...p]) }] }

/** The filaments: black hull and caps, white band, buff funnel, red below the waterline. */
const COLORS = { 1: '#1a1a1a', 2: '#f4f1e8', 3: '#c8a165', 4: '#b22222' } as const

interface ReadBack { totalsMm2: Record<string, number>; parts: { part: number; states: { state: number; areaMm2: number }[] }[] }
const regions = async (design: string) => (await call('paint.regions', { design })).output as ReadBack
const near = (a: number | undefined, b: number, rel = 0.02) => Math.abs((a ?? 0) - b) <= Math.abs(b) * rel

/** Builds a toy boat's hull and a funnel in one design, and paints the waterline, the band and the cap. */
async function paintedBoat() {
  const { output } = (await call('design.new', { name: 'Toy boat' })) as { output: { design: string } }
  const design = output.design
  const hull = await call('geom.extrude', { design, shape: hullShape, distance_mm: HULL_H, name: 'Hull' })
  expect(hull.ok, hull.summary).not.toBe(false)
  const funnel = await call('geom.build', { design, name: 'Funnel', slot: 3, solids: [{ type: 'cylinder', origin: [0, 0, HULL_H], axis: [0, 0, 1], diameterMm: 8, heightMm: 16 }] })
  expect(funnel.ok, funnel.summary).not.toBe(false)

  // red below the waterline on the hull: filament 4, past the project's last, which applying it adds
  const red = await call('paint.preview', { design, part: 0, state: 4, target: { kind: 'height', below: WATERLINE } })
  const redPv = red.output as { preview: string; areaMm2: number }
  expect(near(redPv.areaMm2, PERIMETER * WATERLINE + BOTTOM)).toBe(true)
  expect(get().plate[0]!.paint).toBeUndefined()
  const redOn = await call('paint.apply', { preview: redPv.preview })
  expect(redOn.ok, redOn.summary).toBe(true)
  // the funnel in filament 3 added filaments 2 and 3; the waterline adds 4
  expect(redOn.summary).toContain('so filament 4 (PLA')
  // a white band under the sheer, and a black cap on the funnel
  const band = await call('paint.preview', { design, part: 0, state: 2, target: { kind: 'height', from: BAND.from, to: BAND.to } })
  expect((await call('paint.apply', { preview: (band.output as { preview: string }).preview })).ok).toBe(true)
  const cap = await call('paint.preview', { design, part: 1, state: 1, target: { kind: 'height', above: HULL_H + 12 } })
  expect((await call('paint.apply', { preview: (cap.output as { preview: string }).preview })).ok).toBe(true)
  for (const [slot, color] of Object.entries(COLORS)) await call('project.set_filament', { slot: Number(slot), color })
  return design
}

/** Which tools extrude on each layer of `gcode`, by the layer's height. */
function toolsByLayer(gcode: string): { z: number; tools: Set<number> }[] {
  const out: { z: number; tools: Set<number> }[] = []
  let tool = 0
  let z = 0
  let layer: { z: number; tools: Set<number> } | undefined
  for (const raw of gcode.split('\n')) {
    if (raw.startsWith('; MACHINE_END_GCODE_START')) break
    const zMark = /^;\s*Z_HEIGHT:\s*([\d.]+)/.exec(raw) ?? /^;\s*Z:\s*([\d.]+)/.exec(raw)
    if (zMark) z = Number(zMark[1])
    if (raw.startsWith('; CHANGE_LAYER') || raw.startsWith(';LAYER_CHANGE')) {
      layer = { z, tools: new Set() }
      out.push(layer)
    }
    const code = raw.split(';')[0]!.trim()
    if (/^T\d+$/.test(code) && Number(code.slice(1)) < 255) tool = Number(code.slice(1))
    if (layer && zMark) layer.z = z
    if (layer && /^G[123]\b/.test(code) && /\bE([\d.]+)/.test(code) && Number(/\bE([\d.]+)/.exec(code)![1]) > 0 && /\b[XY]/.test(code)) layer.tools.add(tool)
  }
  return out
}

describe('the tab paints a design', () => {
  beforeEach(fresh)

  it('has the paint tools', () => {
    for (const n of ['paint.preview', 'paint.apply', 'paint.regions']) expect(tools.has(n)).toBe(true)
  })

  // A height band (a red bottom, a black funnel top) paints on the triangles of a design that is not strict, and is
  // refused on a strict one until the engine can split faces. mimir starts its designs by name only, so it relies on
  // design.new making a design that is not strict.
  it('starts a design that is not strict when mimir names it only, so a height band paints', async () => {
    const made = (await call('design.new', { name: 'Hull' })) as { output: { exact?: boolean } }
    expect(
      made.output.exact ?? false,
      "the mimir tab's design.new now makes a strict (exact only) design when given just a name; a height band is refused on a strict design, so mimir's paint by height (a red bottom, black funnel tops) stops working",
    ).toBe(false)
  })

  it('paints one hull body red below the waterline with a white band, and its funnel a black cap', async () => {
    const design = await paintedBoat()
    // one object, two parts in their own filaments, and the paint on the plate object the viewport and slice read
    expect(get().plate).toHaveLength(1)
    const e = get().plate[0]!
    expect(e.parts.map((p) => [p.name, p.slot])).toEqual([['Hull', 1], ['Funnel', 3]])
    expect(e.history!.steps.map((s) => s.params.op)).toEqual(['shape.extrude', 'parts.add', 'paint', 'paint', 'paint'])
    expect(Object.keys(e.paint ?? {})).toEqual(['0', '1'])
    expect(resolveSlots(get()).map((r) => r.color)).toEqual([COLORS[1], COLORS[2], COLORS[3], COLORS[4]])
    // read back: red below the waterline and the white band on the hull, the black cap on the funnel
    const back = await regions(design)
    const hull = back.parts.find((p) => p.part === 0)!.states
    expect(near(hull.find((s) => s.state === 4)?.areaMm2, PERIMETER * WATERLINE + BOTTOM)).toBe(true)
    expect(near(hull.find((s) => s.state === 2)?.areaMm2, PERIMETER * (BAND.to - BAND.from))).toBe(true)
    const cap = back.parts.find((p) => p.part === 1)!.states
    expect(near(cap.find((s) => s.state === 1)?.areaMm2, Math.PI * 8 * 4 + Math.PI * 16, 0.05)).toBe(true)
  }, 120_000)

  it('keeps the paint through undo and redo, the design tools\' and the toolbar\'s', async () => {
    const design = await paintedBoat()
    const states = () => Object.fromEntries(Object.entries(get().plate[0]!.paint ?? {}).map(([k, v]) => [k, Object.keys(v.color ?? {}).length > 0]))
    expect(states()).toEqual({ 0: true, 1: true })
    // the cap's step undone: the funnel has no paint, the hull keeps its own
    await call('design.undo', { design })
    expect(states()).toEqual({ 0: true })
    expect(Object.keys((await regions(design)).totalsMm2).sort()).toEqual(['2', '4'])
    await call('design.redo', { design })
    expect(states()).toEqual({ 0: true, 1: true })
    expect(Object.keys((await regions(design)).totalsMm2).sort()).toEqual(['1', '2', '4'])
    // the toolbar's undo takes the redo back off, and its redo puts it on again
    const painted = get().plate[0]!.paint
    expect(history().undo()).toBe(true)
    expect(states()).toEqual({ 0: true })
    expect(history().redo()).toBe(true)
    expect(get().plate[0]!.paint).toEqual(painted)
  }, 120_000)

  it('opens again from a saved project with its paint and its paint steps', async () => {
    // step ids carry the time and go into the saved file the engine reads, so a fixed clock keeps that request as recorded
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    try {
      await reopened()
    } finally {
      vi.useRealTimers()
    }
  }, 120_000)

  async function reopened() {
    await paintedBoat()
    const e = get().plate[0]!
    const bed = { widthMm: 256, depthMm: 256 }
    const p = await readProject(writeProject({ plates: [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }], bed, settings: {} }), bed)
    const back = p.plates[0]!.objects[0]!
    expect(back.paint).toEqual(e.paint)
    const h = p.histories.get(back.fileId)!
    expect(h.steps.filter((s) => s.params.op === 'paint')).toHaveLength(3)
    // a later step replays the reopened history, which paints the same
    const replayed = (await runReplay({ history: h })).parts
    expect(Object.fromEntries(replayed.flatMap((p, i) => (p.paint ? [[String(i), p.paint]] : [])))).toEqual(e.paint)
  }

  it('slices each painted band in its filament', async () => {
    await paintedBoat()
    const e = get().plate[0]!
    // what the slice loads for the object: its parts with their paint, in the raw parts format
    let bytes: ArrayBuffer | undefined
    const slicer = { loadModel: async (b: ArrayBuffer, name: string): Promise<MeshHandle> => ((bytes = b), { id: name, hash: name, name, triangles: 1, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }) }
    await sliceHandle(slicer, e)
    expect(bytes).toBeDefined()
    expect(paintedParts(e).map((p) => [p.name, p.slot, Object.keys(p.paint ?? {})])).toEqual([['Hull', 1, ['color']], ['Funnel', 3, ['color']]])
    if (!existsSync(sxBin)) return
    const mesh = join(dir, 'boat.bin')
    writeFileSync(mesh, new Uint8Array(bytes!))
    const req = join(dir, 'boat.json')
    writeFileSync(req, JSON.stringify({ schemaVersion: 1, meshes: { m: mesh }, plate: { objects: [{ id: 'm', mesh: 'm', transform: e.transform }] }, config: { filament_colour: Object.values(COLORS), layer_height: 0.2, initial_layer_print_height: 0.2, printable_area: ['0x0', '256x0', '256x256', '0x256'] }, options: { emitGcode: true } }))
    const out = join(dir, 'boat')
    execFileSync(sxBin, ['slice', '--request', req, '--out-dir', out], { stdio: 'pipe', maxBuffer: 1 << 28 })
    const gcode = readFileSync(join(out, 'slice.gcode'), 'utf8')
    if (process.env['SX_KEEP']) writeFileSync(process.env['SX_KEEP'], gcode)
    const layers = toolsByLayer(gcode)
    const at = (lo: number, hi: number) => layers.filter((l) => l.z > lo && l.z < hi)
    const tools = (lo: number, hi: number) => [...new Set(at(lo, hi).flatMap((l) => [...l.tools]))].sort()
    expect(at(0, WATERLINE - 0.3).length).toBeGreaterThan(10)
    // below the waterline the hull prints in red (filament 4); between the waterline and the band, black (filament 1)
    expect(at(0.3, WATERLINE - 0.3).every((l) => l.tools.has(3))).toBe(true)
    expect(tools(WATERLINE + 0.3, BAND.from - 0.3)).toEqual([0])
    // the band in white (filament 2) on exactly its own layers (12.2 to 13.0 mm), and the hull's top black again
    const white = layers.filter((l) => l.z < HULL_H + 0.1 && l.tools.has(1)).map((l) => Math.round(l.z * 10) / 10)
    expect(white).toEqual([12.2, 12.4, 12.6, 12.8, 13])
    expect(at(BAND.from + 0.1, BAND.to + 0.1).every((l) => !l.tools.has(3) && !l.tools.has(0))).toBe(true)
    expect(at(BAND.to + 0.1, HULL_H + 0.1).every((l) => l.tools.has(0) && !l.tools.has(1))).toBe(true)
    // the funnel in buff (filament 3) with its cap in black
    expect(tools(HULL_H + 1, HULL_H + 11)).toEqual([2])
    expect(at(HULL_H + 12.3, HULL_H + 15.7).every((l) => l.tools.has(0))).toBe(true)
  }, 300_000)
})

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

describe('a scripted toy boat hull painted in the tab', () => {
  beforeEach(fresh)

  it('builds one hull body and paints its waterline and band as the runtime runs the tools', async () => {
    const steps: ScriptStep[] = [
      { calls: [{ name: 'pilot.sheet', args: { title: 'Toy boat', dims: [{ key: 'length', label: 'Length', value: 210, unit: 'mm', source: 'asked' }] } }] },
      { calls: [{ name: 'design.new', args: { name: 'Toy boat' } }] },
      { calls: [{ name: 'geom.extrude', args: { design: 'DESIGN', shape: hullShape, distance_mm: HULL_H, name: 'Hull' } }] },
      { calls: [{ name: 'paint.preview', args: { design: 'DESIGN', state: 4, target: { kind: 'height', below: WATERLINE } } }] },
      { calls: [{ name: 'paint.apply', args: { preview: 'PREVIEW' } }] },
      { calls: [{ name: 'paint.preview', args: { design: 'DESIGN', state: 2, target: { kind: 'height', from: BAND.from, to: BAND.to } } }] },
      { calls: [{ name: 'paint.apply', args: { preview: 'PREVIEW' } }] },
      { calls: [{ name: 'project.set_filament', args: { slot: 1, color: COLORS[1] } }, { name: 'project.set_filament', args: { slot: 2, color: COLORS[2] } }, { name: 'project.set_filament', args: { slot: 4, color: COLORS[4] } }] },
      { calls: [{ name: 'paint.regions', args: { design: 'DESIGN' } }] },
      { text: 'Your hull is one part: red below the waterline, black above, with a white band under the deck.' },
    ]
    // the design id design.new answered with goes into the later calls, as a model reads it from the reply
    const designIn = (m: unknown): string => /design\\*"\s*:\s*\\*"([\w~-]+)/.exec(JSON.stringify(m))?.[1] ?? ''
    // and the preview id the last preview answered with into its apply
    const previewIn = (m: unknown): string => [...JSON.stringify(m).matchAll(/preview\\*"\s*:\s*\\*"(p\d+)/g)].at(-1)?.[1] ?? ''
    const withDesign = (calls: { name: string; args: Record<string, unknown> }[], m: unknown) => calls.map((c) => ({ ...c, args: JSON.parse(JSON.stringify(c.args).replaceAll('"DESIGN"', JSON.stringify(designIn(m))).replaceAll('"PREVIEW"', JSON.stringify(previewIn(m)))) as Record<string, unknown> }))
    const script = steps.map((s) => (typeof s === 'function' || !('calls' in s) ? s : (m: unknown) => ({ calls: withDesign(s.calls as { name: string; args: Record<string, unknown> }[], m) }))) as ScriptStep[]
    const slicer = { loadModel: async () => Promise.reject(new Error('not here')), loadParts: loader.loadParts, slice: async () => Promise.reject(new Error('not here')) }
    const host = { kind: 'web', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
    const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: toolsFor(loader), commands: [] })
    const pilot = createPilot({ ...options, client: createScriptedClient(script, { chunk: false }) })
    const names = new Map<string, string>()
    const results: { tool: string; ok: boolean; summary: string }[] = []
    for await (const e of pilot.run('tab', 'make a toy boat hull, red below the waterline, black above, with a white band', {}) as AsyncIterable<PilotEvent>) {
      if (e.type === 'sheet') void pilot.answerSheet!(e.sheet.id, {})
      if (e.type === 'approval_request') await pilot.resolveApproval(e.request.id, { kind: 'approve' })
      if (e.type === 'tool_call') names.set(e.callId, e.tool)
      if (e.type === 'tool_result') results.push({ tool: names.get(e.callId) ?? '', ok: e.ok, summary: e.summary })
    }
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.map((r) => r.tool)).toEqual(['pilot.sheet', 'design.new', 'geom.extrude', 'paint.preview', 'paint.apply', 'paint.preview', 'paint.apply', 'project.set_filament', 'project.set_filament', 'project.set_filament', 'paint.regions'])
    // filament 4 came with the waterline paint, which the person never had to ask for
    expect(results[4]!.summary).toContain('were added with the default color')
    expect(get().plate).toHaveLength(1)
    expect(get().plate[0]!.parts).toHaveLength(1)
    expect(results[10]!.summary).toMatch(/state 2 [\d.]+ mm2, state 4 [\d.]+ mm2/)
    expect(resolveSlots(get()).map((r) => r.color)).toEqual([COLORS[1], COLORS[2], expect.any(String), COLORS[4]])
  }, 120_000)
})
