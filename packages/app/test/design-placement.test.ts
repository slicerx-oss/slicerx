// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A landing moves a design as a whole. Its timeline sketches and recorded steps stay in plate coordinates, and the
// design tools give and read points in the design's own frame: the plate transform less the landing moves, which the
// design's history keeps (History.placed) and a project saves. A sketch read for a design is converted by the move of
// the body that owns it and by that design's landing, and a step that draws on a shared sketch is stored so the sketch
// keeps its frame. Runs the tools on the app's design host against the geometry engine (live wasm when built,
// recorded replies otherwise), with the replay cache cleared before each test so no test leans on another's replays.
import { clearReplayCache, historyOf, type Design, type DesignHost, type FaceFrame, type SketchItem, type Step } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { designToolset } from '@slicerx/mcp/toolset'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyExtrude } from '../src/cad/cad-ops'
import { appDesignHost } from '../src/cad/design-host'
import { runReplay, toPart } from '../src/cad/history/ops'
import { rollTo } from '../src/cad/history/rollback'
import { finishSketch } from '../src/cad/sketches'
import { geom, setGeomProvider } from '../src/geom/client'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { NO_MARGINS, printsOnBed, setMarginSource } from '../src/plate/arrange'
import { copySelection, pasteClipboard } from '../src/plate/clipboard'
import { setInstanceCount } from '../src/plate/edit'
import { createHistory } from '../src/plate/history'
import { heldBodies, startTimeline } from '../src/plate/timeline'
import { bounds } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'
import { sketchScene } from '../src/workspaces/design/finished-sketches'
import { useGeomEngine } from './geom-engine'

useGeomEngine('design-placement-replies', { compressed: true })

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
const BED = { widthMm: 256, depthMm: 256, heightMm: 256 }
// rounded to 0.01 mm, -0 read as 0
const r2 = (v: number) => Math.round(v * 100) / 100 + 0

type Reply = { ok: boolean; summary: string; output: Record<string, unknown> }

/** The design tools on `host`, run as a client calls them: parsed input, the reply or the thrown refusal. */
function toolsOn(host: DesignHost) {
  const tools = new Map(designToolset(host, {}, {}).map((t) => [t.name, t]))
  return async (name: string, input: Record<string, unknown>): Promise<Reply> => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const out = await tool.run(tool.input.parse(input) as never, {} as never)
    return { ok: out.ok !== false, summary: out.summary, output: out.output as Record<string, unknown> }
  }
}

const entry = (id: string): PlateEntry => get().plate.find((p) => p.id === id)!
/** Where an object stands on the plate: its bounds there, rounded. */
const onPlate = (id: string) => {
  const b = bounds(entry(id).parts, entry(id).transform)!
  return { min: b.min.map(r2), max: b.max.map(r2) }
}
function volume(parts: readonly Pick<MeshPart, 'positions' | 'indices'>[]): number {
  let v = 0
  for (const m of parts) {
    const p = m.positions
    for (let k = 0; k + 2 < m.indices.length; k += 3) {
      const [a, b, c] = [3 * m.indices[k]!, 3 * m.indices[k + 1]!, 3 * m.indices[k + 2]!]
      v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
    }
  }
  return Math.abs(v)
}
const sketchItem = (id: string): SketchItem => get().timeline.items.find((i): i is SketchItem => i.kind === 'sketch' && i.id === id)!
const at = (d: Design) => [r2(d.transform[12]!), r2(d.transform[13]!)]

/** A 20 by 20 mm block 10 mm tall, built around the origin: it lands at the bed's middle. */
const block = { shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, distance_mm: 10 }
/** A square hole 6 mm across from the top of that block, `depth` mm down, at (x, y) in the design's frame. */
const hole = (design: string, x = 0, y = 0, depth = 4) => ({ design, shape: { type: 'rectangle', widthMm: 6, heightMm: 6 }, frame: { origin: [x, y, 10], normal: [0, 0, 1] }, distance_mm: depth, operation: 'cut' })
const BLOCK_MM3 = 20 * 20 * 10
const holeMm3 = (depth: number) => 36 * depth
/** A square `d` mm across around (x, y), as sketch loops: square holes keep the recorded meshes small. */
const square = (x: number, y: number, d: number) => [{ points: [[x - d / 2, y - d / 2], [x + d / 2, y - d / 2], [x + d / 2, y + d / 2], [x - d / 2, y + d / 2]] }]
/**
 * A planter and its saucer, as octagons 135 and 145 mm across their corners (124.7 and 134 mm across their flats): side
 * by side as boxes they come to more than the 256 mm bed, so a saucer landing beside a planter in the bed's middle
 * needs the planter moved over, corner to corner. Octagons keep the recorded meshes small.
 */
const pot = (d: number) => ({ type: 'polygon', sides: 8, diameterMm: d })
const PLANTER = pot(135)
const SAUCER = pot(145)
/** Their sides' distance from the middle: two octagons whose middles are closer than the sum overlap. */
const flat = (d: number) => (d / 2) * Math.cos(Math.PI / 8)

