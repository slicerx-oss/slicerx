// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A value typed in a box drives the shape through the engine's solver (sketch.solve): a rectangle takes its width and
// height and stays square, a line turns to the typed angle from the X axis (not the opposite way) and keeps its
// length, a circle takes its diameter, a size the sketch already has is kept driven and moves nothing, and an emptied
// box frees its size again.
import { describe, expect, it } from 'vitest'
import { setBox } from '../src/cad/sketch-boxes'
import { X_AXIS, type SketchConstraint } from '../src/cad/sketch-constraints'
import { rectangle, type Entity, type V2 } from '../src/cad/sketch-model'
import { useGeomEngine } from './geom-engine'

useGeomEngine('sketch-boxes-solve')

const r3 = (p: V2): V2 => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]
const corners = (s: Entity[]) => {
  const e = s[0]!
  if (e.kind !== 'chain') throw new Error('not a chain')
  return [e.start, ...e.segs.slice(0, -1).map((g) => g.to)].map(r3)
}
// a 20 by 10 rectangle, its sides level and upright as the rectangle tool leaves them
const level: SketchConstraint[] = [
  { type: 'horizontal', line: { e: 0, seg: 0 } },
  { type: 'vertical', line: { e: 0, seg: 1 } },
  { type: 'horizontal', line: { e: 0, seg: 2 } },
  { type: 'vertical', line: { e: 0, seg: 3 } },
]

describe('setting a box', () => {
  it('drives a rectangle width and height and keeps it square', async () => {
    const a = await setBox([rectangle([10, 10], [30, 20])], level, { kind: 'rect', e: 0 }, 'width', 25)
    expect(a.driven).toBe(false)
    const b = await setBox(a.sketch, a.constraints, { kind: 'rect', e: 0 }, 'height', 12)
    expect(corners(b.sketch)).toEqual([[10, 10], [35, 10], [35, 22], [10, 22]])
    expect(b.constraints.slice(4)).toEqual([{ type: 'length', line: { e: 0, seg: 0 }, value: 25 }, { type: 'length', line: { e: 0, seg: 1 }, value: 12 }])
    expect(b.solved.dof).toBe(2)
    // a new width replaces the one there, it never adds a second
    const c = await setBox(b.sketch, b.constraints, { kind: 'rect', e: 0 }, 'width', 40)
    expect(c.constraints.filter((x) => x.type === 'length')).toHaveLength(2)
    expect(corners(c.sketch)[1]).toEqual([50, 10])
  })

  it('turns a line to a typed angle from the X axis and keeps its length', async () => {
    const line: Entity[] = [{ kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [10, 0] }], closed: false }]
    const a = await setBox(line, [], { kind: 'line', e: 0, seg: 0 }, 'length', 20)
    const b = await setBox(a.sketch, a.constraints, { kind: 'line', e: 0, seg: 0 }, 'angle', 120)
    const e = b.sketch[0]!
    if (e.kind !== 'chain') throw new Error('not a chain')
    const d: V2 = [e.segs[0]!.to[0] - e.start[0], e.segs[0]!.to[1] - e.start[1]]
    expect(Math.hypot(d[0], d[1])).toBeCloseTo(20, 4)
    // 120 degrees, not the 300 the same line read backward would give
    expect((Math.atan2(d[1], d[0]) * 180) / Math.PI).toBeCloseTo(120, 3)
    expect(b.constraints).toContainEqual({ type: 'angle', a: X_AXIS, b: { e: 0, seg: 0 }, value: 120 })
  })

  it('drives a circle diameter', async () => {
    const r = await setBox([{ kind: 'circle', center: [5, 5], diameterMm: 8 }], [], { kind: 'circle', e: 0 }, 'diameter', 12.5)
    expect(r.sketch[0]).toMatchObject({ kind: 'circle', diameterMm: 12.5 })
    expect(r.solved.dof).toBe(2)
  })

  it('keeps a size the sketch already has driven, moving nothing, and frees a box emptied', async () => {
    const sized = [...level, { type: 'length', line: { e: 0, seg: 2 }, value: 20 } as SketchConstraint]
    const r = await setBox([rectangle([10, 10], [30, 20])], sized, { kind: 'rect', e: 0 }, 'width', 30)
    // the top's length is the width already: replaced by the box's own, which drives
    expect(r.driven).toBe(false)
    expect(corners(r.sketch)[1]).toEqual([40, 10])
    // a height on a rectangle whose four corners are held is over-defined: kept driven, nothing moves
    const held: SketchConstraint[] = [...level, { type: 'fix', point: { e: 0, at: 'start' } }, { type: 'fix', point: { e: 0, at: 'to', seg: 1 } }]
    const over = await setBox([rectangle([10, 10], [30, 20])], held, { kind: 'rect', e: 0 }, 'height', 15)
    expect(over.driven).toBe(true)
    expect(over.constraints[over.constraints.length - 1]).toEqual({ type: 'length', line: { e: 0, seg: 1 }, value: 10, driven: true })
    expect(corners(over.sketch)).toEqual([[10, 10], [30, 10], [30, 20], [10, 20]])
    // emptied: the dimension goes, and the size is free again
    const freed = await setBox(r.sketch, r.constraints, { kind: 'rect', e: 0 }, 'width', null)
    expect(freed.constraints).toEqual(level)
    expect(freed.solved.dof).toBe(4)
  })

  it('refuses a size of 0', async () => {
    await expect(setBox([rectangle([0, 0], [1, 1])], [], { kind: 'rect', e: 0 }, 'width', 0)).rejects.toThrow(/more than 0/)
  })
})
