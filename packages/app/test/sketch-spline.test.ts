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
import { fitKey, fromSolver, pointKey, splineCurveRefs, toSolver } from '../src/cad/sketch-constraints'
import { pointAt } from '../src/cad/sketch-dimension'
import { fromLoops, handles, moveHandle, profileRings, reverseChain, toLoops, type Chain } from '../src/cad/sketch-model'
import { SPLINE_TOL_MM, splinePoints } from '../src/cad/sketch-spline'
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

  it('draws the same curve the engine flattens', async () => {
    const c = await geom().call<{ ok: boolean; polygons: { outer: Vec2[] }[] }>('sketch.check', { loops: [BLOB] })
    expect(c.ok).toBe(true)
    const engine = c.polygons[0]!.outer
    const ours = splinePoints(BLOB.type === 'spline' ? BLOB.points : [], true).slice(0, -1)
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
    expect(again.parts[0]!.indices.length).toBeGreaterThan(boxMesh(40, 20, 5).indices.length)
  })
})