let stop: (() => void) | null = null
beforeEach(() => {
  clearReplayCache()
  appStore.setState({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', selection: null, selectedIds: [], historyEdit: null, rollback: null, timeline: { bodies: [], items: [], marker: 0 }, bed: { ...get().bed, ...BED } })
  stop = startTimeline()
})
afterEach(() => {
  stop?.()
  stop = null
  setMarginSource(() => NO_MARGINS)
})

/** A block built around the origin, landed in the middle of the bed: its design id. */
async function landedBlock(run: ReturnType<typeof toolsOn>, name = 'Block'): Promise<string> {
  const d = String((await run('design.new', { name })).output['design'])
  const made = await run('geom.extrude', { design: d, ...block })
  expect(made.summary).toMatch(/moved to the plate by \(128, 128\) mm/)
  return d
}

describe('a landed design keeps its own frame', () => {
  it('reads and takes points in the frame it was built in, and keeps the landing in its history', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 10] })
    expect(at(host.get(d))).toEqual([0, 0])
    expect(entry(d).history?.placed).toEqual([128, 128])
    // the hole, given at the design's origin, goes through the top of the block where the plate shows it
    const cut = await run('geom.extrude', hole(d))
    expect(cut.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
    // stored in plate coordinates: the step stands where the object stood and names the plate's spot
    const s = entry(d).history!.steps.at(-1)!
    expect([s.transform[12], s.transform[13]]).toEqual([128, 128])
    expect(s.params.op === 'shape.extrude' && s.params.frame?.origin).toEqual([128, 128, 10])
  })

  it('opens a saved design with its landing, and a step after the open still meets the body', async () => {
    const run = toolsOn(appDesignHost(loader))
    const d = await landedBlock(run)
    await run('geom.extrude', hole(d, -5, 0))
    const was = { plate: onPlate(d), volume: volume(entry(d).parts) }
    const bed = { widthMm: 256, depthMm: 256 }
    const s = get()
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: s.plate, settings: {} }], bed, settings: {}, timeline: s.timeline })
    // read by the TypeScript reader: the file's bytes hold step ids made from the clock, which no recording can match
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    // the project opens onto an empty plate the way the app opens one: objects with their histories, and the timeline
    const o = p.plates[0]!.objects[0]!
    const history = p.histories.get(o.fileId)
    expect(history?.placed).toEqual([128, 128])
    const { withBodyIds } = await import('@slicerx/cad-history')
    stop?.()
    appStore.setState({ plate: [{ id: 'opened', name: o.name, handle: handle('opened'), parts: o.parts, colors: ['#bd93f9'], transform: o.transform, history: history! }], timeline: withBodyIds(p.timeline!, (f) => (f === o.fileId ? 'opened' : undefined)) })
    stop = startTimeline()
    expect(onPlate('opened')).toEqual(was.plate)
    // a reopened design on a new host keeps writing in the frame it was built in
    const host = appDesignHost(loader)
    const again = toolsOn(host)
    expect(at(host.get('opened'))).toEqual([0, 0])
    const listed = (await again('design.list', {})).output['designs'] as { design: string; minMm: number[] }[]
    expect(listed.find((x) => x.design === 'opened')?.minMm.map(r2)).toEqual([-10, -10, 0])
    const cut = await again('geom.extrude', hole('opened', 5, 0))
    expect(cut.ok).toBe(true)
    expect(volume(entry('opened').parts)).toBeCloseTo(was.volume - holeMm3(4), 0)
    expect(onPlate('opened')).toEqual(was.plate)
  })

  it('undoes and redoes the landing without moving the design twice', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    await run('design.undo', { design: d })
    expect(get().plate).toHaveLength(0)
    const back = await run('design.redo', { design: d })
    expect(back.ok).toBe(true)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 10] })
    expect(entry(d).history?.placed).toEqual([128, 128])
    expect(at(host.get(d))).toEqual([0, 0])
    const cut = await run('geom.extrude', hole(d))
    expect(cut.ok).toBe(true)
    // the plate's own undo takes the step back with the object as it stood, landing kept; redo brings both back
    const undo = createHistory(appStore)
    try {
      await run('geom.extrude', hole(d, 5, 5, 2))
      const after = { transform: entry(d).transform, placed: entry(d).history?.placed, steps: entry(d).history?.steps.length }
      undo.undo()
      expect(entry(d).history?.steps).toHaveLength(after.steps! - 1)
      expect(entry(d).history?.placed).toEqual([128, 128])
      undo.redo()
      expect({ transform: entry(d).transform, placed: entry(d).history?.placed, steps: entry(d).history?.steps.length }).toEqual(after)
    } finally {
      undo.dispose()
    }
  })

  it('takes back an edit that landed the part again and its move in one plate undo', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const undo = createHistory(appStore)
    try {
      // a tab out past the bed's right edge, given in the design's frame: the part lands again, as a whole
      const tab = await run('geom.extrude', { design: d, shape: { type: 'rectangle', widthMm: 140, heightMm: 20 }, placement: { center: [70, 0] }, distance_mm: 10, operation: 'join', part: 0 })
      expect(tab.summary).toMatch(/did not fit on the bed where it stood, so it moved by \(-65, 0\) mm/)
      expect(entry(d).history?.placed).toEqual([63, 128])
      expect(at(host.get(d))).toEqual([0, 0])
      undo.undo()
      expect(entry(d).history?.placed).toEqual([128, 128])
      expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 10] })
      undo.redo()
      expect(entry(d).history?.placed).toEqual([63, 128])
      expect(at(host.get(d))).toEqual([0, 0])
    } finally {
      undo.dispose()
    }
  })

  it('stays on the body when a person moves the landed part, then mimir edits it', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    // the person drags it 20 mm right and 10 mm toward the front
    const t = [...entry(d).transform]
    t[12] = t[12]! + 20
    t[13] = t[13]! - 10
    set((s) => ({ plate: s.plate.map((e) => (e.id === d ? { ...e, transform: t } : e)) }))
    expect(at(host.get(d))).toEqual([20, -10])
    // read back, the body is where the design's frame says, and a hole there goes through it
    const listed = (await run('design.list', {})).output['designs'] as { design: string; minMm: number[] }[]
    expect(listed.find((x) => x.design === d)?.minMm.map(r2)).toEqual([10, -20, 0])
    const cut = await run('geom.extrude', hole(d, 20, -10))
    expect(cut.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
    expect(onPlate(d)).toEqual({ min: [138, 108, 0], max: [158, 128, 10] })
  })
})

describe('timeline sketches after a landing', () => {
  const ring = (d: number) => square(0, 0, d)

  it('reads a sketch drawn in the design frame the same way every time it is used', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(6) })).output['id'])
    // stored in plate coordinates, read in the design's
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
    expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
    const first = await run('geom.extrude', { design: d, sketch: k, distance_mm: 3, operation: 'cut' })
    expect(first.ok).toBe(true)
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
    expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
    // the same sketch again, deeper: still on the body, and the sketch has not moved
    const second = await run('geom.extrude', { design: d, sketch: k, distance_mm: 6, operation: 'cut' })
    expect(second.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(6), 0)
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
    expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
  })

  it('reads a sketch split out of a step after the landing in the design frame', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    // a cut drawn as loops: the timeline keeps its sketch as an item of its own, in plate coordinates
    const cut = await run('geom.extrude', { design: d, shape: { type: 'sketch', loops: ring(6) }, frame: { origin: [4, 4, 10], normal: [0, 0, 1] }, distance_mm: 3, operation: 'cut' })
    expect(cut.ok).toBe(true)
    const step = entry(d).history!.steps.at(-1)!
    const split = get().timeline.items.find((i): i is SketchItem => i.kind === 'sketch' && i.id.startsWith(step.id))!
    expect(split.frame?.origin).toEqual([132, 132, 10])
    expect(host.sketch!(split.id, d).frame?.origin).toEqual([4, 4, 10])
    // used again for a deeper cut: on the body
    const again = await run('geom.extrude', { design: d, sketch: split.id, distance_mm: 6, operation: 'cut' })
    expect(again.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(6), 0)
    expect(sketchItem(split.id).frame?.origin).toEqual([132, 132, 10])
  })

  it('keeps a sketch drawn for a landed design while another design waits where it was drawn', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const waiting = String((await run('design.new', { name: 'Peg' })).output['design'])
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(6) })).output['id'])
    // the waiting design's first body lands; the sketch is the block's, so it stays
    const peg = await run('geom.extrude', { design: waiting, shape: { type: 'rectangle', widthMm: 8, heightMm: 8 }, distance_mm: 5 })
    expect(peg.summary).toMatch(/moved to the plate/)
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
    const cut = await run('geom.extrude', { design: d, sketch: k, distance_mm: 3, operation: 'cut' })
    expect(cut.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(3), 0)
  })

  it('reads a sketch the same through both design hosts, the app link and the mimir tab', async () => {
    const tab = appDesignHost(loader)
    const link = appDesignHost(loader)
    const d = await landedBlock(toolsOn(tab))
    // drawn through the link for the block, used through the tab, read back through both
    const k = String((await toolsOn(link)('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(6) })).output['id'])
    expect(link.sketch!(k, d)).toEqual(tab.sketch!(k, d))
    expect(tab.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
    const cut = await toolsOn(tab)('geom.extrude', { design: d, sketch: k, distance_mm: 3, operation: 'cut' })
    expect(cut.ok).toBe(true)
    expect(link.sketch!(k, d)).toEqual(tab.sketch!(k, d))
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
  })

  it('leaves a person\'s feature on a shared sketch where it was when mimir draws on the sketch too', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    // the person's own part at the left of the bed, and Sketch 1 across both parts in plate coordinates
    const own = String((await run('design.new', { name: 'Bar' })).output['design'])
    await run('geom.extrude', { design: own, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [50, 128] }, distance_mm: 10 })
    expect(onPlate(own)).toEqual({ min: [30, 118, 0], max: [70, 138, 10] })
    // drawn in the sketch tool, so in the plate's coordinates and for no design
    const k = finishSketch({ frame: { origin: [94, 128, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [{ points: [[-80, -2], [80, -2], [80, 2], [-80, 2]] }] }).id
    await run('geom.extrude', { design: own, sketch: k, distance_mm: 2, operation: 'cut' })
    const frame = structuredClone(sketchItem(k).frame)
    const ownStep = structuredClone(entry(own).history!.steps.at(-1)!)
    const ownVolume = volume(entry(own).parts)
    // mimir reads it in the landed block's frame: 128 mm back from the plate's
    expect(host.sketch!(k, d).frame?.origin).toEqual([-34, 0, 10])
    const cut = await run('geom.extrude', { design: d, sketch: k, distance_mm: 2, operation: 'cut' })
    expect(cut.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - 20 * 4 * 2, 0)
    // the sketch and the person's feature on it have not moved
    expect(sketchItem(k).frame).toEqual(frame)
    expect(entry(own).history!.steps.at(-1)!.params).toEqual(ownStep.params)
    expect(volume(entry(own).parts)).toBeCloseTo(ownVolume, 3)
    expect(host.sketch!(k, d).frame?.origin).toEqual([-34, 0, 10])
  })
})

describe('a second design that needs room', () => {
  it('lands a 145 mm saucer beside a 135 mm planter, moving the planter over, and says where both went', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    expect((await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })).summary).toMatch(/moved to the plate by \(128, 128\) mm/)
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    const made = await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })
    expect(made.ok).toBe(true)
    expect(made.summary).not.toMatch(/does not fit/)
    expect(made.summary).toMatch(/moved to the plate by/)
    expect(made.summary).toMatch(/Planter moved by \(-?\d+(\.\d+)?, -?\d+(\.\d+)?\) mm to make room/)
    // both print where they stand, apart
    expectApart(planter, saucer)
    // each keeps its own frame: the planter's move is a landing too, so a hole at its origin still meets it
    expect(at(host.get(planter))).toEqual([0, 0])
    expect(at(host.get(saucer))).toEqual([0, 0])
    const drain = await run('geom.extrude', { design: planter, shape: { type: 'rectangle', widthMm: 8, heightMm: 8 }, frame: { origin: [0, 0, 0], normal: [0, 0, -1] }, distance_mm: 5, operation: 'cut' })
    expect(drain.ok).toBe(true)
  })
})

