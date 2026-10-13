// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What drawing leaves behind (cad/sketch-infer.ts): constraints from each click, driven through click() and dragArc()
// as the panel does, the drag-tangent arc off a line's end, and the glyphs each constraint draws.
import { describe, expect, it } from 'vitest'
import { afterReverse, glyphsOf, toSolver, type SketchConstraint } from '../src/cad/sketch-constraints'
import { inferred, reversedChain, type Landing } from '../src/cad/sketch-infer'
import { click, dragArc, emptyDraft, lineArcFrom, type Chain, type Draft, type DrawTool, type Entity, type SnapKind, type V2 } from '../src/cad/sketch-model'

/** Draws as the panel does, keeping the constraints each step infers. Points are [x, y] or [x, y, snap]. */
function draw(tool: DrawTool, steps: ([number, number] | [number, number, SnapKind] | { drag: V2 })[], sketch: Entity[] = [], quiet = false) {
  let s: Entity[] = sketch
  let d: Draft = emptyDraft(tool)
  let cons: SketchConstraint[] = []
  let landed: Landing[] = []
  for (const st of steps) {
    const at: V2 = 'drag' in st ? st.drag : [st[0], st[1]]
    const kind = 'drag' in st ? null : (st[2] ?? null)
    const r = 'drag' in st ? dragArc(s, d, at) : click(s, d, at)
    const all = [...landed, { at, kind }]
    const turned = reversedChain(s, r.sketch)
    if (turned >= 0) cons = afterReverse(cons, turned, (s[turned] as Chain).segs.length)
    if (!quiet) cons = [...cons, ...inferred(s, r.sketch, all, cons)]
    const grew = JSON.stringify(r.sketch) !== JSON.stringify(s)
    landed = !r.draft.points.length ? [] : grew ? [all[all.length - 1]!] : all
    s = r.sketch
    d = r.draft
  }
  return { sketch: s, draft: d, cons }
}
const types = (cons: readonly SketchConstraint[]) => cons.map((c) => c.type)

describe('inferred constraints', () => {
  it('a level line is horizontal, an upright one vertical, a slanted one neither', () => {
    expect(draw('line', [[0, 0], [10, 0]]).cons).toEqual([{ type: 'horizontal', line: { e: 0, seg: 0 } }])
    expect(draw('line', [[0, 0], [0, 10]]).cons).toEqual([{ type: 'vertical', line: { e: 0, seg: 0 } }])
    expect(draw('line', [[0, 0], [10, 3]]).cons).toEqual([])
  })

  it('a slanted corner drawn square is perpendicular, but a level and an upright line need nothing more', () => {
    expect(types(draw('line', [[0, 0], [10, 0], [10, 10]]).cons)).toEqual(['horizontal', 'vertical'])
    expect(types(draw('line', [[0, 0], [4, 3], [1, 7]]).cons)).toEqual(['perpendicular'])
  })

  it('a 2-point rectangle is two horizontals and two verticals', () => {
    expect(types(draw('rect', [[0, 0], [10, 5]]).cons).sort()).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical'])
  })

  it('a tilted 3-point rectangle is held square at three corners, so the solver sees no redundancy', () => {
    const { sketch, cons } = draw('rect3', [[0, 0], [6, 8], [-8, 6]])
    expect(types(cons)).toEqual(['perpendicular', 'perpendicular', 'perpendicular'])
    expect(toSolver(sketch, cons).solver.constraints).toHaveLength(3)
  })

  it('an end dropped on another shape is coincident with its point, a midpoint snap holds the middle', () => {
    const base = draw('line', [[0, 0], [10, 0]]).sketch
    const on = draw('line', [[20, 5], [10, 0, 'vertex']], base)
    expect(on.cons).toContainEqual({ type: 'coincident', a: { e: 1, at: 'to', seg: 0 }, b: { e: 0, at: 'to', seg: 0 } })
    const mid = draw('line', [[5, 0, 'midpoint'], [5, 8]], base)
    expect(mid.cons).toContainEqual({ type: 'midpoint', point: { e: 1, at: 'start' }, line: { e: 0, seg: 0 } })
    // an edge snap holds the point on the line
    const edge = draw('line', [[3, 0, 'edge'], [3, 8]], base)
    expect(edge.cons).toContainEqual({ type: 'onLine', point: { e: 1, at: 'start' }, line: { e: 0, seg: 0 } })
  })

  it('a circle centered on another circle is concentric', () => {
    const base = draw('circle', [[0, 0], [5, 0]]).sketch
    expect(draw('circle', [[0, 0, 'center'], [2, 0]], base).cons).toEqual([{ type: 'concentric', a: { e: 1, seg: 0 }, b: { e: 0, seg: 0 } }])
  })

  it('an arc off a line end is tangent to it, and so is the line drawn on from the arc', () => {
    const { cons } = draw('line', [[0, 0], [10, 0], { drag: [10, 10] }, [0, 10]])
    expect(cons).toEqual([
      { type: 'horizontal', line: { e: 0, seg: 0 } },
      { type: 'tangent', a: { e: 0, seg: 0 }, b: { e: 0, seg: 1 } },
      { type: 'horizontal', line: { e: 0, seg: 2 } },
      { type: 'tangent', a: { e: 0, seg: 1 }, b: { e: 0, seg: 2 } },
    ])
  })

  it('Ctrl leaves nothing behind', () => {
    expect(draw('line', [[0, 0], [10, 0], [10, 10]], [], true).cons).toEqual([])
  })

  it('construction lines infer nothing of their own', () => {
    const r = draw('line', [[0, 0], [10, 0]])
    const c = inferred([], [{ ...(r.sketch[0] as Chain), construction: true }], [], [])
    expect(c).toEqual([])
  })

  it('going on from a chain start turns the chain round and keeps its constraints on the same curves', () => {
    const first = draw('line', [[0, 0], [10, 0], [10, 10]])
    let s = first.sketch
    let cons = first.cons
    const r = click(s, emptyDraft('line'), [0, 0])
    const turned = reversedChain(s, r.sketch)
    expect(turned).toBe(0)
    cons = afterReverse(cons, 0, 2)
    s = r.sketch
    // the vertical line is now the first segment, the horizontal one the second
    expect(cons).toEqual([
      { type: 'horizontal', line: { e: 0, seg: 1 } },
      { type: 'vertical', line: { e: 0, seg: 0 } },
    ])
    expect((s[0] as Chain).segs[0]!.to).toEqual([10, 0])
  })
})

