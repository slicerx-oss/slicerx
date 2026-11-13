// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that raises a body (a level or story added on top) under other parts that stood on it leaves them sunk inside
// it: the uprights of a model sank into the levels a follow-up stacked under them. The step's answer names each such part,
// how deep it now sits, and the step that made it, so the model lifts it there (design.edit_step move) and its copies
// follow.
import { bakeMesh, type Design } from '@slicerx/cad-history'
import { makers } from './part-form'

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

/** The step that made part `k`, followed through the history as replay numbers the parts (part-form.ts makers), as its number from 1, or 0 when none is found. */
export function maker(d: Design, k: number): number {
  const m = makers(d)[k]
  return m ? d.history.steps.indexOf(m) + 1 : 0
}

/** A part a step left sunk inside the body it stood on: its index, how deep, and the step that made it (from 0, or -1). */
export interface Sunk {
  part: number
  depthMm: number
  step: number
}

/**
 * Parts that stood on part `on` before a step raised it and now sit inside it. `before` is partBoxes from before the
 * step. A part counts when its foot was at or above the body's old top, is now below its new top, and its middle is
 * over the body.
 */
export function sunkParts(d: Design, on: number, before: readonly Box[]): Sunk[] {
  const was = before[on]
  const now = partBoxes(d)
  const body = now[on]
  if (!was || !body || body.hi[2] <= was.hi[2] + 0.05) return []
  const out: Sunk[] = []
  for (const [k, b] of now.entries()) {
    if (k === on) continue
    const old = before[k]
    if (!old || Math.abs(old.lo[2] - b.lo[2]) > 1e-3) continue
    const mx = (b.lo[0] + b.hi[0]) / 2
    const my = (b.lo[1] + b.hi[1]) / 2
    const over = mx >= body.lo[0] && mx <= body.hi[0] && my >= body.lo[1] && my <= body.hi[1]
    const depth = body.hi[2] - b.lo[2]
    if (!over || b.lo[2] < was.hi[2] - 0.3 || depth <= 0.05) continue
    out.push({ part: k, depthMm: depth, step: maker(d, k) - 1 })
  }
  return out
}

/** The parts left sunk that no step can lift (no step made them), in words for the model, or ''. */
export function sunkNote(d: Design, on: number, sunk: readonly Sunk[]): string {
  return sunk
    .filter((s) => s.step < 0)
    .map((s) => `${d.parts[s.part]!.name} stood on ${d.parts[on]!.name} and is now ${r1(s.depthMm)} mm inside it; no step made it, so move it up ${r1(s.depthMm)} mm another way`)
    .join('. ')
}

export { r1 as roundTenth }