/** The planter and the saucer both print where they stand, and their middles are far enough apart that they do not overlap. */
function expectApart(planter: string, saucer: string): void {
  expect(printsOnBed(entry(planter), get().bed)).toBe(true)
  expect(printsOnBed(entry(saucer), get().bed)).toBe(true)
  const center = (id: string) => {
    const b = onPlate(id)
    return [(b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2]
  }
  const [p, s] = [center(planter), center(saucer)]
  expect(Math.hypot(p[0]! - s[0]!, p[1]! - s[1]!)).toBeGreaterThanOrEqual(flat(135) + flat(145))
}

/** Moves object `id` on the plate by (dx, dy) mm, as a person drags it. */
function drag(id: string, dx: number, dy: number): void {
  set((s) => ({ plate: s.plate.map((e) => (e.id === id ? { ...e, transform: e.transform.map((v, i) => (i === 12 ? v + dx : i === 13 ? v + dy : v)) } : e)) }))
}
const projected = (k: SketchItem, p: string) => k.loops.filter((l) => (l as { projected?: string }).projected === p)

type ProjectRequest = { parts: { mesh: { positions: number[] }; transform: number[] }[]; frame: { origin: number[]; u: number[]; v: number[] }; source: { kind: string; part?: number; face?: { at: number[]; normal: number[] }; edges?: { a: number[]; b: number[] }[] } }

/**
 * The engine's sketch.project for the flat, axis-aligned faces and edge loops these tests project, used when the engine
 * the replies were recorded with predates the operation: the rectangle around the face, or around the edges, seen
 * along the sketch normal, in the sketch's plane. An engine that has the operation answers it itself.
 */
function projectionFallback(): void {
  const inner = geom()
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  const rect = (req: ProjectRequest) => {
    const part = req.parts[req.source.part ?? 0]!
    const t = part.transform
    const world = (p: number[]) => [0, 1, 2].map((k) => t[k]! * p[0]! + t[4 + k]! * p[1]! + t[8 + k]! * p[2]! + t[12 + k]!)
    const pts: number[][] = []
    if (req.source.kind === 'face') {
      const f = req.source.face!
      const pos = part.mesh.positions
      for (let i = 0; i + 2 < pos.length; i += 3) {
        const p = [pos[i]!, pos[i + 1]!, pos[i + 2]!]
        if (Math.abs(dot([p[0]! - f.at[0]!, p[1]! - f.at[1]!, p[2]! - f.at[2]!], f.normal)) < 1e-6) pts.push(p)
      }
    } else for (const e of req.source.edges ?? []) pts.push(e.a, e.b)
    const { origin: o, u, v } = req.frame
    const uv = pts.map(world).map((p) => [p[0]! - o[0]!, p[1]! - o[1]!, p[2]! - o[2]!]).map((d) => [dot(d, u), dot(d, v)].map((x) => Math.round(x * 1e6) / 1e6 + 0))
    const [u0, u1] = [Math.min(...uv.map((q) => q[0]!)), Math.max(...uv.map((q) => q[0]!))]
    const [v0, v1] = [Math.min(...uv.map((q) => q[1]!)), Math.max(...uv.map((q) => q[1]!))]
    return { loops: [{ points: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] }] }
  }
  setGeomProvider({
    async call<T>(op: string, req: unknown, signal?: AbortSignal): Promise<T> {
      try {
        return await inner.call<T>(op, req, signal)
      } catch (e) {
        if (op !== 'sketch.project' || !(e instanceof Error) || !/unknown operation/i.test(e.message)) throw e
        return rect(req as ProjectRequest) as T
      }
    },
  })
}

describe('projections into a sketch that moved with its design', () => {
  it('projects a landed design into a sketch a later landed design owns, and an extrude from it meets the projected place', { timeout: 60_000 }, async () => {
    projectionFallback()
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const x = await landedBlock(run, 'Base')
    // a sketch on the bed for a design that waits; its first extrude owns it, and that design then lands beside the base
    const w = String((await run('design.new', { name: 'Tray' })).output['design'])
    const k = String((await run('design.sketch', { design: w, loops: [{ points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] }] })).output['id'])
    const made = await run('geom.extrude', { design: w, sketch: k, distance_mm: 5 })
    expect(made.summary).toMatch(/moved to the plate by/)
    const tray = onPlate(w)
    expect(tray.min[0]).not.toBe(118)
    // the base's top face, given in the base's frame, projected as real curves: they stand under the base on the plate
    const p = await run('design.sketch_project', { sketch: k, design: x, kind: 'face', face: { at: [0, 0, 10], normal: [0, 0, 1] }, mode: 'real' })
    expect(p.ok).toBe(true)
    const square = projected(sketchItem(k), 'p1')
    expect(square).toHaveLength(1)
    // a new body from the sketch: one square where the tray stands and one under the base, 3 mm tall
    const both = await run('geom.extrude', { design: w, sketch: k, distance_mm: 3, operation: 'new' })
    expect(both.ok).toBe(true)
    const b = onPlate(w)
    expect(b.min.slice(0, 2)).toEqual([Math.min(tray.min[0]!, 118), Math.min(tray.min[1]!, 118)])
    expect(b.max.slice(0, 2)).toEqual([Math.max(tray.max[0]!, 138), Math.max(tray.max[1]!, 138)])
    expect(volume(entry(w).parts)).toBeCloseTo(20 * 20 * 5 + 2 * 20 * 20 * 3, 0)
    // the base changes and replays: its projection is found again where it was
    expect((await run('geom.extrude', hole(x, 5, 5))).ok).toBe(true)
    expect(projected(sketchItem(k), 'p1')).toContainEqual(square[0])
  })

  it('projects the edges around a landed design\'s top into a sketch drawn for it, and extrudes on the body', async () => {
    projectionFallback()
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    // a small hole in the middle of the pad to come
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: square(0, 0, 2) })).output['id'])
    const stored = structuredClone(sketchItem(k).frame)
    // an edge picked in the design's frame, and every edge around that face
    const e = (await run('geom.edge_pick', { design: d, face: { at: [0, -9.5, 10], normal: [0, 0, 1] } })).output as { edge: { a: number[] }; loop: { edge: unknown }[] }
    expect(e.edge.a.map(r2)[1]).toBe(-10)
    expect((await run('design.sketch_project', { sketch: k, design: d, kind: 'edges', edges: e.loop.map((l) => l.edge), mode: 'real' })).ok).toBe(true)
    const pad = await run('geom.extrude', { design: d, sketch: k, distance_mm: 2, operation: 'join' })
    expect(pad.ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 + (20 * 20 - 4) * 2, 0)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 12] })
    expect(sketchItem(k).frame).toEqual(stored)
  })
})

