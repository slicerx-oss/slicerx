// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A landing moves a design as a whole. Its timeline sketches and recorded steps stay in plate coordinates, and the
// design tools give and read points in the design's own frame: the plate transform less the landing moves, which the
// design's history keeps (History.placed) and a project saves. A sketch read for a design is converted by the move of
// the body that owns it and by that design's landing, and a step that draws on a shared sketch is stored so the sketch
// keeps its frame. Runs the tools on the app's design host against the geometry engine (live wasm when built,
// recorded replies otherwise), with the replay cache cleared before each test so no test leans on another's replays.
import { clearReplayCache, type Design, type DesignHost, type SketchItem } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { designToolset } from '@slicerx/mcp/toolset'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appDesignHost } from '../src/cad/design-host'
import { readProject, readProjectsWithGeom } from '../src/export/import3mf'
import { writeProject } from '../src/export/threemf'
import { NO_MARGINS, printsOnBed, setMarginSource } from '../src/plate/arrange'
import { createHistory } from '../src/plate/history'
import { startTimeline } from '../src/plate/timeline'
import { bounds } from '../src/plate/transform'
import { appStore, get, set, type PlateEntry } from '../src/state/store'
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

/** A 20 by 20 mm block 10 mm tall, built around the origin as a model sketches it: it lands at the bed's middle. */
const block = { shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, distance_mm: 10 }
/** A hole 6 mm across from the top of that block, `depth` mm down, at (x, y) in the design's frame. */
const hole = (design: string, x = 0, y = 0, depth = 4) => ({ design, shape: { type: 'circle', diameterMm: 6 }, frame: { origin: [x, y, 10], normal: [0, 0, 1] }, distance_mm: depth, operation: 'cut' })
const BLOCK_MM3 = 20 * 20 * 10
const holeMm3 = (depth: number) => Math.PI * 9 * depth

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
    // a resumed chat on a new host keeps writing in the frame it built in
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
  const ring = (d: number) => [{ type: 'circle', center: [0, 0], diameterMm: d }]

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
    const peg = await run('geom.extrude', { design: waiting, shape: { type: 'circle', diameterMm: 8 }, distance_mm: 5 })
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
    const k = String((await run('design.sketch', { frame: { origin: [94, 128, 10], normal: [0, 0, 1] }, loops: [{ points: [[-80, -2], [80, -2], [80, 2], [-80, 2]] }] })).output['id'])
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
  it('lands a 140 mm saucer beside a 120 mm planter, moving the planter over, and says where both went', { timeout: 60_000 }, async () => {
    const host = appDesignHost(loader)
    const run = toolsOn(host)
    const planter = String((await run('design.new', { name: 'Planter' })).output['design'])
    expect((await run('geom.extrude', { design: planter, shape: { type: 'circle', diameterMm: 120 }, distance_mm: 100 })).summary).toMatch(/moved to the plate by \(128, 128\) mm/)
    const saucer = String((await run('design.new', { name: 'Saucer' })).output['design'])
    const made = await run('geom.extrude', { design: saucer, shape: { type: 'circle', diameterMm: 140 }, distance_mm: 15 })
    expect(made.ok).toBe(true)
    expect(made.summary).not.toMatch(/does not fit/)
    expect(made.summary).toMatch(/moved to the plate by/)
    expect(made.summary).toMatch(/Planter moved by \(-?\d+(\.\d+)?, -?\d+(\.\d+)?\) mm to make room/)
    // both print where they stand, apart
    expect(printsOnBed(entry(planter), get().bed)).toBe(true)
    expect(printsOnBed(entry(saucer), get().bed)).toBe(true)
    const center = (id: string) => {
      const b = onPlate(id)
      return [(b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2]
    }
    const [p, s] = [center(planter), center(saucer)]
    expect(Math.hypot(p[0]! - s[0]!, p[1]! - s[1]!)).toBeGreaterThanOrEqual(60 + 70)
    // each keeps its own frame: the planter's move is a landing too, so a hole at its origin still meets it
    expect(at(host.get(planter))).toEqual([0, 0])
    expect(at(host.get(saucer))).toEqual([0, 0])
    const drain = await run('geom.extrude', { design: planter, shape: { type: 'circle', diameterMm: 8 }, frame: { origin: [0, 0, 0], normal: [0, 0, -1] }, distance_mm: 5, operation: 'cut' })
    expect(drain.ok).toBe(true)
  })
})
