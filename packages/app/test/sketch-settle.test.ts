// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sketch solved away from the editor, as an agent's design.sketch does it: the drawing moves to meet its
// dimensions, one that would over-define it is kept driven with the size it measures, and dimensions from the origin
// define where it sits. What the drawing tools infer solves clean, with nothing said twice.
import { describe, expect, it } from 'vitest'
import type { SketchConstraint } from '../src/cad/sketch-constraints'
import { settle } from '../src/cad/sketch-dimension'
import { inferred } from '../src/cad/sketch-infer'
import { click, emptyDraft, rectangle, type DrawTool, type Entity, type V2 } from '../src/cad/sketch-model'
import { useGeomEngine } from './geom-engine'

useGeomEngine('sketch-settle-replies')

// corners (10,10) (30,10) (30,20) (10,20), each side level or upright
const rect = (): Entity[] => [rectangle([10, 10], [30, 20])]
const level: SketchConstraint[] = [
  { type: 'horizontal', line: { e: 0, seg: 0 } },
  { type: 'vertical', line: { e: 0, seg: 1 } },
  { type: 'horizontal', line: { e: 0, seg: 2 } },
  { type: 'vertical', line: { e: 0, seg: 3 } },
]
const corners = (s: Entity[]) => {
  const e = s[0]!
  if (e.kind !== 'chain') throw new Error('not a chain')
  return [e.start, ...e.segs.slice(0, -1).map((g) => g.to)].map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])
}

describe('settling a sketch', () => {
  it('moves the drawing to its dimensions and keeps an over-defining one driven', async () => {
    const r = await settle(rect(), [
      ...level,
      { type: 'length', line: { e: 0, seg: 0 }, value: 25 },
      { type: 'length', line: { e: 0, seg: 1 }, value: 12 },
      { type: 'length', line: { e: 0, seg: 2 }, value: 30 },
    ])
    expect(r.solved.status).not.toBe('conflict')
    expect(r.solved.dof).toBe(2)
    expect(r.constraints[6]).toEqual({ type: 'length', line: { e: 0, seg: 2 }, value: 25, driven: true })
    const c = corners(r.sketch)
    expect(Math.abs(c[1]![0]! - c[0]![0]!)).toBeCloseTo(25)
    expect(Math.abs(c[2]![1]! - c[1]![1]!)).toBeCloseTo(12)
  })

  it('is fully defined once dimensions from the origin place it', async () => {
    const r = await settle(rect(), [
      ...level,
      { type: 'length', line: { e: 0, seg: 0 }, value: 25 },
      { type: 'length', line: { e: 0, seg: 1 }, value: 12 },
      { type: 'horizontalDistance', a: { e: -1, at: 'start' }, b: { e: 0, at: 'start' }, value: 5 },
      { type: 'verticalDistance', a: { e: -1, at: 'start' }, b: { e: 0, at: 'start' }, value: 5 },
    ])
    expect(r.solved.status).toBe('ok')
    expect(r.solved.dof).toBe(0)
    expect(corners(r.sketch)).toEqual([[5, 5], [30, 5], [30, 17], [5, 17]])
  })

  it('takes what the polygon and slot tools infer with nothing said twice', async () => {
    const shape = (tool: DrawTool, pts: V2[], sides?: number) => {
      let sk: Entity[] = []
      let d = emptyDraft(tool)
      let cons: SketchConstraint[] = []
      for (const p of pts) {
        const r = click(sk, d, p, sides ? { sides } : {})
        cons = [...cons, ...inferred(sk, r.sketch, [], cons, tool)]
        sk = r.sketch
        d = r.draft
      }
      return { sk, cons }
    }
    for (const [tool, pts, sides] of [['polygon', [[0, 0], [10, 3]], 6], ['polygonEdge', [[0, 0], [10, 0], [5, 5]], 4], ['polygonEdge', [[0, 0], [10, 2], [5, 5]], 4], ['polygon', [[0, 0], [7, 1]], 3], ['slot', [[0, 0], [20, 5], [10, 9]], undefined]] as [DrawTool, V2[], number | undefined][]) {
      const { sk, cons } = shape(tool, pts, sides)
      expect(cons.some((c) => c.type === 'equal'), tool).toBe(true)
      const r = await settle(sk, cons)
      expect(r.solved.status, `${tool} ${sides ?? ''}`).toBe('ok')
    }
  })
})