describe('sketches drawn for a design move with it', () => {
  const ring = (x: number, y: number, d = 8) => square(x, y, d)
  const holeIn = (before: number, after: number, depth: number, d = 8) => expect((before - after) / (d * d * depth)).toBeCloseTo(1, 1)

  it('keeps a sketch drawn for a design on it when another design makes room, used or not, and after its step is undone', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const top = { origin: [0, 0, 100], normal: [0, 0, 1] }
    const used = String((await run('design.sketch', { design: planter, frame: top, loops: ring(0, 0) })).output['id'])
    const unused = String((await run('design.sketch', { design: planter, frame: top, loops: ring(30, 0) })).output['id'])
    expect((await run('geom.extrude', { design: planter, sketch: used, distance_mm: 2, operation: 'cut' })).ok).toBe(true)
    const full = volume(entry(planter).parts) + 64 * 2
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    expect((await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })).summary).toMatch(/Planter moved by/)
    const stored = structuredClone(sketchItem(used).frame)
    // the cut that owned the sketch is undone; the sketch stays on the planter where it moved
    await run('design.undo', { design: planter })
    expect(volume(entry(planter).parts)).toBeCloseTo(full, 0)
    expect(host.sketch!(used, planter).frame?.origin.map(r2)).toEqual([0, 0, 100])
    // and redone: the cut comes back where it was, and so does the sketch, which never moved where it is stored
    await run('design.redo', { design: planter })
    holeIn(full, volume(entry(planter).parts), 2)
    expect(host.sketch!(used, planter).frame?.origin.map(r2)).toEqual([0, 0, 100])
    expect(sketchItem(used).frame).toEqual(stored)
    await run('design.undo', { design: planter })
    expect((await run('geom.extrude', { design: planter, sketch: used, distance_mm: 3, operation: 'cut' })).ok).toBe(true)
    holeIn(full, volume(entry(planter).parts), 3)
    expect(sketchItem(used).frame).toEqual(stored)
    // the sketch no step used moved with it too
    const before = volume(entry(planter).parts)
    expect(host.sketch!(unused, planter).frame?.origin.map(r2)).toEqual([0, 0, 100])
    expect((await run('geom.extrude', { design: planter, sketch: unused, distance_mm: 3, operation: 'cut' })).ok).toBe(true)
    holeIn(before, volume(entry(planter).parts), 3)
  })

  it('keeps a sketch drawn for a design on it when a person drags the design', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(0, 0, 6) })).output['id'])
    drag(d, 20, -10)
    // the design's frame moved with the drag, and so did its sketch
    expect(host.sketch!(k, d).frame?.origin).toEqual([20, -10, 10])
    const stored = structuredClone(sketchItem(k).frame)
    const undo = createHistory(appStore)
    try {
      expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 4, operation: 'cut' })).ok).toBe(true)
      expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
      // the design tools' undo and redo, then the plate's: the sketch reads the same each time, and is stored as it was
      await run('design.undo', { design: d })
      expect(host.sketch!(k, d).frame?.origin).toEqual([20, -10, 10])
      await run('design.redo', { design: d })
      expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
      expect(host.sketch!(k, d).frame?.origin).toEqual([20, -10, 10])
      undo.undo()
      expect(entry(d).history!.steps).toHaveLength(1)
      expect(host.sketch!(k, d).frame?.origin).toEqual([20, -10, 10])
      undo.redo()
      expect(entry(d).history!.steps).toHaveLength(2)
      expect(host.sketch!(k, d).frame?.origin).toEqual([20, -10, 10])
      expect(sketchItem(k).frame).toEqual(stored)
      // a deeper cut from it still meets the body
      expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 6, operation: 'cut' })).ok).toBe(true)
      expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(6), 0)
    } finally {
      undo.dispose()
    }
  })

  it('keeps a sketch drawn for a design with it in a saved project, and on it after the reopened design is dragged', async () => {
    const run = toolsOn(appDesignHost(loader))
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(4, 0, 6) })).output['id'])
    const bed = { widthMm: 256, depthMm: 256 }
    const s = get()
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: s.plate, settings: {} }], bed, settings: {}, timeline: s.timeline })
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    const o = p.plates[0]!.objects[0]!
    const { withBodyIds } = await import('@slicerx/cad-history')
    stop?.()
    appStore.setState({ plate: [{ id: 'opened', name: o.name, handle: handle('opened'), parts: o.parts, colors: ['#bd93f9'], transform: o.transform, history: p.histories.get(o.fileId)! }], timeline: withBodyIds(p.timeline!, (f) => (f === o.fileId ? 'opened' : undefined)) })
    stop = startTimeline()
    expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual(['opened'])
    drag('opened', 10, 0)
    const host = appDesignHost(loader)
    expect(host.sketch!(k, 'opened').frame?.origin).toEqual([10, 0, 10])
    expect((await toolsOn(host)('geom.extrude', { design: 'opened', sketch: k, distance_mm: 4, operation: 'cut' })).ok).toBe(true)
    expect(volume(entry('opened').parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
  })

  it('puts a person\'s sketch back where it was drawn when the only step that carried it with a dragged design is undone', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    // drawn in the sketch tool over the block's middle, in the plate's coordinates, for no design
    const k = finishSketch({ frame: { origin: [128, 128, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: ring(0, 0, 6) as never }).id
    expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 2, operation: 'cut' })).ok).toBe(true)
    drag(d, 20, -10)
    // the cut carries it with the block: the view, mimir and the plate all read it there
    expect(sketchScene(sketchItem(k))!.frame.origin).toEqual([148, 118, 10])
    expect(host.sketch!(k).frame?.origin).toEqual([148, 118, 10])
    expect(host.sketch!(k, d).frame?.origin).toEqual([20, -10, 10])
    await run('design.undo', { design: d })
    // the cut is gone and nothing carries the sketch: it is where it was drawn, stored as it was, and read there by all
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
    expect(sketchScene(sketchItem(k))!.frame.origin).toEqual([128, 128, 10])
    expect(host.sketch!(k).frame?.origin).toEqual([128, 128, 10])
    expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
  })
})

/** A step as replay takes it: where it was recorded and what it holds. */
const kept = (st: Step | undefined) => st && { transform: st.transform, params: st.params }
/** Where the middle of a sketch's loops stands on the plate, from its frame and the bounds of its loop points. */
function middleOnPlate(frame: FaceFrame | undefined, loops: readonly unknown[]): number[] {
  const pts = JSON.stringify(loops).match(/\[-?\d+(\.\d+)?(e-?\d+)?,-?\d+(\.\d+)?(e-?\d+)?\]/g)!.map((t) => JSON.parse(t) as [number, number])
  const [x0, x1] = [Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0]))]
  const [y0, y1] = [Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1]))]
  const f = frame ?? { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }
  const [cu, cv] = [(x0 + x1) / 2, (y0 + y1) / 2]
  return [0, 1, 2].map((i) => r2(f.origin[i]! + f.u[i]! * cu + f.v[i]! * cv))
}

