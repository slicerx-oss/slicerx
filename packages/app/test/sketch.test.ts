// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Sketch mode: the drawing tools, snaps, typed sizes and edits as plain functions, then the drawn
// sketch through the geometry engine (live wasm when built, recorded replies otherwise).
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkSketch, offsetSketch } from '../src/geom/cad'
import { applyExtrude, applyRevolve, BED_FRAME } from '../src/cad/cad-ops'
import {
  arcMiddle,
  arcThrough,
  axisOf,
  click,
  deleteSegment,
  emptyDraft,
  fieldsFor,
  handles,
  hitTest,
  moveHandle,
  polylineToChain,
  preview,
  readout,
  reverseChain,
  sketchTargets,
  snap,
  toLoops,
  typedPoint,
  type Chain,
  type Draft,
  type Entity,
  type V2,
} from '../src/cad/sketch-model'
import { createHistory } from '../src/plate/history'
import { appStore, get, set } from '../src/state/store'
import { useGeomEngine } from './geom-engine'

useGeomEngine('sketch-replies')

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const host = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

/** Clicks the points in order with one tool. */
function draw(tool: Draft['tool'], points: V2[], sketch: Entity[] = [], start?: Draft): { sketch: Entity[]; draft: Draft } {
  let s = sketch
  let d = start ?? emptyDraft(tool)
  for (const p of points) ({ sketch: s, draft: d } = click(s, d, p))
  return { sketch: s, draft: d }
}

beforeEach(() => set({ plate: [], selection: null, selectedIds: [] }))

describe('drawing tools', () => {
  it('chains lines and closes on the first point', () => {
    const r = draw('line', [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]])
    expect(r.sketch).toHaveLength(1)
    const c = r.sketch[0] as Chain
    expect(c.closed).toBe(true)
    expect(c.segs).toHaveLength(4)
    expect(r.draft.points).toEqual([])
    expect(toLoops(r.sketch)[0]).toEqual({ start: [0, 0], segments: [{ type: 'line', to: [20, 0] }, { type: 'line', to: [20, 10] }, { type: 'line', to: [0, 10] }, { type: 'line', to: [0, 0] }] })
  })

  it('draws a rectangle from two corners and a circle from center and rim', () => {
    const r = draw('rect', [[10, 10], [0, 4]])
    expect((r.sketch[0] as Chain).segs.map((s) => s.to)).toEqual([[10, 4], [10, 10], [0, 10], [0, 4]])
    const c = draw('circle', [[5, 5], [8, 9]], r.sketch)
    expect(c.sketch[1]).toEqual({ kind: 'circle', center: [5, 5], diameterMm: 10 })
  })

  it('goes on from an open end with an arc, then closes with a line', () => {
    const line = draw('line', [[0, 0], [20, 0]])
    const ended = { sketch: line.sketch, draft: emptyDraft('arc') }
    // Start on the chain's end, finish on (20, 10), bulging to the right.
    const arc = draw('arc', [[20, 0], [20, 10], [25, 5]], ended.sketch, ended.draft)
    expect(arc.sketch).toHaveLength(1)
    expect((arc.sketch[0] as Chain).segs[1]).toEqual({ kind: 'arc', to: [20, 10], through: [25, 5] })
    const closed = draw('line', [[20, 10], [0, 10], [0, 0]], arc.sketch)
    expect((closed.sketch[0] as Chain).closed).toBe(true)
    // Starting on a chain's first point turns the chain round so it goes on from there.
    const back = draw('line', [[0, 0], [0, -5]], line.sketch)
    expect((back.sketch[0] as Chain).start).toEqual([20, 0])
  })

  it('reverses a chain with an arc and keeps its shape', () => {
    const c: Chain = { kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [10, 0] }, { kind: 'arc', to: [10, 10], through: [15, 5] }], closed: false }
    expect(reverseChain(c)).toEqual({ kind: 'chain', start: [10, 10], segs: [{ kind: 'arc', to: [10, 0], through: [15, 5] }, { kind: 'line', to: [0, 0] }], closed: false })
  })

  it('previews what the next click draws', () => {
    expect(preview({ tool: 'line', points: [[0, 0]] }, [3, 4])).toEqual([[0, 0], [3, 4]])
    expect(preview({ tool: 'rect', points: [[0, 0]] }, [3, 4])).toHaveLength(5)
    expect(preview({ tool: 'arc', points: [[0, 0], [10, 0]] }, [5, 5]).length).toBeGreaterThan(8)
    expect(readout({ tool: 'line', points: [[0, 0]] }, [10, 10])).toBe('Length 14.14 mm, angle 45.0°')
    expect(readout({ tool: 'rect', points: [[0, 0]] }, [-4, 2])).toBe('4.00 by 2.00 mm')
  })
})

