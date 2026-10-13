// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch's constraints: the solver sketch built from chains and circles, the drawing moved back from a solve, the
// colors a solve gives each curve, constraints kept in the project file, and old sketches loading as free geometry.
import { describe, expect, it } from 'vitest'
import { historyFiles, parseHistories, type History, type SketchConstraint, type StepParams } from '@slicerx/cad-history'
import { afterLoopChange, curveStates, dofText, dofTone, fromSolver, sketchMarks, toSolver } from '../src/cad/sketch-constraints'
import { DEFAULT_UNITS, formatLength } from '../src/cad/units'
import { fromLoops, rectangle, type Entity } from '../src/cad/sketch-model'
import { boxMesh } from '../src/plate/mesh-ops'

const square = (): Entity[] => [rectangle([0, 0], [10, 10])]
const near = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) < 1e-6

describe('the solver sketch', () => {
  it('shares the corners of a closed chain', () => {
    const { solver, map } = toSolver(square(), [])
    expect(solver.points).toHaveLength(4)
    expect(solver.entities).toEqual([
      { type: 'line', a: 0, b: 1 },
      { type: 'line', a: 1, b: 2 },
      { type: 'line', a: 2, b: 3 },
      { type: 'line', a: 3, b: 0 },
    ])
    expect(map.point.get('0:to:3')).toBe(0)
  })

  it('maps constraints to indices and leaves out ones naming what is gone', () => {
    const constraints: SketchConstraint[] = [
      { type: 'fix', point: { e: 0, at: 'start' } },
      { type: 'horizontal', line: { e: 0, seg: 0 } },
      { type: 'length', line: { e: 0, seg: 1 }, value: 12 },
      { type: 'vertical', line: { e: 3, seg: 0 } },
    ]
    const { solver, map } = toSolver(square(), constraints)
    expect(solver.constraints).toEqual([
      { type: 'fix', point: 0 },
      { type: 'horizontal', line: 0 },
      { type: 'length', line: 1, value: 12 },
    ])
    expect(map.dropped).toEqual([3])
    expect(map.from).toEqual([0, 1, 2])
  })

  it('turns a clockwise three point arc into a counterclockwise arc about its center', () => {
    const chain: Entity = { kind: 'chain', start: [10, 0], segs: [{ kind: 'arc', to: [-10, 0], through: [0, -10] }], closed: false }
    const { solver } = toSolver([chain], [])
    expect(solver.entities[0]).toEqual({ type: 'arc', center: 2, start: 1, end: 0 })
    expect(near(solver.points[2]!, [0, 0])).toBe(true)
  })

  it('gives a circle its center and radius', () => {
    const { solver } = toSolver([{ kind: 'circle', center: [3, 4], diameterMm: 10 }], [{ type: 'radius', circle: { e: 0, seg: 0 }, value: 6 }])
    expect(solver.entities).toEqual([{ type: 'circle', center: 0, radius: 5 }])
    expect(solver.constraints).toEqual([{ type: 'radius', circle: 0, value: 6 }])
  })
})

describe('the drawing after a solve', () => {
  it('moves shared corners together and keeps a closed chain closed', () => {
    const s = square()
    const { solver, map } = toSolver(s, [])
    const points = solver.points.map((p) => [p[0] * 2, p[1]] as [number, number])
    const out = fromSolver(s, { points, radii: solver.entities.map(() => null) }, map)
    const c = out[0] as Extract<Entity, { kind: 'chain' }>
    expect(c.start).toEqual([0, 0])
    expect(c.segs.map((g) => g.to)).toEqual([[20, 0], [20, 10], [0, 10], [0, 0]])
  })

  it('keeps an arc going the way it went, through its new middle', () => {
    const chain: Entity = { kind: 'chain', start: [10, 0], segs: [{ kind: 'arc', to: [-10, 0], through: [0, -10] }], closed: false }
    const { solver, map } = toSolver([chain], [])
    // twice the size about the same center
    const points = solver.points.map((p) => [p[0] * 2, p[1] * 2] as [number, number])
    const out = fromSolver([chain], { points, radii: [null] }, map)[0] as Extract<Entity, { kind: 'chain' }>
    const arc = out.segs[0]!
    expect(arc.kind === 'arc' && near(arc.through, [0, -20])).toBe(true)
  })

  it('sets a circle to its solved radius', () => {
    const s: Entity[] = [{ kind: 'circle', center: [0, 0], diameterMm: 10 }]
    const { map } = toSolver(s, [])
    expect(fromSolver(s, { points: [[1, 1]], radii: [6] }, map)).toEqual([{ kind: 'circle', center: [1, 1], diameterMm: 12 }])
  })
})