describe('one stored frame per sketch, read where it stands now', () => {
  const ring = (x: number, y: number, d = 6) => square(x, y, d)
  const onTop: FaceFrame = { origin: [128, 128, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

  it('redoes a cut from a sketch drawn on the plate after its design was dragged, without moving the sketch or the cut', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = finishSketch({ frame: onTop, loops: ring(0, 0) as never }).id
    expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 2, operation: 'cut' })).ok).toBe(true)
    const frame = structuredClone(sketchItem(k).frame)
    const step = structuredClone(kept(historyOf(get().timeline, d)!.steps.at(-1)))
    drag(d, 30, 0)
    const read = host.sketch!(k, d)
    expect(read.frame?.origin).toEqual([30, 0, 10])
    await run('design.undo', { design: d })
    await run('design.redo', { design: d })
    // stored as before, the timeline replays the cut where it was made, and mimir reads the sketch where it was
    expect(sketchItem(k).frame).toEqual(frame)
    expect(kept(historyOf(get().timeline, d)!.steps.at(-1))).toEqual(step)
    expect(host.sketch!(k, d)).toEqual(read)
    expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 4, operation: 'cut' })).ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
  })

  it('cuts where a sketch drawn for a design shows after a drag when the person extrudes it in Model, and keeps the cut there after a roll back and a reopen', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(0, 0) })).output['id'])
    const frame = structuredClone(sketchItem(k).frame)
    drag(d, 30, 0)
    // Model shows it on the block, where the drag took it, and the person extrudes it there as a cut into the block
    const shown = sketchScene(sketchItem(k))!.frame
    expect(shown.origin).toEqual([158, 128, 10])
    const made = await applyExtrude(loader, { frame: shown, shape: { type: 'sketch', loops: sketchItem(k).loops }, placement: {}, spec: { distanceMm: 4, extent: 'oneSide', operation: 'cut' }, target: { objectId: d, partIndex: 0 }, name: 'Sketch body' }, { sketch: k })
    expect(made.missed).toBeUndefined()
    const cut = BLOCK_MM3 - holeMm3(4)
    expect(volume(entry(d).parts)).toBeCloseTo(cut, 0)
    // recorded where the sketch is stored, so the sketch has not moved and mimir reads it where it was
    expect(sketchItem(k).frame).toEqual(frame)
    expect(host.sketch!(k, d).frame?.origin).toEqual([30, 0, 10])
    // rolled back to before the cut and forward again: the timeline replays it in the same place
    const at = get().timeline.items.findIndex((i) => i.kind === 'feature' && i.sketch === k)
    await rollTo(loader, at)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3, 0)
    await rollTo(loader, get().timeline.items.length)
    expect(volume(entry(d).parts)).toBeCloseTo(cut, 0)
    // saved and opened again: the body's history replays to the same body where it stands
    const bed = { widthMm: 256, depthMm: 256 }
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: get().plate, settings: {} }], bed, settings: {}, timeline: get().timeline })
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    const o = p.plates[0]!.objects[0]!
    const { withBodyIds } = await import('@slicerx/cad-history')
    const t = withBodyIds(p.timeline!, (f) => (f === o.fileId ? 'opened' : undefined))
    const r = await runReplay({ history: historyOf(t, 'opened')! })
    expect(volume(r.parts.map(toPart))).toBeCloseTo(cut, 0)
    const b = bounds(r.parts.map(toPart), o.transform)!
    expect({ min: b.min.map(r2), max: b.max.map(r2) }).toEqual(onPlate(d))
  })

  it('keeps a body\'s feature where it is when a shared sketch\'s first feature goes, and when that design is deleted', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const own = String((await run('design.new', { name: 'Bar' })).output['design'])
    await run('geom.extrude', { design: own, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, placement: { center: [50, 128] }, distance_mm: 10 })
    // one sketch across both parts, drawn on the plate; the block's cut is the first drawn on it, the bar's comes after
    const k = finishSketch({ frame: { ...onTop, origin: [94, 128, 10] }, loops: [{ points: [[-80, -2], [80, -2], [80, 2], [-80, 2]] }] }).id
    expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 2, operation: 'cut' })).ok).toBe(true)
    expect((await run('geom.extrude', { design: own, sketch: k, distance_mm: 2, operation: 'cut' })).ok).toBe(true)
    const frame = structuredClone(sketchItem(k).frame)
    const bar = structuredClone(historyOf(get().timeline, own)!.steps.map(kept))
    const barVolume = volume(entry(own).parts)
    drag(d, 10, 0)
    // the block's cut is undone: the bar's feature is the sketch's first now, and neither it nor the sketch moves
    await run('design.undo', { design: d })
    expect(sketchItem(k).frame).toEqual(frame)
    expect(historyOf(get().timeline, own)!.steps.map(kept)).toEqual(bar)
    // the block is deleted: the same
    set((st) => ({ plate: st.plate.filter((e) => e.id !== d) }))
    expect(sketchItem(k).frame).toEqual(frame)
    expect(historyOf(get().timeline, own)!.steps.map(kept)).toEqual(bar)
    const r = await runReplay({ history: historyOf(get().timeline, own)! })
    expect(volume(r.parts.map(toPart))).toBeCloseTo(barVolume, 3)
  })

  it('reads a sketch drawn for a design where it was drawn after the design\'s only step is undone', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: ring(0, 0) })).output['id'])
    drag(d, 20, 0)
    const read = host.sketch!(k, d)
    expect(read.frame?.origin).toEqual([20, 0, 10])
    // no body: the design waits where it stood, and its sketch with it
    await run('design.undo', { design: d })
    expect(get().plate).toHaveLength(0)
    expect(host.sketch!(k, d)).toEqual(read)
    await run('design.redo', { design: d })
    expect(host.sketch!(k, d)).toEqual(read)
    expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 4, operation: 'cut' })).ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(BLOCK_MM3 - holeMm3(4), 0)
  })

  it('reads a sketch drawn for a design that made room where it was drawn after that design\'s step is undone', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    expect((await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })).summary).toMatch(/Planter moved by/)
    const k = String((await run('design.sketch', { design: saucer, frame: { origin: [0, 0, 15], normal: [0, 0, 1] }, loops: ring(0, 0, 8) })).output['id'])
    expect(host.sketch!(k, saucer).frame?.origin.map(r2)).toEqual([0, 0, 15])
    // undone, the saucer waits where it was built and the planter moves back: the sketch is still where it was drawn
    await run('design.undo', { design: saucer })
    expect(host.sketch!(k, saucer).frame?.origin.map(r2)).toEqual([0, 0, 15])
    // redone, the saucer lands again, and a cut from the sketch meets it
    await run('design.redo', { design: saucer })
    expect(host.sketch!(k, saucer).frame?.origin.map(r2)).toEqual([0, 0, 15])
    const before = volume(entry(saucer).parts)
    expect((await run('geom.extrude', { design: saucer, sketch: k, distance_mm: 3, operation: 'cut' })).ok).toBe(true)
    expect(before - volume(entry(saucer).parts)).toBeCloseTo(64 * 3, 0)
  })

  it('centers SVG artwork with no design or center named on the bed\'s middle on the plate, drawn for the one design', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10"/></svg>'
    const k = String((await run('design.sketch_svg', { svg })).output['id'])
    expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual([d])
    expect(middleOnPlate(sketchItem(k).frame, sketchItem(k).loops)).toEqual([128, 128, 0])
    expect(middleOnPlate(host.sketch!(k, d).frame, host.sketch!(k, d).loops)).toEqual([0, 0, 0])
  })

  it('moves a sketch drawn while two designs wait with the first to land, and leaves it there when the second lands', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const a = String((await run('design.new', { name: 'A' })).output['design'])
    const b = String((await run('design.new', { name: 'B' })).output['design'])
    const k = String((await run('design.sketch', { loops: ring(0, 0) })).output['id'])
    expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual([a, b])
    expect((await run('geom.extrude', { design: a, ...block })).summary).toMatch(/moved to the plate by \(128, 128\) mm/)
    expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual([a])
    expect(sketchScene(sketchItem(k))!.frame.origin).toEqual([128, 128, 0])
    expect((await run('geom.extrude', { design: b, ...block })).summary).toMatch(/moved to the plate by/)
    expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual([a])
    expect(sketchScene(sketchItem(k))!.frame.origin).toEqual([128, 128, 0])
    expect(host.sketch!(k, a).frame?.origin ?? [0, 0, 0]).toEqual([0, 0, 0])
  })

  it('draws a finished sketch in Model where its projections land, after its design moved', async () => {
    projectionFallback()
    const frames: unknown[] = []
    const inner = geom()
    setGeomProvider({ call: (op, req, signal) => {
      if (op === 'sketch.project') frames.push(structuredClone((req as ProjectRequest).frame))
      return inner.call(op, req, signal)
    } })
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: square(0, 0, 2) })).output['id'])
    drag(d, 15, 0)
    // the face projected from the block's top: onto the plane Model draws the sketch on, where the block is now
    expect((await run('design.sketch_project', { sketch: k, design: d, kind: 'face', face: { at: [15, 0, 10], normal: [0, 0, 1] }, mode: 'real' })).ok).toBe(true)
    const shown = sketchScene(sketchItem(k))!.frame
    expect(shown.origin).toEqual([143, 128, 10])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ origin: shown.origin, u: shown.u, v: shown.v })
    // the projected outline is the block's top as it stands, in the sketch's plane
    expect(projected(sketchItem(k), 'p1')).toEqual([{ points: [[-10, -10], [10, -10], [10, 10], [-10, 10]], projected: 'p1' }])
  })
})

