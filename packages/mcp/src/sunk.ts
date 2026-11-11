// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that raises a body (a level or story added on top) under other parts that stood on it leaves them sunk inside
// it: the uprights of a model sank into the levels a follow-up stacked under them. The step's answer names each such part,
// how deep it now sits, and the step that made it, so the model lifts it there (design.edit_step move) and its copies
// follow.
import { bakeMesh, type Design } from '@slicerx/cad-history'

type Box = { lo: [number, number, number]; hi: [number, number, number] }

/** Each part's box on the plate, at the design's transform. */
export function partBoxes(d: Design): Box[] {
  return d.parts.map((p) => {
    const m = bakeMesh(p, d.transform)
    const lo: [number, number, number] = [Infinity, Infinity, Infinity]
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < m.positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        const v = m.positions[i + a]!
        if (v < lo[a]!) lo[a] = v
        if (v > hi[a]!) hi[a] = v
      }
    return { lo, hi }
  })
}

const r1 = (n: number): number => Math.round(n * 10) / 10

/** The step that made part `k` (the first step that started it), as its number from 1, or 0 when none is found. */
function maker(d: Design, k: number): number {
  const made = (p: unknown): boolean => {
    const q = p as { op: string; operation?: string; spec?: { operation?: string } }
    return q.op === 'parts.add' || (q.operation ?? q.spec?.operation) === 'new'
  }
  const i = d.history.steps.findIndex((s) => s.part === k && made(s.params))
  return i + 1
}

/**
 * Parts that stood on part `on` before a step raised it and now sit inside it, as one sentence each, or '' for none.
 * `before` is partBoxes from before the step. A part counts when its foot was at or above the body's old top, is now
 * below its new top, and its middle is over the body.
 */
export function sunkNote(d: Design, on: number, before: readonly Box[]): string {
  const was = before[on]
  const now = partBoxes(d)
  const body = now[on]
  if (!was || !body || body.hi[2] <= was.hi[2] + 0.05) return ''
  const out: string[] = []
  for (const [k, b] of now.entries()) {
    if (k === on) continue
    const old = before[k]
    if (!old || Math.abs(old.lo[2] - b.lo[2]) > 1e-3) continue
    const mx = (b.lo[0] + b.hi[0]) / 2
    const my = (b.lo[1] + b.hi[1]) / 2
    const over = mx >= body.lo[0] && mx <= body.hi[0] && my >= body.lo[1] && my <= body.hi[1]
    const depth = body.hi[2] - b.lo[2]
    if (!over || b.lo[2] < was.hi[2] - 0.3 || depth <= 0.05) continue
    const step = maker(d, k)
    const name = d.parts[k]!.name
    out.push(`${name} stood on ${d.parts[on]!.name} and is now ${r1(depth)} mm inside it: lift it with design.edit_step move [0, 0, ${r1(depth)}]${step ? ` on step ${step}, the step that made it` : ' on the step that made it'}`)
  }
  return out.join('. ')
}