describe('typed sizes', () => {
  it('asks for the right values at each step', () => {
    expect(fieldsFor(emptyDraft('line')).map((f) => f.label)).toEqual(['X', 'Y'])
    expect(fieldsFor({ tool: 'line', points: [[0, 0]] }).map((f) => f.label)).toEqual(['Length', 'Angle'])
    expect(fieldsFor({ tool: 'arc', points: [[0, 0], [1, 0]] }).map((f) => f.label)).toEqual(['Radius'])
    expect(fieldsFor(emptyDraft('select'))).toEqual([])
  })

  it('places points from typed values, the cursor filling in the rest', () => {
    expect(typedPoint({ tool: 'line', points: [[0, 0]] }, [10, 90], [99, 99])).toEqual([0, 10])
    // No angle: the cursor's direction.
    expect(typedPoint({ tool: 'line', points: [[0, 0]] }, [10, null], [-5, 0])).toEqual([-10, 0])
    // Rectangles follow the cursor's quadrant.
    expect(typedPoint({ tool: 'rect', points: [[0, 0]] }, [30, 20], [-1, 1])).toEqual([-30, 20])
    expect(typedPoint({ tool: 'circle', points: [[0, 0]] }, [10], [0, 3])).toEqual([0, 5])
    expect(typedPoint({ tool: 'line', points: [] }, [12.5, 4], [0, 0])).toEqual([12.5, 4])
    expect(typedPoint({ tool: 'rect', points: [[0, 0]] }, [0, 5], [1, 1])).toMatch(/more than 0/)
  })

  it('puts an arc of a typed radius on the cursor side, and refuses one too small', () => {
    const m = arcMiddle([0, 0], [10, 0], 5, [5, -3]) as V2
    expect(m[0]).toBeCloseTo(5)
    expect(m[1]).toBeCloseTo(-5)
    expect(arcMiddle([0, 0], [10, 0], 4, [5, 1])).toMatch(/at least 5 mm/)
    const c = arcThrough([0, 0], [5, 5], [10, 0])!
    expect(c.r).toBeCloseTo(5)
    expect(c.sweep).toBeCloseTo(-Math.PI)
  })
})

describe('snaps', () => {
  const box = draw('rect', [[0, 0], [20, 10]]).sketch
  const targets = [sketchTargets(box)]

  it('prefers points, then horizontal and vertical, then edges, then the grid', () => {
    expect(snap([19.6, 0.3], targets, { gridMm: 1, tolMm: 1 })).toMatchObject({ at: [20, 0], kind: 'vertex' })
    expect(snap([10.2, 0.4], targets, { gridMm: 1, tolMm: 1 })).toMatchObject({ at: [10, 0], kind: 'midpoint' })
    expect(snap([31.3, 40.4], targets, { anchor: [5, 40], gridMm: 1, tolMm: 1 })).toMatchObject({ at: [31, 40], kind: 'horizontal' })
    expect(snap([5.6, 31.3], targets, { anchor: [5, 40], gridMm: 0.5, tolMm: 1 })).toMatchObject({ at: [5, 31.5], kind: 'vertical' })
    expect(snap([13.3, 9.6], targets, { gridMm: 0, tolMm: 1 })).toMatchObject({ at: [13.3, 10], kind: 'edge' })
    expect(snap([40.3, 40.6], targets, { gridMm: 1, tolMm: 1 })).toMatchObject({ at: [40, 41], kind: 'grid' })
    expect(snap([40.3, 40.6], targets, { gridMm: 0, tolMm: 1 })).toMatchObject({ kind: null })
  })

  it('does not snap a dragged point to itself', () => {
    const t = sketchTargets(box, { e: 0, at: 'to', seg: 0 })
    expect(t.points.some((p) => p.at[0] === 20 && p.at[1] === 0)).toBe(false)
  })
})

