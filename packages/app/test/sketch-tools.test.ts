// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The drawing tools past line, 2-point rectangle, center circle and 3-point arc (cad/sketch-shapes.ts), each driven
// through click() as the panel does: the entity each one makes, closed shapes counterclockwise, and the typed values.
import { describe, expect, it } from 'vitest'
import { click, emptyDraft, fieldsFor, preview, tangentAtEnd, toLoops, typedPoint, type Chain, type DrawTool, type Entity, type V2 } from '../src/cad/sketch-model'

/** Clicks the points in turn with a tool on an empty (or given) sketch. */
function draw(tool: DrawTool, pts: V2[], sketch: Entity[] = [], sides?: number) {
  let s: Entity[] = sketch
  let d = emptyDraft(tool)
  for (const p of pts) ({ sketch: s, draft: d } = click(s, d, p, sides ? { sides } : {}))
  return { sketch: s, draft: d }
}
const corners = (c: Chain) => [c.start, ...c.segs.slice(0, -1).map((s) => s.to)].map(([x, y]) => [Math.round(x * 1000) / 1000 + 0, Math.round(y * 1000) / 1000 + 0])
const area = (c: Chain) => corners(c).reduce((a, p, i, all) => a + p[0]! * all[(i + 1) % all.length]![1]! - all[(i + 1) % all.length]![0]! * p[1]!, 0) / 2

