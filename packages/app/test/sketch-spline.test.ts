// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Splines in sketches: the drawing reads and writes them as their points, the solver bridge keeps those points as
// plain points, the drawn curve matches the engine's, and a design step keeps the points, so a replay draws the same
// solid again.
import type { MeshPart } from '@slicerx/contracts'
import { historyFiles, parseHistories, type History, type SketchLoop, type StepParams, type Vec2 } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'
import { runReplay } from '../src/cad/history/ops'
import { withStep } from '../src/cad/history/record'
import { appDesignHost } from '../src/cad/design-host'
import { afterReverse, fitKey, fromSolver, pointKey, splineCurveRefs, toSolver, type SketchConstraint } from '../src/cad/sketch-constraints'
import { pointAt, settle } from '../src/cad/sketch-dimension'
import { entityPaths, fromLoops, handles, moveHandle, profileRings, reverseChain, segPath, tangentAtEnd, toLoops, type Chain } from '../src/cad/sketch-model'
import { flattenSpan, RING_POINTS, span, SPLINE_TOL_MM, splineEndDir, splinePoints } from '../src/cad/sketch-spline'
import { geom } from '../src/geom/client'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { useGeomEngine } from './geom-engine'

useGeomEngine('sketch-spline-replies', { compressed: true })

const D: SketchLoop = { start: [0, 0], segments: [{ type: 'line', to: [12, 0] }, { type: 'spline', points: [[16, 5], [11, 11]], to: [0, 10] }, { type: 'line', to: [0, 0] }] }
const BLOB: SketchLoop = { type: 'spline', points: [[6, 0], [2, 5], [-5, 3], [-4, -4], [3, -5]] }