describe('a sketch with no design named', () => {
  it('is drawn for the one design there is once it has landed, and refused while other designs are there', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const k = String((await run('design.sketch', { frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: square(0, 0, 6) })).output['id'])
    expect(sketchItem(k).frame?.origin).toEqual([128, 128, 10])
    expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
    await run('design.new', { name: 'Peg' })
    await expect(run('design.sketch', { frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: square(0, 0, 6) })).rejects.toThrow(/design: name the design/)
  })
})

describe('room for a second design', () => {
  async function planterAndSaucer(run: ReturnType<typeof toolsOn>) {
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    return { planter, saucer, saucerStep: () => run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 }) }
  }

  it('leaves a design the person moved after it landed where they put it', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const { planter, saucerStep } = await planterAndSaucer(run)
    drag(planter, 3, 0)
    const t = [...entry(planter).transform]
    const made = await saucerStep()
    expect(made.summary).not.toMatch(/to make room/)
    expect(entry(planter).transform).toEqual(t)
    expect(entry(planter).history?.placed).toEqual([128, 128])
  })

  it('moves the others back when the new design\'s step is undone, and over again when it is redone', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const { planter, saucer, saucerStep } = await planterAndSaucer(run)
    const was = { transform: [...entry(planter).transform], placed: entry(planter).history?.placed }
    expect((await saucerStep()).summary).toMatch(/Planter moved by/)
    const moved = { transform: [...entry(planter).transform], placed: entry(planter).history?.placed }
    expect(moved.transform).not.toEqual(was.transform)
    await run('design.undo', { design: saucer })
    expect(get().plate.map((e) => e.id)).toEqual([planter])
    expect({ transform: entry(planter).transform, placed: entry(planter).history?.placed }).toEqual(was)
    expect(at(host.get(planter))).toEqual([0, 0])
    const back = await run('design.redo', { design: saucer })
    expect(String(back.output['landed'])).toMatch(/Planter moved by/)
    expect({ transform: entry(planter).transform, placed: entry(planter).history?.placed }).toEqual(moved)
  })

  it('leaves a design the person moves while the room is worked out where they put it, and one they delete gone', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const { planter, saucer, saucerStep } = await planterAndSaucer(run)
    const inner = geom()
    let during: (() => void) | null = () => drag(planter, 2, 0)
    setGeomProvider({ call: (op, req, signal) => {
      if (op === 'nest.start' && during) {
        during()
        during = null
      }
      return inner.call(op, req, signal)
    } })
    const t = entry(planter).transform.map((v, i) => (i === 12 ? v + 2 : v))
    const made = await saucerStep()
    expect(entry(planter).transform).toEqual(t)
    expect(entry(planter).history?.placed).toEqual([128, 128])
    // the room worked out before the drag is no longer right: the saucer does not land on the planter
    expect(made.summary).not.toMatch(/Planter moved by/)
    if (/moved to the plate by/.test(made.summary)) expectApart(planter, saucer)
    else expect(printsOnBed(entry(saucer), get().bed)).toBe(false)
  })

  it('lands the new design when a design it would move is deleted while the room is worked out', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const { planter, saucer, saucerStep } = await planterAndSaucer(run)
    const inner = geom()
    let during: (() => void) | null = () => set((s) => ({ plate: s.plate.filter((e) => e.id !== planter) }))
    setGeomProvider({ call: (op, req, signal) => {
      if (op === 'nest.start' && during) {
        during()
        during = null
      }
      return inner.call(op, req, signal)
    } })
    const made = await saucerStep()
    expect(made.ok).toBe(true)
    expect(get().plate.map((e) => e.id)).toEqual([saucer])
  })
})