describe('drawing tools', () => {
  it('3-point rectangle: an edge, then the width out to either side, at any angle', () => {
    const r = draw('rect3', [[0, 0], [10, 0], [3, 4]]).sketch[0] as Chain
    expect(corners(r)).toEqual([[0, 0], [10, 0], [10, 4], [0, 4]])
    expect(r.closed).toBe(true)
    // the other side and a tilted edge still run counterclockwise
    const below = draw('rect3', [[0, 0], [10, 0], [3, -4]]).sketch[0] as Chain
    expect(area(below)).toBeCloseTo(40)
    const tilted = draw('rect3', [[0, 0], [6, 8], [-8, 6]]).sketch[0] as Chain
    expect(area(tilted)).toBeCloseTo(100)
    // a width of nothing makes nothing
    expect(draw('rect3', [[0, 0], [10, 0], [5, 0]]).sketch).toEqual([])
  })

  it('center rectangle: the center, then a corner', () => {
    const r = draw('rectCenter', [[5, 5], [8, 7]]).sketch[0] as Chain
    expect(corners(r)).toEqual([[2, 3], [8, 3], [8, 7], [2, 7]])
  })

  it('2-point circle: the ends of a diameter', () => {
    expect(draw('circle2', [[0, 0], [10, 0]]).sketch).toEqual([{ kind: 'circle', center: [5, 0], diameterMm: 10 }])
  })

  it('center-point arc: the center, the start, then the end the short way round', () => {
    const { sketch } = draw('arcCenter', [[0, 0], [10, 0], [0, 25]])
    const c = sketch[0] as Chain
    expect(c.start).toEqual([10, 0])
    const arc = c.segs[0]!
    expect(arc.kind).toBe('arc')
    expect(arc.to[0]).toBeCloseTo(0)
    expect(arc.to[1]).toBeCloseTo(10)
    expect(arc.kind === 'arc' && Math.hypot(...arc.through)).toBeCloseTo(10)
  })

  it('tangent arc: only from the open end of a line, leaving along it, and on from its own end', () => {
    expect(draw('arcTangent', [[0, 0]]).draft.points).toEqual([])
    const line = draw('line', [[0, 0], [10, 0]]).sketch
    const { sketch, draft } = draw('arcTangent', [[10, 0], [10, 10]], line)
    const c = sketch[0] as Chain
    expect(c.segs).toHaveLength(2)
    const arc = c.segs[1]!
    // a half circle up from (10, 0) to (10, 10) bulges out to x = 15
    expect(arc.kind === 'arc' && arc.through[0]).toBeCloseTo(15)
    expect(arc.kind === 'arc' && arc.through[1]).toBeCloseTo(5)
    expect(draft.points).toEqual([[10, 10]])
    // its end now leaves to the left, back along -x
    const t = tangentAtEnd(c)!
    expect(t[0]).toBeCloseTo(-1)
    expect(t[1]).toBeCloseTo(0)
    // straight ahead is no arc
    expect(draw('arcTangent', [[10, 0], [20, 0]], line).sketch[0]).toEqual(line[0])
  })

  it('polygons: inscribed, circumscribed and by an edge, with the side count', () => {
    const hex = draw('polygon', [[0, 0], [10, 0]], [], 6).sketch[0] as Chain
    expect(hex.segs).toHaveLength(6)
    expect(corners(hex)[0]).toEqual([10, 0])
    // circumscribed: the edge's middle is where the cursor was
    const out = draw('polygonOut', [[0, 0], [10, 0]], [], 4).sketch[0] as Chain
    expect(corners(out)).toEqual([[10, 10], [-10, 10], [-10, -10], [10, -10]])
    const tri = draw('polygonEdge', [[0, 0], [10, 0], [5, 3]], [], 3).sketch[0] as Chain
    expect(tri.segs).toHaveLength(3)
    expect(area(tri)).toBeCloseTo((Math.sqrt(3) / 4) * 100)
    expect(Math.max(...corners(tri).map((p) => p[1]!))).toBeCloseTo(8.66, 2)
  })

  it('slots: center to center, overall and from the center, each with its width', () => {
    const s = draw('slot', [[0, 0], [20, 0], [10, 3]]).sketch[0] as Chain
    expect(s.closed).toBe(true)
    expect(s.segs.map((g) => g.kind)).toEqual(['line', 'arc', 'line', 'arc'])
    expect(toLoops([s])[0]).toMatchObject({ start: [0, -3] })
    expect(s.segs[1]!.kind === 'arc' && s.segs[1]!.through).toEqual([23, 0])
    const overall = draw('slotOverall', [[0, 0], [20, 0], [10, 3]]).sketch[0] as Chain
    expect(overall.start).toEqual([3, -3])
    const center = draw('slotCenter', [[10, 0], [20, 0], [10, 3]]).sketch[0] as Chain
    expect(center.start).toEqual([0, -3])
    // overall shorter than its width makes nothing
    expect(draw('slotOverall', [[0, 0], [4, 0], [2, 3]]).sketch).toEqual([])
  })

  it('takes typed sizes for each step, the cursor giving the side', () => {
    expect(fieldsFor({ tool: 'slot', points: [[0, 0], [20, 0]] }).map((f) => f.label)).toEqual(['Width'])
    expect(typedPoint({ tool: 'slot', points: [[0, 0], [20, 0]] }, [6], [10, -1])).toEqual([20, -3])
    expect(typedPoint({ tool: 'rect3', points: [[0, 0], [10, 0]] }, [4], [3, 9])).toEqual([10, 4])
    expect(typedPoint({ tool: 'rectCenter', points: [[0, 0]] }, [10, 4], [-1, 1])).toEqual([-5, 2])
    expect(typedPoint({ tool: 'circle2', points: [[0, 0]] }, [8], [0, 3])).toEqual([0, 8])
    const sweep = typedPoint({ tool: 'arcCenter', points: [[0, 0], [10, 0]] }, [90], [5, 5]) as V2
    expect(sweep[0]).toBeCloseTo(0)
    expect(sweep[1]).toBeCloseTo(10)
    expect(typedPoint({ tool: 'rect3', points: [[0, 0], [10, 0]] }, [0], [3, 9])).toMatch(/more than 0/)
  })

  it('previews the whole shape once the last click is next', () => {
    expect(preview({ tool: 'rect3', points: [[0, 0], [10, 0]] }, [3, 4])).toHaveLength(5)
    expect(preview({ tool: 'rect3', points: [[0, 0]] }, [3, 4])).toEqual([[0, 0], [3, 4]])
    expect(preview({ tool: 'polygon', points: [[0, 0]] }, [10, 0], { sides: 5 }).length).toBe(6)
  })
})
