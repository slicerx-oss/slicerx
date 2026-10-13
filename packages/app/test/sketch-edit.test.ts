// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch's edit tools with the engine: trim takes a piece back to its crossings and its constraints follow what is
// left, extend lands on the next curve and stays on it, mirror holds its copy symmetric, pattern adds free copies.
import { describe, expect, it } from 'vitest'
import { extendSketch, filletSketch, mirrorSketch, patternSketch, solveSketch, trimSketch } from '../src/geom/cad'
import { toSolver, type SketchConstraint } from '../src/cad/sketch-constraints'
import { afterEdit, endNear, heldEnds, mirrorConstraints, pointRefs, remapConstraints } from '../src/cad/sketch-edit'
import { fromLoops, hitTest, profileRings, rectangle, toLoops, type Entity, type V2 } from '../src/cad/sketch-model'
import { useGeomEngine } from './geom-engine'

useGeomEngine('sketch-edit-replies')

const line = (a: V2, b: V2): Entity => ({ kind: 'chain', start: a, segs: [{ kind: 'line', to: b }], closed: false })
const level: SketchConstraint[] = [
  { type: 'horizontal', line: { e: 0, seg: 0 } },
  { type: 'vertical', line: { e: 0, seg: 1 } },
  { type: 'horizontal', line: { e: 0, seg: 2 } },
  { type: 'vertical', line: { e: 0, seg: 3 } },
]
const solve = async (s: Entity[], c: SketchConstraint[]) => solveSketch(toSolver(s, c).solver)

describe('trim', () => {
  it('takes the piece under the cursor back to the crossings, and a lone curve whole', async () => {
    // a plus: trim the right arm of the level line
    const s = [line([0, 0], [10, 0]), line([5, -5], [5, 5])]
    const r = await trimSketch(toLoops(s), 0, 0, [8, 0])
    expect(r.from).toEqual([[0], [1]])
    const next = fromLoops(r.loops)!
    expect(next[0]).toEqual(line([0, 0], [5, 0]))
    expect(fromLoops([r.removed!])![0]).toEqual(line([5, 0], [10, 0]))
    const lone = await trimSketch(toLoops([line([0, 0], [1, 0])]), 0, 0, [0.5, 0])
    expect(lone.loops).toEqual([])
  })

  it('opens a rectangle crossed by a line, keeps what still holds, and leaves the new ends on the line', async () => {
    const s: Entity[] = [rectangle([0, 0], [20, 10]), line([10, -5], [10, 15])]
    const cons: SketchConstraint[] = [...level, { type: 'length', line: { e: 0, seg: 0 }, value: 20 }, { type: 'distance', a: { e: 0, at: 'start' }, b: { e: 0, at: 'to', seg: 1 }, value: 22.36 }]
    // the bottom side's right half goes
    const r = await trimSketch(toLoops(s), 0, 0, [15, 0])
    const next = fromLoops(r.loops)!
    const c = afterEdit(s, next, r, cons, 0)
    // the bottom keeps level on its left half; its length is gone with its end
    expect(c).toContainEqual({ type: 'horizontal', line: { e: 0, seg: 3 } })
    expect(c.some((x) => x.type === 'length')).toBe(false)
    // the corner at (20, 10) is still there, so the distance to it stays
    expect(c.filter((x) => x.type === 'distance')).toHaveLength(1)
    // the new end sits on the cutting line; the other end is the old corner
    const on = c.filter((x) => x.type === 'onLine')
    expect(on).toHaveLength(1)
    expect(on.every((x) => x.type === 'onLine' && x.line.e === 1)).toBe(true)
    const out = await solve(next, c)
    expect(out.status).toBe('ok')
  })

  it('trims two crossing rectangles down to their outline: one closed profile, its sides still level and upright', async () => {
    let s: Entity[] = [rectangle([0, 0], [10, 10]), rectangle([5, 5], [15, 15])]
    let c: SketchConstraint[] = [...level, ...level.map((x) => ({ ...x, line: { e: 1, seg: (x as { line: { seg: number } }).line.seg } }) as SketchConstraint)]
    // each corner inside the other rectangle goes, a side at a time
    for (const at of [[10, 8], [8, 10], [8, 5], [5, 8]] as V2[]) {
      const hit = hitTest(s, at, 0.01)!
      const r = await trimSketch(toLoops(s), hit.e, hit.seg, at)
      const next = fromLoops(r.loops)!
      c = afterEdit(s, next, r, c, hit.e)
      s = next
    }
    expect(s).toHaveLength(1)
    expect(profileRings(s)).toHaveLength(1)
    expect(c.filter((x) => x.type === 'horizontal')).toHaveLength(4)
    expect(c.filter((x) => x.type === 'vertical')).toHaveLength(4)
    const out = await solve(s, c)
    expect(out.status).toBe('ok')
  })

  it('turns a circle crossed twice into the arc left, keeping its radius', async () => {
    const s: Entity[] = [{ kind: 'circle', center: [0, 0], diameterMm: 10 }, line([-10, 0], [10, 0])]
    const r = await trimSketch(toLoops(s), 0, 0, [0, 5])
    const next = fromLoops(r.loops)!
    const arc = next[0]!
    expect(arc.kind).toBe('chain')
    const c = afterEdit(s, next, r, [{ type: 'radius', circle: { e: 0, seg: 0 }, value: 5 }, { type: 'fix', point: { e: 0, at: 'center' } }], 0)
    expect(c).toContainEqual({ type: 'radius', circle: { e: 0, seg: 0 }, value: 5 })
    expect(c).toContainEqual({ type: 'fix', point: { e: 0, at: 'arcCenter', seg: 0 } })
  })
})