describe('splines in the drawing', () => {
  it('reads and writes a spline segment and a closed spline loop as their points', () => {
    const drawn = fromLoops([D, BLOB])!
    expect(drawn).not.toBeNull()
    expect(drawn[0]).toMatchObject({ kind: 'chain', closed: true, segs: [{ kind: 'line' }, { kind: 'spline', points: [[16, 5], [11, 11]], to: [0, 10] }, { kind: 'line' }] })
    expect(drawn[1]).toMatchObject({ kind: 'chain', closed: true, smooth: true, start: [6, 0] })
    expect(toLoops(drawn)).toEqual([D, BLOB])
    // turned round, a spline runs through its points the other way
    const back = reverseChain(drawn[0] as Chain)
    expect(back.segs[1]).toEqual({ kind: 'spline', points: [[11, 11], [16, 5]], to: [12, 0] })
    // its points are handles, and dragging one moves only it
    const h = handles(drawn)
    const at = h.refs.findIndex((r) => r.at === 'point' && r.e === 0 && r.seg === 1 && r.i === 1)
    expect(h.points[at]).toEqual([11, 11])
    const moved = moveHandle(drawn, h.refs[at]!, [10, 12])
    expect((moved[0] as Chain).segs[1]).toEqual({ kind: 'spline', points: [[16, 5], [10, 12]], to: [0, 10] })
    expect(profileRings(drawn)).toHaveLength(2)
  })

  it('keeps spline points as plain solver points, and refuses a spline named as a curve', () => {
    const drawn = fromLoops([D, BLOB])!
    const held = { e: 0, at: 'point' as const, seg: 1, i: 0 }
    const cons = [
      { type: 'fix' as const, point: held },
      { type: 'horizontalDistance' as const, a: { e: 1, at: 'point' as const, i: 0 }, b: { e: 1, at: 'point' as const, i: 2 }, value: 12 },
    ]
    const { solver, map } = toSolver(drawn, cons)
    // the D's two lines are its only curves; the splines add their points and no entity
    expect(solver.entities.map((x) => x.type)).toEqual(['line', 'line'])
    const fit = map.point.get(pointKey(held))!
    expect(solver.points[fit]).toEqual([16, 5])
    expect(map.point.get(fitKey(1, undefined, 0))).toBe(map.point.get('1:start'))
    expect(solver.constraints).toEqual([
      { type: 'fix', point: fit },
      { type: 'horizontalDistance', a: map.point.get('1:start'), b: map.point.get(fitKey(1, undefined, 2)), value: 12 },
    ])
    const points = solver.points.map((p): Vec2 => [p[0] + 1, p[1]])
    const after = fromSolver(drawn, { points, radii: [] }, map)
    expect((after[0] as Chain).segs[1]).toEqual({ kind: 'spline', points: [[17, 5], [12, 11]], to: [1, 10] })
    expect((after[1] as Chain).segs[0]).toMatchObject({ kind: 'spline', points: [[3, 5], [-4, 3], [-3, -4], [4, -5]], to: [7, 0] })
    expect(pointAt(after, { e: 1, at: 'point', i: 0 })).toEqual([7, 0])
    expect(splineCurveRefs(drawn, [{ type: 'horizontal', line: { e: 0, seg: 0 } }, { type: 'tangent', a: { e: 0, seg: 0 }, b: { e: 0, seg: 1 } }])).toEqual([1])
  })

  it('leaves a spline it cannot read for the caller to name, and draws a refused one through its points', () => {
    // no end, no points: fromLoops says it cannot read it rather than throwing in the view
    expect(fromLoops([{ start: [0, 0], segments: [{ type: 'spline', points: [[5, 5], [10, 0]] } as never] }])).toBeNull()
    expect(fromLoops([{ start: [0, 0], segments: [{ type: 'spline', to: [10, 0] } as never] }])).toBeNull()
    expect(fromLoops([{ type: 'spline' } as never])).toBeNull()
    // a span past the step limit is refused, as the engine refuses it, and the drawing falls back to straight sides
    expect(flattenSpan(span([-90000, 0], [0, 0], [90000, 0], [90000, 10]))).toBeNull()
    const sharp: Chain = { kind: 'chain', start: [0, 0], segs: [{ kind: 'spline', points: [[90000, 0]], to: [90000, 10] }], closed: false }
    expect(splinePoints([[0, 0], [90000, 0], [90000, 10]], false)).toBeNull()
    expect(segPath(sharp, 0)).toEqual([[0, 0], [90000, 0], [90000, 10]])
    // past the point budget
    // a circle without its center or size is unread too
    expect(fromLoops([{ type: 'circle', start: [0, 0], segments: [] } as never])).toBeNull()
    // the budget counts the points after the first: exactly enough draws, one fewer does not
    const ok = splinePoints([[0, 0], [10, 5], [20, 0]], false)!
    expect(splinePoints([[0, 0], [10, 5], [20, 0]], false, ok.length - 1)).toEqual(ok)
    expect(splinePoints([[0, 0], [10, 5], [20, 0]], false, ok.length - 2)).toBeNull()
    expect(RING_POINTS).toBe(65536)
    // two spline segments share their loop's room, as in the engine: the second past it draws through its points
    const zig = (x0: number): Vec2[] => Array.from({ length: 199 }, (_, i) => [x0 + (i + 1) * 2, i % 2 ? 200 : -200])
    const two: Chain = { kind: 'chain', start: [0, 0], segs: [{ kind: 'spline', points: zig(0), to: [400, 0] }, { kind: 'spline', points: zig(400), to: [800, 0] }], closed: false }
    const [first, second] = entityPaths(two)
    expect(first!.points.length).toBeGreaterThan(RING_POINTS / 2)
    expect(second!.points).toEqual([[400, 0], ...zig(400), [800, 0]])
  })

  it('leaves a spline along its end, for a tangent arc after it', () => {
    const c: Chain = { kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [10, 0] }, { kind: 'spline', points: [[20, 4]], to: [24, 14] }], closed: false }
    const d = tangentAtEnd(c)!
    const pts = segPath(c, 1)
    const a = pts[pts.length - 2]!
    const b = pts[pts.length - 1]!
    const e: Vec2 = [(b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]), (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1])]
    expect(d[0] * e[0] + d[1] * e[1]).toBeGreaterThan(0.999)
    expect(d[1]).toBeGreaterThan(Math.abs(d[0]) * 0.5)
    expect(splineEndDir([[10, 0], [20, 4], [24, 14]])).toEqual(d)
  })

  it('turns spline point references round with their chain', () => {
    const cons: SketchConstraint[] = [
      { type: 'fix', point: { e: 0, at: 'point', seg: 1, i: 0 } },
      { type: 'fix', point: { e: 0, at: 'point', seg: 1, i: 1 } },
      { type: 'fix', point: { e: 1, at: 'point', seg: 1, i: 0 } },
    ]
    expect(afterReverse(cons, 0, 3, [0, 2, 0])).toEqual([
      { type: 'fix', point: { e: 0, at: 'point', seg: 1, i: 1 } },
      { type: 'fix', point: { e: 0, at: 'point', seg: 1, i: 0 } },
      { type: 'fix', point: { e: 1, at: 'point', seg: 1, i: 0 } },
    ])
    expect(afterReverse([{ type: 'fix', point: { e: 0, at: 'point', seg: 0, i: 2 } }], 0, 2, [3, 0])).toEqual([{ type: 'fix', point: { e: 0, at: 'point', seg: 1, i: 0 } }])
  })

  it('solves spline points under point constraints', async () => {
    const drawn = fromLoops([D])!
    const cons: SketchConstraint[] = [
      { type: 'fix', point: { e: 0, at: 'start' } },
      { type: 'horizontalDistance', a: { e: 0, at: 'start' }, b: { e: 0, at: 'point', seg: 1, i: 0 }, value: 20 },
    ]
    const r = await settle(drawn, cons)
    expect(r.solved.status).toBe('ok')
    // five free points (start, two corners, two spline points) less the fix and the distance
    expect(r.solved.dof).toBe(7)
    const p = pointAt(r.sketch, { e: 0, at: 'point', seg: 1, i: 0 })!
    expect(p[0]).toBeCloseTo(20, 6)
  })

  it('refuses constraints on a spline curve, and ones the solve would leave out, before they reach the timeline', async () => {
    const host = appDesignHost({ loadParts: async () => ({ id: 'h', hash: 'h', name: 'h', triangles: 0, bboxMm: [0, 0, 0], openEdges: 0, parts: [] }) })
    const tangent = [{ type: 'tangent', a: { e: 0, seg: 0 }, b: { e: 0, seg: 1 } }] as SketchConstraint[]
    await expect(host.settleSketch!({ loops: [D], constraints: tangent })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/name a spline as a curve/) })
    // a closed spline loop's points go by i alone; one given a segment is not in the sketch
    const stray = [{ type: 'fix', point: { e: 0, at: 'point', seg: 0, i: 1 } }] as SketchConstraint[]
    await expect(host.settleSketch!({ loops: [BLOB], constraints: stray })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/does not have/) })
    const blob = fromLoops([BLOB])!
    const d = fromLoops([D])!
    expect(pointAt(blob, { e: 0, at: 'point', seg: 0, i: 1 })).toBeNull()
    expect(pointAt(blob, { e: 0, at: 'point', i: 1 })).toEqual([2, 5])
    for (const i of [1.5, -1, 9]) expect(pointAt(blob, { e: 0, at: 'point', i })).toBeNull()
    expect(pointAt(d, { e: 0, at: 'point', i: 0 })).toBeNull()
    expect(pointAt(d, { e: 0, at: 'point', seg: 1, i: 1 })).toEqual([11, 11])
  })

  it('draws the same curve the engine flattens', async () => {
    const c = await geom().call<{ ok: boolean; polygons: { outer: Vec2[] }[] }>('sketch.check', { loops: [BLOB] })
    expect(c.ok).toBe(true)
    const engine = c.polygons[0]!.outer
    const ours = splinePoints(BLOB.type === 'spline' ? BLOB.points : [], true)!.slice(0, -1)
    expect(ours.length).toBe(engine.length)
    for (const p of ours) expect(Math.min(...engine.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])))).toBeLessThan(1e-9)
    expect(SPLINE_TOL_MM).toBe(0.005)
  })
})