describe('colors from the solve', () => {
  const s = square()
  const fix: SketchConstraint[] = [{ type: 'fix', point: { e: 0, at: 'start' } }, { type: 'fix', point: { e: 0, at: 'to', seg: 0 } }]
  const { map } = toSolver(s, fix)

  it('is free while points can move', () => {
    const states = curveStates(s, fix, { freePoints: [false, false, true, true], freeRadii: [] }, map)
    expect([...states.values()]).toEqual(['fixed', 'free', 'free', 'free'])
  })

  it('is defined when nothing can move, fixed where Fix holds both ends', () => {
    const states = curveStates(s, fix, { freePoints: [false, false, false, false], freeRadii: [] }, map)
    expect([...states.values()]).toEqual(['fixed', 'defined', 'defined', 'defined'])
  })

  it('says how defined the sketch is', () => {
    expect(dofText({ status: 'ok', dof: 0 })).toBe('Fully constrained')
    expect(dofText({ status: 'ok', dof: 1 })).toBe('1 degree of freedom left')
    expect(dofText({ status: 'ok', dof: 3 })).toBe('3 degrees of freedom left')
    expect(dofText({ status: 'redundant', dof: 1 })).toBe('Over-constrained: a constraint repeats another')
    expect(dofText({ status: 'conflict', dof: 0 })).toBe('Over-constrained: some constraints conflict')
    expect([dofTone({ status: 'ok', dof: 0 }), dofTone({ status: 'ok', dof: 2 }), dofTone({ status: 'conflict', dof: 0 }), dofTone({ status: 'redundant', dof: 1 })]).toEqual(['done', 'open', 'warn', 'warn'])
  })
})

describe('constraints after an edit', () => {
  const cs: SketchConstraint[] = [
    { type: 'horizontal', line: { e: 0, seg: 0 } },
    { type: 'radius', circle: { e: 1, seg: 0 }, value: 2 },
    { type: 'concentric', a: { e: 1, seg: 0 }, b: { e: 2, seg: 0 } },
    { type: 'radius', circle: { e: 2, seg: 0 }, value: 3 },
  ]

  it('drops what names a deleted loop and shifts the rest', () => {
    expect(afterLoopChange(cs, 1, 0)).toEqual([
      { type: 'horizontal', line: { e: 0, seg: 0 } },
      { type: 'radius', circle: { e: 1, seg: 0 }, value: 3 },
    ])
  })

  it('shifts later loops when one splits in two', () => {
    expect(afterLoopChange(cs, 0, 2)[2]).toEqual({ type: 'radius', circle: { e: 3, seg: 0 }, value: 3 })
  })
})

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const FRAME = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] } as const