describe('room moves and what the person does after them', () => {
  async function landedPair(run: ReturnType<typeof toolsOn>) {
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const was = { transform: [...entry(planter).transform], placed: entry(planter).history?.placed }
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    expect((await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })).summary).toMatch(/Planter moved by/)
    return { planter, saucer, was }
  }
  const standing = (id: string) => ({ transform: [...entry(id).transform], placed: entry(id).history?.placed, landedAt: entry(id).landedAt })

  it('leaves the planter where the person dragged it after the room move when the saucer\'s step is undone', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const { planter, saucer } = await landedPair(run)
    const placed = entry(planter).history?.placed
    drag(planter, 4, 0)
    const t = [...entry(planter).transform]
    await run('design.undo', { design: saucer })
    expect(entry(planter).transform).toEqual(t)
    expect(entry(planter).history?.placed).toEqual(placed)
  })

  it('takes back the saucer\'s landing and the room move in one plate undo, and puts both back with redo', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const before = standing(planter)
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    const undo = createHistory(appStore)
    try {
      expect((await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })).summary).toMatch(/Planter moved by/)
      const after = { planter: standing(planter), saucer: standing(saucer), room: structuredClone(entry(saucer).roomMoves) }
      expect(after.room?.moves.map((m) => m.id)).toEqual([planter])
      undo.undo()
      expect(get().plate.map((e) => e.id)).toEqual([planter])
      expect(standing(planter)).toEqual(before)
      undo.redo()
      expect(get().plate.map((e) => e.id)).toEqual([planter, saucer])
      expect({ planter: standing(planter), saucer: standing(saucer), room: entry(saucer).roomMoves }).toEqual(after)
    } finally {
      undo.dispose()
    }
  })

  it('leaves the planter moved when a later step of the saucer is undone', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const { planter, saucer } = await landedPair(run)
    const moved = standing(planter)
    expect((await run('geom.extrude', { design: saucer, shape: { type: 'polygon', sides: 6, diameterMm: 20 }, frame: { origin: [0, 0, 15], normal: [0, 0, 1] }, distance_mm: 2, operation: 'cut' })).ok).toBe(true)
    await run('design.undo', { design: saucer })
    expect(entry(saucer).history!.steps).toHaveLength(1)
    expect(standing(planter)).toEqual(moved)
  })

  /** A turn of 90 degrees about Z where the planter stands. */
  const turned = (t: number[]) => [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, t[12]!, t[13]!, t[14]!, 1]
  it.each([
    ['turned by the person', (id: string) => set((st) => ({ plate: st.plate.map((e) => (e.id === id ? { ...e, transform: turned(e.transform) } : e)) }))],
    ['locked by the person', (id: string) => set((st) => ({ plate: st.plate.map((e) => (e.id === id ? { ...e, locked: true } : e)) }))],
  ])('leaves a planter %s where it is, and the saucer makes no room', { timeout: 60_000 }, async (_how, change) => {
    const run = toolsOn(appDesignHost(loader))
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    change(planter)
    const t = [...entry(planter).transform]
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    const made = await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })
    expect(made.summary).not.toMatch(/to make room/)
    expect(entry(planter).transform).toEqual(t)
  })

  it('leaves a planter built where it prints, never landed, where it is, and the saucer makes no room', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    expect((await run('geom.extrude', { design: planter, shape: PLANTER, placement: { center: [128, 128] }, distance_mm: 100 })).summary).not.toMatch(/moved to the plate/)
    expect(entry(planter).history?.placed).toBeUndefined()
    const t = [...entry(planter).transform]
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    const made = await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })
    expect(made.summary).not.toMatch(/to make room/)
    expect(entry(planter).transform).toEqual(t)
  })

  it('leaves a landed planter from a reopened project where it is, and the saucer makes no room', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const bed = { widthMm: 256, depthMm: 256 }
    const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: get().plate, settings: {} }], bed, settings: {}, timeline: get().timeline })
    readProjectsWithGeom(false)
    const p = await readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
    const o = p.plates[0]!.objects[0]!
    const { withBodyIds } = await import('@slicerx/cad-history')
    stop?.()
    appStore.setState({ plate: [{ id: 'opened', name: o.name, handle: handle('opened'), parts: o.parts, colors: ['#bd93f9'], transform: o.transform, history: p.histories.get(o.fileId)! }], timeline: withBodyIds(p.timeline!, (f) => (f === o.fileId ? 'opened' : undefined)) })
    stop = startTimeline()
    expect(entry('opened').history?.placed).toEqual([128, 128])
    const t = [...entry('opened').transform]
    const again = toolsOn(appDesignHost(loader))
    const saucer = String((await again('design.new', { name: 'Saucer' })).output['design'])
    const made = await again('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })
    expect(made.summary).not.toMatch(/to make room/)
    expect(entry('opened').transform).toEqual(t)
  })

  it('moves a planter nudged and put back exactly where it landed to make room, as one nobody moved', { timeout: 60_000 }, async () => {
    const run = toolsOn(appDesignHost(loader))
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    drag(planter, 3, 0)
    drag(planter, -3, 0)
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    expect((await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })).summary).toMatch(/Planter moved by/)
    expectApart(planter, saucer)
  })
})

describe('a replay that meets a landing made meanwhile', () => {
  it('keeps the landing moves on the plate, not the ones the replay started with', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    await run('geom.extrude', hole(d))
    const stale = host.get(d)
    // while the replay runs, another host moves the design over to make room: transform and landing move together
    set((s) => ({ plate: s.plate.map((e) => (e.id === d ? { ...e, transform: e.transform.map((v, i) => (i === 12 ? v + 10 : v)), history: { ...e.history!, placed: [138, 128] } } : e)) }))
    await host.replay(stale)
    expect(entry(d).history?.placed).toEqual([138, 128])
    expect(at(host.get(d))).toEqual([0, 0])
  })
})

describe('the design tools on a landed design', () => {
  const top = { origin: [0, 0, 10], normal: [0, 0, 1] }

  it('revolves, lofts and sweeps from sketches drawn for it, on the body, and leaves the sketches where they are stored', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const sketch = async (frame: Record<string, unknown>, loops: unknown[]) => String((await run('design.sketch', { design: d, frame, loops })).output['id'])
    // a 4 mm post revolved on the top, about the design's vertical axis
    const side = await sketch({ origin: [0, 0, 10], normal: [0, -1, 0], u: [1, 0, 0] }, [{ points: [[0, 0], [4, 0], [4, 5], [0, 5]] }])
    const stored = new Map<string, unknown>([[side, structuredClone(sketchItem(side).frame)]])
    let v = volume(entry(d).parts)
    expect((await run('geom.revolve', { design: d, sketch: side, axis: { point: [0, 0], direction: [0, 1] }, operation: 'join', part: 0 })).ok).toBe(true)
    expect(volume(entry(d).parts) - v).toBeCloseTo(Math.PI * 16 * 5, -1)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 15] })
    // a loft from a square at the post's top to a smaller square above it
    const low = await sketch({ origin: [0, 0, 15], normal: [0, 0, 1] }, [{ points: [[-3, -3], [3, -3], [3, 3], [-3, 3]] }])
    const high = await sketch({ origin: [0, 0, 19], normal: [0, 0, 1] }, [{ points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }])
    for (const k of [low, high]) stored.set(k, structuredClone(sketchItem(k).frame))
    v = volume(entry(d).parts)
    expect((await run('geom.loft', { design: d, sketches: [low, high], operation: 'join', part: 0 })).ok).toBe(true)
    expect(volume(entry(d).parts)).toBeGreaterThan(v)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 19] })
    // a rod swept up from the block's top, off to one side
    const profile = await sketch(top, [{ type: 'circle', center: [6, 6], diameterMm: 2 }])
    const path = await sketch({ origin: [0, 6, 10], normal: [0, -1, 0], u: [1, 0, 0] }, [{ start: [6, 0], segments: [{ type: 'line', to: [6, 8] }] }])
    for (const k of [profile, path]) stored.set(k, structuredClone(sketchItem(k).frame))
    v = volume(entry(d).parts)
    expect((await run('geom.sweep', { design: d, profile_sketch: profile, path_sketch: path, operation: 'join', part: 0 })).ok).toBe(true)
    expect(volume(entry(d).parts) - v).toBeCloseTo(Math.PI * 8, -1)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 19] })
    for (const [k, f] of stored) expect(sketchItem(k).frame).toEqual(f)
  })

  it('turns SVG artwork into a sketch drawn for it, around the bed\'s middle in its frame', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10"/></svg>'
    const k = String((await run('design.sketch_svg', { design: d, svg })).output['id'])
    // on the bed, around the middle of the plate, which in the landed design's frame is its origin
    const stored = structuredClone(sketchItem(k).frame)
    expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 0])
    expect((await run('geom.extrude', { design: d, sketch: k, distance_mm: 3, operation: 'new' })).ok).toBe(true)
    const b = bounds([entry(d).parts[1]!], entry(d).transform)!
    expect({ min: b.min.map(r2), max: b.max.map(r2) }).toEqual({ min: [123, 123, 0], max: [133, 133, 3] })
    expect(sketchItem(k).frame).toEqual(stored)
  })

  it('picks, rounds and bevels in the design\'s frame', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const face = (await run('geom.face_pick', { design: d, face: { at: [0, 0, 10], normal: [0, 0, 1] } })).output as { frame: { origin: number[] } }
    expect(face.frame.origin.map(r2)[2]).toBe(10)
    const edge = async (at: number[]) => ((await run('geom.edge_pick', { design: d, face: { at, normal: [0, 0, 1] } })).output as { edge: unknown }).edge
    let v = volume(entry(d).parts)
    expect((await run('geom.fillet', { design: d, edges: [await edge([0, -9.5, 10])], radius_mm: 2 })).ok).toBe(true)
    expect(v - volume(entry(d).parts)).toBeCloseTo((4 - Math.PI) * 20, 0)
    v = volume(entry(d).parts)
    expect((await run('geom.chamfer', { design: d, edges: [await edge([0, 9.5, 10])], distance_mm: 1 })).ok).toBe(true)
    expect(v - volume(entry(d).parts)).toBeCloseTo(0.5 * 20, 0)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [138, 138, 10] })
  })

  it('mirrors, repeats and embosses in the design\'s frame', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    // a copy mirrored through x = 10 of the design: 40 mm wide, from the block's left side
    let v = volume(entry(d).parts)
    expect((await run('geom.mirror', { design: d, plane: { axis: 'x', at: 10 }, copy: true })).ok).toBe(true)
    expect(volume(entry(d).parts)).toBeCloseTo(2 * v, 0)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [158, 138, 10] })
    // a second row 30 mm toward the back, joined
    expect((await run('geom.array', { design: d, spec: { kind: 'linear', count: 2, step: [0, 30, 0] } })).ok).toBe(true)
    expect(onPlate(d)).toEqual({ min: [118, 118, 0], max: [158, 168, 10] })
    v = volume(entry(d).parts)
    expect((await run('geom.emboss', { design: d, text: 'X', point: [0, 0, 10], normal: [0, 0, 1], size_mm: 4, depth_mm: 1 })).ok).toBe(true)
    expect(volume(entry(d).parts)).toBeGreaterThan(v)
    expect(onPlate(d).max[2]).toBe(11)
  })

  it('joins parts of a design that landed beside another, in its own frame', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const a = await landedBlock(run, 'Left')
    const aWas = onPlate(a)
    const b = String((await run('design.new', { name: 'Right' })).output['design'])
    expect((await run('geom.extrude', { design: b, ...block })).summary).toMatch(/moved to the plate by/)
    const placed = entry(b).history!.placed!
    expect(placed).not.toEqual([128, 128])
    const where = onPlate(b)
    // a peg as a part of its own on the top of the block, at the design's origin, then joined to it
    expect((await run('geom.extrude', { design: b, shape: { type: 'rectangle', widthMm: 6, heightMm: 6 }, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, distance_mm: 5, operation: 'new' })).ok).toBe(true)
    expect(entry(b).parts).toHaveLength(2)
    expect((await run('geom.boolean', { design: b, op: 'union', part: 0, with_parts: [1] })).ok).toBe(true)
    expect(entry(b).parts).toHaveLength(1)
    expect(volume(entry(b).parts)).toBeCloseTo(BLOCK_MM3 + holeMm3(5), 0)
    expect(onPlate(b)).toEqual({ min: where.min, max: [where.max[0], where.max[1], 15] })
    expect(onPlate(a)).toEqual(aWas)
  })
})