describe('edits after drawing', () => {
  const box = draw('rect', [[0, 0], [20, 10]]).sketch

  it('drags a corner and keeps a closed chain closed', () => {
    const h = handles(box)
    // A closed rectangle has four corners: start and three ends.
    expect(h.points).toHaveLength(4)
    const moved = moveHandle(box, h.refs[0]!, [-5, 0]) as Chain[]
    expect(moved[0]!.start).toEqual([-5, 0])
    expect(moved[0]!.segs[3]!.to).toEqual([-5, 0])
    const circle = moveHandle([{ kind: 'circle', center: [0, 0], diameterMm: 4 }], { e: 0, at: 'rim' }, [0, 6])
    expect(circle[0]).toEqual({ kind: 'circle', center: [0, 0], diameterMm: 12 })
  })

  it('picks the segment under the cursor and deletes it', () => {
    expect(hitTest(box, [10, 10.3], 0.5)).toEqual({ e: 0, seg: 2 })
    expect(hitTest(box, [10, 5], 0.5)).toBeNull()
    const open = deleteSegment(box, 0, 2) as Chain[]
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ start: [0, 10], closed: false })
    expect(open[0]!.segs.map((s) => s.to)).toEqual([[0, 0], [20, 0], [20, 10]])
    // An open chain splits in two.
    expect(deleteSegment(open, 0, 1)).toHaveLength(2)
    expect(deleteSegment([{ kind: 'circle', center: [0, 0], diameterMm: 3 }], 0, 0)).toEqual([])
  })

  it('takes a revolve axis from a straight line only', () => {
    expect(axisOf(box, { e: 0, seg: 1 })).toEqual({ point: [20, 0], direction: [0, 10] })
    expect(axisOf([{ kind: 'circle', center: [0, 0], diameterMm: 3 }], { e: 0, seg: 0 })).toBeNull()
    expect(polylineToChain([[0, 0], [1, 0], [1, 1], [0, 0]])!.segs).toHaveLength(3)
  })
})

describe('the drawn sketch in the engine', () => {
  it('names the crossing segment of a bow tie drawn with lines', async () => {
    const bow = draw('line', [[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]).sketch
    const c = await checkSketch(toLoops(bow))
    expect(c.ok).toBe(false)
    expect(c.issues[0]).toMatchObject({ loop: 0, kind: 'selfCrossing' })
  })

  it('extrudes a plate with a hole on the bed as a new body, in one undo step', async () => {
    const plate = draw('rect', [[100, 100], [140, 120]]).sketch
    const both = draw('circle', [[110, 110], [113, 110]], plate).sketch
    const loops = toLoops(both)
    const c = await checkSketch(loops)
    expect(c.ok).toBe(true)
    expect(c.loops.map((l) => l.role)).toEqual(['outer', 'hole'])
    const h = createHistory(appStore)
    const r = await applyExtrude(host, { frame: BED_FRAME, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm: 3, operation: 'new' }, name: 'Sketch body' })
    expect(r.message).toMatch(/^Added Sketch body, 2\.3\d cm³\.$/)
    expect(get().plate).toHaveLength(1)
    // The body keeps its place on the bed.
    expect(get().plate[0]!.transform[12]).toBeCloseTo(120)
    h.undo()
    expect(get().plate).toHaveLength(0)
    h.dispose()
  })

  it('offsets a loop and revolves a profile about one of its lines', async () => {
    const box = draw('rect', [[0, 0], [10, 20]]).sketch
    const off = await offsetSketch({ loops: toLoops(box) }, 2, 'miter')
    expect(off.areaMm2).toBeCloseTo(14 * 24)
    // A 10 by 20 profile turned about its left edge: a cylinder of radius 10, 20 tall.
    const r = await applyRevolve(host, { frame: { origin: [50, 50, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] }, loops: toLoops(box), axis: axisOf(box, { e: 0, seg: 3 })!, angleDeg: 360, operation: 'new', name: 'Revolved body' })
    expect(r.message).toMatch(/^Added Revolved body, 6\.2\d cm³\.$/)
  })
})