function roundTrip(params: StepParams): StepParams | undefined {
  const history: History = { version: 1, base: [boxMesh(10, 10, 5)], steps: [{ id: 's1', part: 0, transform: T, params }] }
  const files = new Map(historyFiles([{ id: 'o1', history }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))
  return parseHistories(files, new Set(['1'])).get('1')?.steps[0]?.params
}

describe('constraints in the project file', () => {
  const loops = [{ start: [0, 0] as [number, number], segments: [{ type: 'line' as const, to: [10, 0] as [number, number] }, { type: 'line' as const, to: [10, 10] as [number, number] }, { type: 'line' as const, to: [0, 0] as [number, number] }] }]
  const constraints: SketchConstraint[] = [
    { type: 'fix', point: { e: 0, at: 'start' } },
    { type: 'length', line: { e: 0, seg: 0 }, value: 10 },
  ]

  it('come back with an extrude and a revolve', () => {
    const extrude: StepParams = { op: 'shape.extrude', frame: FRAME as never, shape: { type: 'sketch', loops, constraints }, placement: {}, spec: { distanceMm: 5 } }
    expect(roundTrip(extrude)).toEqual(extrude)
    const revolve: StepParams = { op: 'sketch.revolve', loops, constraints, axis: { point: [0, 0], direction: [0, 1] } }
    expect(roundTrip(revolve)).toEqual(revolve)
  })

  it('that do not read drop the step', () => {
    const bad = { op: 'sketch.revolve', loops, constraints: [{ type: 'fix', point: 'start' }], axis: { point: [0, 0], direction: [0, 1] } }
    expect(roundTrip(bad as unknown as StepParams)).toBeUndefined()
  })

  it('an old sketch with none loads as free geometry', () => {
    const old: StepParams = { op: 'shape.extrude', frame: FRAME as never, shape: { type: 'sketch', loops }, placement: {}, spec: { distanceMm: 5 } }
    const back = roundTrip(old)
    expect(back).toEqual(old)
    const shape = back?.op === 'shape.extrude' ? back.shape : null
    const sketch = fromLoops(shape?.type === 'sketch' ? shape.loops : [])!
    const { solver } = toSolver(sketch, (shape?.type === 'sketch' ? shape.constraints : undefined) ?? [])
    expect(solver.constraints).toEqual([])
    expect(solver.points).toHaveLength(3)
  })

  it('draws a dimension for each driving value and a mark on each fixed point', () => {
    const circle: Entity = { kind: 'circle', center: [0, 0], diameterMm: 8 }
    const m = sketchMarks([circle, ...square()], [
      { type: 'fix', point: { e: 0, at: 'center' } },
      { type: 'diameter', circle: { e: 0, seg: 0 }, value: 8 },
      { type: 'length', line: { e: 1, seg: 1 }, value: 12 },
      { type: 'horizontal', line: { e: 1, seg: 0 } },
    ])
    expect(m.fixed).toEqual([[0, 0]])
    expect(m.dims.map((d) => d.label)).toEqual(['\u23008', '12'])
    expect(Math.hypot(m.dims[0]!.to[0] - m.dims[0]!.from[0], m.dims[0]!.to[1] - m.dims[0]!.from[1])).toBeCloseTo(8)
    // the diameter's value sits past the rim, clear of the fixed center
    expect(Math.hypot(...m.dims[0]!.at!)).toBeGreaterThan(4)
  })

  it('writes dimension values in the display unit', () => {
    const circle: Entity = { kind: 'circle', center: [0, 0], diameterMm: 12.7 }
    const cons = [
      { type: 'diameter', circle: { e: 0, seg: 0 }, value: 12.7 },
      { type: 'radius', circle: { e: 0, seg: 0 }, value: 6.35 },
      { type: 'length', line: { e: 1, seg: 1 }, value: 25.4 },
    ] as const
    const inches = sketchMarks([circle, ...square()], cons, undefined, (mm) => formatLength(mm, { ...DEFAULT_UNITS, length: 'in' }))
    expect(inches.dims.map((d) => d.label)).toEqual(['\u23000.500', 'R0.250', '1.000'])
    const halves = sketchMarks([circle, ...square()], cons, undefined, (mm) => formatLength(mm, { ...DEFAULT_UNITS, length: 'in', inchFraction: 16 }))
    expect(halves.dims.map((d) => d.label)).toEqual(['\u23001/2', 'R1/4', '1'])
  })
})