describe('copies of a design whose landing made room', () => {
  // the saucer's landing moved the planter over; a copy of the saucer moved nothing, so undoing the copy's step leaves
  // the planter where the room move put it
  async function landedPair(run: ReturnType<typeof toolsOn>) {
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    await run('geom.extrude', { design: planter, shape: PLANTER, distance_mm: 100 })
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    expect((await run('geom.extrude', { design: saucer, shape: SAUCER, distance_mm: 15 })).summary).toMatch(/Planter moved by/)
    // a bed with room for a copy beside them
    set((s) => ({ bed: { ...s.bed, widthMm: 512, depthMm: 512 } }))
    return { planter, saucer }
  }
  const standing = (id: string) => ({ transform: [...entry(id).transform], placed: entry(id).history?.placed })

  it.each([
    ['pasted', (saucer: string) => {
      set({ selection: saucer, selectedIds: [saucer] })
      expect(copySelection()).toBe(1)
      return pasteClipboard()[0]!
    }],
    ['added as an instance', (saucer: string) => {
      expect(setInstanceCount(saucer, 2)).toBe(true)
      return get().plate.find((e) => e.instanceOf === saucer)!.id
    }],
  ])('leaves the others where they stand when the step of a copy %s is undone', { timeout: 60_000 }, async (_how, copyOf) => {
    const run = toolsOn(appDesignHost(loader))
    const { planter, saucer } = await landedPair(run)
    const was = { planter: standing(planter), saucer: standing(saucer) }
    const copy = copyOf(saucer)
    expect(copy).toBeDefined()
    await run('design.undo', { design: copy })
    expect(get().plate.some((e) => e.id === copy)).toBe(false)
    expect({ planter: standing(planter), saucer: standing(saucer) }).toEqual(was)
    // the original's own undo still moves the planter back
    expect(entry(saucer).roomMoves?.moves.map((m) => m.id)).toEqual([planter])
  })
})

/** `objects` and the timeline written as a project and read back by the TypeScript reader, as the app opens one. */
async function reopen(objects: PlateEntry[]) {
  const bed = { widthMm: 256, depthMm: 256 }
  const bytes = writeProject({ plates: [{ id: 'plate-1', name: 'Plate 1', objects, settings: {} }], bed, settings: {}, timeline: get().timeline })
  readProjectsWithGeom(false)
  return readProject(bytes, bed).finally(() => readProjectsWithGeom(true))
}

describe('a landed design held off the plate by a roll back', () => {
  const body = (id: string) => get().timeline.bodies.find((b) => b.id === id)

  it('keeps its landing while held, after rolling forward, and in a project saved either way', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    await rollTo(loader, 0)
    expect(get().plate).toHaveLength(0)
    expect(body(d)?.placed).toEqual([128, 128])
    // saved while rolled back: the held body goes in the file with the plate, as a save writes it
    const held = await reopen([...get().plate, ...heldBodies().map((h) => h.entry)])
    expect(held.timeline?.bodies.map((b) => b.placed)).toEqual([[128, 128]])
    expect(held.histories.get(held.plates[0]!.objects[0]!.fileId)?.placed).toEqual([128, 128])
    await rollTo(loader, get().timeline.items.length)
    expect(entry(d).history?.placed).toEqual([128, 128])
    expect(body(d)?.placed).toEqual([128, 128])
    expect(at(host.get(d))).toEqual([0, 0])
    const saved = await reopen(get().plate)
    expect(saved.timeline?.bodies.map((b) => b.placed)).toEqual([[128, 128]])
    expect(saved.histories.get(saved.plates[0]!.objects[0]!.fileId)?.placed).toEqual([128, 128])
  })

  it('rolls forward to a step after its first with its landing, so a step in its frame still meets the body', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    await run('geom.extrude', hole(d, -5, 0))
    await rollTo(loader, 0)
    await rollTo(loader, 1)
    expect(entry(d).history?.steps).toHaveLength(1)
    expect(entry(d).history?.placed).toEqual([128, 128])
    expect(body(d)?.placed).toEqual([128, 128])
    expect(at(host.get(d))).toEqual([0, 0])
  })
})

describe('a sketch drawn for a design in one step', () => {
  it('goes in with the design it is drawn for in one plate undo step, and goes out whole with one undo', async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const d = await landedBlock(run)
    const has = (k: string) => get().timeline.items.some((i) => i.kind === 'sketch' && i.id === k)
    const undo = createHistory(appStore)
    try {
      const k = String((await run('design.sketch', { design: d, frame: { origin: [0, 0, 10], normal: [0, 0, 1] }, loops: square(0, 0, 6) })).output['id'])
      expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual([d])
      undo.undo()
      expect(has(k)).toBe(false)
      expect(entry(d).history?.steps).toHaveLength(1)
      undo.redo()
      expect(sketchItem(k).drawnFor?.map((f) => f.design)).toEqual([d])
      expect(host.sketch!(k, d).frame?.origin).toEqual([0, 0, 10])
    } finally {
      undo.dispose()
    }
  })
})