describe('extend', () => {
  it('runs a line on to the next curve and holds the end there', async () => {
    const s = [line([0, 0], [2, 0]), line([5, -5], [5, 5])]
    expect(endNear(s, 0, 0, [1.8, 0])).toBe('end')
    const r = await extendSketch(toLoops(s), 0, 'end')
    const next = fromLoops(r.loops)!
    expect(next[0]).toEqual(line([0, 0], [5, 0]))
    const c = afterEdit(s, next, r, [{ type: 'horizontal', line: { e: 0, seg: 0 } }, { type: 'length', line: { e: 0, seg: 0 }, value: 2 }], 0)
    expect(c).toEqual([
      { type: 'horizontal', line: { e: 0, seg: 0 } },
      { type: 'onLine', point: { e: 0, at: 'to', seg: 0 }, line: { e: 1, seg: 0 } },
    ])
    await expect(extendSketch(toLoops(s), 1, 'start')).rejects.toThrow(/nothing to extend to/)
  })

  it('names no end for a closed loop or a middle segment', () => {
    const s: Entity[] = [rectangle([0, 0], [4, 4])]
    expect(endNear(s, 0, 0, [1, 0])).toBeNull()
  })
})

describe('mirror and pattern', () => {
  it('mirrors a loop across a sketch line, held symmetric to it, and the pair solves', async () => {
    const s: Entity[] = [rectangle([2, 0], [6, 4]), line([0, -5], [0, 10])]
    const r = await mirrorSketch(toLoops(s), [0], { point: [0, -5], direction: [0, 15] })
    const next = fromLoops(r.loops)!
    expect(r.from).toEqual([[0], [1], [0]])
    const sym = mirrorConstraints(next, [[0, 2]], { e: 1, seg: 0 })
    expect(sym).toHaveLength(pointRefs(next[0]!, 0).length)
    expect(sym.every((x) => x.type === 'symmetric')).toBe(true)
    const c = [...afterEdit(s, next, r, level), ...sym]
    const out = await solve(next, c)
    expect(out.status).toBe('ok')
    // the copy adds nothing to move: the original's freedom and the line's are all that is left
    const alone = await solve(s, level)
    expect(out.dof).toBe(alone.dof)
  })

  it('patterns copies along a step and round a center, the originals untouched', async () => {
    const s: Entity[] = [{ kind: 'circle', center: [10, 0], diameterMm: 2 }]
    const along = await patternSketch(toLoops(s), [0], { kind: 'line', count: 3, step: [5, 0] })
    expect(fromLoops(along.loops)!.map((e) => (e.kind === 'circle' ? e.center : null))).toEqual([[10, 0], [15, 0], [20, 0]])
    const round = await patternSketch(toLoops(s), [0], { kind: 'circle', count: 4, center: [0, 0], angleDeg: 360 })
    const c = fromLoops(round.loops)!.map((e) => (e.kind === 'circle' ? e.center.map((v) => Math.round(v * 1e6) / 1e6 + 0) : null))
    expect(c).toEqual([[10, 0], [0, 10], [-10, 0], [0, -10]])
    const kept = afterEdit(s, fromLoops(round.loops)!, round, [{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 2 }])
    expect(kept).toEqual([{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 2 }])
  })
})

describe('corner rounds keep constraints', () => {
  it('keeps level and upright on the shortened sides', async () => {
    const s: Entity[] = [rectangle([0, 0], [10, 6])]
    const r = await filletSketch(toLoops(s), [{ loop: 0, vertex: 1 }], 2)
    const next = fromLoops(r.loops)!
    const c = afterEdit(s, next, { from: [[0]] }, level)
    expect(c.filter((x) => x.type === 'horizontal')).toHaveLength(2)
    expect(c.filter((x) => x.type === 'vertical')).toHaveLength(2)
  })
})

describe('constraint remap', () => {
  it('re-indexes loops kept as they were and drops what names a removed loop', () => {
    const a = line([0, 0], [1, 0])
    const b = line([0, 2], [1, 2])
    const c: SketchConstraint[] = [{ type: 'horizontal', line: { e: 1, seg: 0 } }, { type: 'parallel', a: { e: 0, seg: 0 }, b: { e: 1, seg: 0 } }]
    expect(remapConstraints([a, b], [b], [[1]], c)).toEqual([{ type: 'horizontal', line: { e: 0, seg: 0 } }])
  })

  it('puts a lone curve constraint on each piece of a split line, and none twice', () => {
    const old = [line([0, 0], [10, 0])]
    const next = [line([0, 0], [4, 0]), line([6, 0], [10, 0])]
    const c: SketchConstraint[] = [{ type: 'horizontal', line: { e: 0, seg: 0 } }, { type: 'horizontal', line: { e: 0, seg: 0 } }]
    expect(remapConstraints(old, next, [[0], [0]], c)).toEqual([
      { type: 'horizontal', line: { e: 0, seg: 0 } },
      { type: 'horizontal', line: { e: 1, seg: 0 } },
    ])
  })

  it('holds a new end on a point that sits there rather than on the curve', () => {
    const old = [line([0, 0], [2, 0]), line([5, 0], [5, 5])]
    const next = [line([0, 0], [5, 0]), old[1]!]
    expect(heldEnds(old, next, [[0], [1]], 0)).toEqual([{ type: 'coincident', a: { e: 0, at: 'to', seg: 0 }, b: { e: 1, at: 'start' } }])
  })
})
