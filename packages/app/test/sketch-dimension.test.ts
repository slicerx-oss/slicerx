// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension tool: what each pick makes, the value it starts from, what a driven one measures, how a set-off
// dimension draws, and that the solver never sees a driven one or where a value sits.
import { describe, expect, it } from 'vitest'
import { dimMark, sketchMarks, toSolver, type SketchConstraint } from '../src/cad/sketch-constraints'
import { dimensionFor, measured, pointHit } from '../src/cad/sketch-dimension'
import { rectangle, type Entity } from '../src/cad/sketch-model'

// corners (0,0) (20,0) (20,10) (0,10); segment 0 runs along the bottom
const rect = (): Entity[] => [rectangle([0, 0], [20, 10])]
const circle: Entity = { kind: 'circle', center: [40, 0], diameterMm: 8 }

describe('the dimension a pick makes', () => {
  it('gives a line its length, set off to the side the label went', () => {
    const c = dimensionFor(rect(), [{ curve: { e: 0, seg: 0 } }], [10, -5])
    expect(c).toEqual({ type: 'length', line: { e: 0, seg: 0 }, value: 20, offset: -5 })
  })

  it('gives a circle its diameter', () => {
    expect(dimensionFor([circle], [{ curve: { e: 0, seg: 0 } }], [50, 5])).toEqual({ type: 'diameter', circle: { e: 0, seg: 0 }, value: 8 })
  })

  it('measures two points across, level or upright by where the label goes', () => {
    const s = rect()
    const a = { point: { e: 0, at: 'start' as const } }
    const b = { point: { e: 0, at: 'to' as const, seg: 1 } }
    // above both: the level distance
    expect(dimensionFor(s, [a, b], [10, 15])).toMatchObject({ type: 'horizontalDistance', value: 20, offset: 10 })
    // off to the right of both: the upright one
    expect(dimensionFor(s, [a, b], [25, 5])).toMatchObject({ type: 'verticalDistance', value: 10, offset: 15 })
    // between them on both axes: straight across
    expect(dimensionFor(s, [a, b], [8, 6])?.type).toBe('distance')
    expect(dimensionFor(s, [a, b], [8, 6])?.value).toBeCloseTo(Math.hypot(20, 10))
  })

  it('gives two lines their angle, or their gap when parallel', () => {
    const s = rect()
    expect(dimensionFor(s, [{ curve: { e: 0, seg: 0 } }, { curve: { e: 0, seg: 1 } }], [5, 5])).toMatchObject({ type: 'angle', value: 90 })
    expect(dimensionFor(s, [{ curve: { e: 0, seg: 0 } }, { curve: { e: 0, seg: 2 } }], [5, 5])).toMatchObject({ type: 'lineDistance', value: 10 })
  })

  it('makes nothing from a circle and a line', () => {
    expect(dimensionFor([...rect(), circle], [{ curve: { e: 0, seg: 0 } }, { curve: { e: 1, seg: 0 } }], [0, 0])).toBeNull()
  })

  it('picks the nearest point, and a closed chain once at its start', () => {
    const s = rect()
    expect(pointHit(s, [0.2, 0.1], 1)).toEqual({ e: 0, at: 'start' })
    expect(pointHit(s, [19.5, 9.8], 1)).toEqual({ e: 0, at: 'to', seg: 1 })
    expect(pointHit(s, [10, 5], 1)).toBeNull()
  })
})

describe('driven dimensions', () => {
  const driven: SketchConstraint = { type: 'length', line: { e: 0, seg: 0 }, value: 99, driven: true }

  it('measure the sketch as drawn, and read in parentheses', () => {
    expect(measured(rect(), driven)).toBeCloseTo(20)
    const m = sketchMarks(rect(), [driven], (c) => measured(rect(), c))
    expect(m.dims.map((d) => d.label)).toEqual(['(20)'])
    expect(m.dims[0]!.of).toBe(0)
  })

  it('stay out of the solver, as does where a value sits', () => {
    const { solver, map } = toSolver(rect(), [driven, { type: 'length', line: { e: 0, seg: 1 }, value: 10, offset: 3, expr: 'h' }])
    expect(solver.constraints).toEqual([{ type: 'length', line: 1, value: 10 }])
    expect(map.from).toEqual([1])
    expect(map.dropped).toEqual([])
  })
})

describe('a set-off dimension', () => {
  it('runs beside the line with extension lines out to it', () => {
    const m = dimMark(rect(), { type: 'length', line: { e: 0, seg: 0 }, value: 20, offset: -4 }, 20, 0)!
    expect(m.from).toEqual([0, -4])
    expect(m.to).toEqual([20, -4])
    expect(m.ext).toHaveLength(2)
    expect(m.ext![0]![0]).toEqual([0, 0])
    // a little past the dimension line
    expect(m.ext![0]![1][1]).toBeLessThan(-4)
  })

  it('draws a level distance at the label height from where each point is', () => {
    const m = dimMark(rect(), { type: 'horizontalDistance', a: { e: 0, at: 'start' }, b: { e: 0, at: 'to', seg: 1 }, value: 20, offset: 10 }, 20, 0)!
    expect(m.from).toEqual([0, 15])
    expect(m.to).toEqual([20, 15])
  })

  it('puts an angle between its lines, in degrees', () => {
    const m = dimMark(rect(), { type: 'angle', a: { e: 0, seg: 0 }, b: { e: 0, seg: 1 }, value: 90 }, 90, 0)!
    expect(m.label).toBe('90°')
  })
})

describe('the sketch origin', () => {
  it('joins the solve held in place only when a dimension names it', () => {
    const s = rect()
    expect(toSolver(s, []).solver.points).toHaveLength(4)
    const { solver, map } = toSolver(s, [{ type: 'horizontalDistance', a: { e: -1, at: 'start' }, b: { e: 0, at: 'start' }, value: 0 }])
    expect(solver.points).toHaveLength(5)
    expect(solver.points[4]).toEqual([0, 0])
    expect(solver.constraints).toEqual([{ type: 'horizontalDistance', a: 4, b: 0, value: 0 }, { type: 'fix', point: 4 }])
    expect(map.from).toEqual([0, -1])
  })

  it('is a point the tool can pick', () => {
    expect(pointHit([rectangle([5, 5], [20, 10])], [0.3, -0.2], 1)).toEqual({ e: -1, at: 'start' })
  })
})