describe('drag-tangent arc', () => {
  it('drags only from the open end of a line with a segment to be tangent to', () => {
    const one = draw('line', [[0, 0]])
    expect(lineArcFrom(one.sketch, one.draft)).toBeNull()
    const two = draw('line', [[0, 0], [10, 0]])
    expect(lineArcFrom(two.sketch, two.draft)).toEqual([10, 0])
    expect(lineArcFrom(two.sketch, { ...two.draft, tool: 'arc' })).toBeNull()
  })

  it('places a tangent arc and goes on drawing lines from its end, closing the shape with keys and clicks only', () => {
    const r = draw('line', [[0, 0], [10, 0], { drag: [10, 10] }, [0, 10], [0, 0]])
    const c = r.sketch[0] as Chain
    expect(c.segs.map((s) => s.kind)).toEqual(['line', 'arc', 'line', 'line'])
    expect(c.closed).toBe(true)
    expect(r.draft).toEqual(emptyDraft('line'))
    // the arc runs out of the line's direction: a half circle about (10, 5)
    const arc = c.segs[1] as Extract<Chain['segs'][number], { kind: 'arc' }>
    expect(arc.through[0]).toBeCloseTo(15)
    expect(arc.through[1]).toBeCloseTo(5)
  })
})

describe('glyphs', () => {
  it('draws one glyph per constraint, two for a pair apart, and sets marks at one spot side by side', () => {
    const { sketch, cons } = draw('line', [[0, 0], [10, 0], { drag: [10, 10] }, [0, 10]])
    const g = glyphsOf(sketch, cons)
    expect(g.map((x) => x.kind)).toEqual(['horizontal', 'tangent', 'horizontal', 'tangent'])
    // tangents sit at the joints
    expect(g[1]!.at).toEqual([10, 0])
    expect(g[3]!.at).toEqual([10, 10])
    const sq: Entity[] = [{ kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [10, 0] }, { kind: 'line', to: [10, 10] }, { kind: 'line', to: [20, 10] }], closed: false }]
    const par = glyphsOf(sq, [{ type: 'parallel', a: { e: 0, seg: 0 }, b: { e: 0, seg: 2 } }, { type: 'equal', a: { e: 0, seg: 0 }, b: { e: 0, seg: 2 } }])
    expect(par.map((x) => [x.kind, x.slot])).toEqual([
      ['parallel', 0],
      ['parallel', 0],
      ['equal', 1],
      ['equal', 1],
    ])
  })
})