describe('splines in the design history', () => {
  const T = compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  const top = { origin: [100, 100, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
  const side = { origin: [100, 90, 5] as [number, number, number], normal: [0, -1, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number] }
  const profile: SketchLoop = { start: [0, 0], segments: [{ type: 'line', to: [0, 8] }, { type: 'spline', points: [[3, 6], [4, 3]], to: [3, 0] }, { type: 'line', to: [0, 0] }] }

  function design(): History {
    let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(40, 20, 5)], transform: T }
    const steps: StepParams[] = [
      { op: 'shape.extrude', frame: top, shape: { type: 'sketch', loops: [BLOB] }, placement: {}, spec: { distanceMm: 4, operation: 'join' } },
      { op: 'sketch.revolve', frame: side, loops: [profile], axis: { point: [0, 0], direction: [0, 1] }, angleDeg: 360, operation: 'join' },
    ]
    for (const p of steps) e = { ...e, history: withStep(e, 0, p) }
    return e.history!
  }

  it('stores the spline points, not the flattened curve, and replays to the same solid', async () => {
    const h = design()
    const first = await runReplay({ history: h })
    const files = historyFiles([{ id: 'a', history: h }], new Map([['a', 3]]))
    const json = files.find((f) => f.name === 'Metadata/slicerx_history.json')!.data as string
    // the step holds the five points it was given, and no ring of flattened ones
    expect(json).toContain('"type":"spline","points":[[6,0],[2,5],[-5,3],[-4,-4],[3,-5]]')
    expect(json).toContain('"type":"spline","points":[[3,6],[4,3]],"to":[3,0]')
    const map = new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
    const back = parseHistories(map, new Set(['3'])).get('3')!
    expect(back.steps.map((s) => s.params)).toEqual(h.steps.map((s) => s.params))
    const again = await runReplay({ history: back })
    expect(again.parts.length).toBe(first.parts.length)
    expect(Array.from(again.parts[0]!.positions)).toEqual(Array.from(first.parts[0]!.positions))
    expect(Array.from(again.parts[0]!.indices)).toEqual(Array.from(first.parts[0]!.indices))
    // the box, the spline blob extruded 4 mm and the spline profile turned round, none of them overlapping
    const ring = (pts: Vec2[]) => pts.reduce((a, p, k) => a + (p[0] * pts[(k + 1) % pts.length]![1] - pts[(k + 1) % pts.length]![0] * p[1]) / 2, 0)
    const blob = splinePoints(BLOB.type === 'spline' ? BLOB.points : [], true)!.slice(0, -1)
    const side = [[0, 0] as Vec2, [0, 8] as Vec2, ...splinePoints([[0, 8], [3, 6], [4, 3], [3, 0]], false)!.slice(1, -1)]
    const a = ring(side)
    const cx = side.reduce((t, p, k) => t + (p[0] + side[(k + 1) % side.length]![0]) * (p[0] * side[(k + 1) % side.length]![1] - side[(k + 1) % side.length]![0] * p[1]), 0) / (6 * a)
    const want = 40 * 20 * 5 + Math.abs(ring(blob)) * 4 + 2 * Math.PI * Math.abs(cx) * Math.abs(a)
    const v = volume(again.parts[0]!)
    expect(Math.abs(v - want) / want).toBeLessThan(5e-3)
    const zs = Array.from(again.parts[0]!.positions).filter((_, k) => k % 3 === 2)
    expect(Math.max(...zs)).toBeCloseTo(13, 3)
  })
})

/** A closed mesh's volume, from the triangles' signed tetrahedra. */
function volume(m: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
  const p = m.positions
  let v = 0
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const [a, b, c] = [m.indices[k]! * 3, m.indices[k + 1]! * 3, m.indices[k + 2]! * 3]
    v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6
  }
  return Math.abs(v)
}
