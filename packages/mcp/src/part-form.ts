// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A short line per part saying how it was made and how it looks, read from the history and the geometry, so a model
// reading a design back can tell a plain block from a shaped part without a picture: what made it (a box, a cylinder,
// a turned outline, a loft), what joined it, whether any edge is rounded or beveled, a "plain block" mark for a part
// made only of boxes and cylinders with every edge sharp, and where it sits (on which part, at which end). A vague
// follow-up ("add bevels", "make it nicer") goes to the plain blocks first. Beyond FORMS_MAX parts the rest are counted.
import { bakeMesh, makesBody, numbering, placeBody, stepParts, turnedOff, type Design, type Numbering, type Step } from '@slicerx/cad-history'

/** Parts given a form line; a design with more lists these and counts the rest. */
export const FORMS_MAX = 16

const BOXY = new Set(['rectangle', 'circle'])

/** What made a step's body, in a word or two, and whether it is a plain box or cylinder. */
function madeAs(s: Step): { word: string; plain: boolean } {
  const p = s.params
  switch (p.op) {
    case 'shape.extrude': {
      const t = p.shape.type
      return { word: t === 'rectangle' ? 'box' : t === 'circle' ? 'cylinder' : t === 'sketch' ? 'extruded outline' : `extruded ${t}`, plain: BOXY.has(t) && !p.spec.taperDeg }
    }
    case 'sketch.revolve':
      return { word: 'turned outline', plain: false }
    case 'sketch.loft':
      return { word: `loft of ${p.profiles.length} sections`, plain: false }
    case 'sketch.sweep':
      return { word: 'sweep', plain: false }
    case 'parts.add':
      return p.arrayOf ? { word: `copy of ${p.arrayOf}`, plain: false } : { word: 'built solids', plain: true }
    default:
      return { word: p.op, plain: false }
  }
}

/**
 * For each part now, the step that made it, followed through the history with replay's own part numbers (cad-history
 * numbering.ts): a new body is placed as replay places it, and a turned-off step sets parts aside as replay does. A part
 * of the history's base, or one no step can be told for, is null.
 */
export function makers(d: Design): (Step | null)[] {
  const none = () => d.parts.map(() => null)
  let at: Numbering<Step | null> = numbering(d.history.base.map(() => null))
  for (const [i, s] of d.history.steps.entries()) {
    // replay stops at a broken step, and every step after it is skipped
    const state = d.status[i]?.state
    if (state === 'broken' || state === 'skipped') break
    if (s.suppressed) {
      at = turnedOff(s, at)
      continue
    }
    const p = s.params
    const on = stepParts(s, at)
    let out = on.parts.slice()
    if (p.op === 'parts.add') out.push(...p.parts.map(() => s))
    else if (makesBody(p)) placeBody(out, s.part, s)
    else if (p.op === 'boolean') out = out.filter((_, k) => !p.with.includes(k))
    else if (p.op === 'plane.cut' && p.keep === 'both') out.splice(s.part + 1, 0, out[s.part] ?? null)
    else if (p.op === 'parts.order') out = p.order.map((k) => out[k] ?? null)
    // how many pieces a split makes only the engine knows
    else if (p.op === 'split') return none()
    at = on.after(out)
  }
  return at.parts.length === d.parts.length ? at.parts : none()
}

type Box = { lo: number[]; hi: number[] }
function boxes(d: Design): Box[] {
  return d.parts.map((p) => {
    const m = bakeMesh(p, d.transform)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let n = 0; n + 2 < m.positions.length; n += 3)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, m.positions[n + a]!)
        hi[a] = Math.max(hi[a]!, m.positions[n + a]!)
      }
    return { lo, hi }
  })
}

/**
 * The form line of each part, in part order, as many as FORMS_MAX: what made it, what joined it, its edges, "plain
 * block" when it is boxes and cylinders with every edge sharp, and where it sits. Empty for a design with no history.
 */
export function partForms(d: Design): string[] {
  if (!d.parts.length || !d.history.steps.length) return []
  const made = makers(d)
  const bx = boxes(d)
  const all = { lo: [0, 1, 2].map((a) => Math.min(...bx.map((b) => b.lo[a]!))), hi: [0, 1, 2].map((a) => Math.max(...bx.map((b) => b.hi[a]!))) }
  const long = all.hi[0]! - all.lo[0]! >= all.hi[1]! - all.lo[1]! ? 0 : 1
  const span = all.hi[long]! - all.lo[long]!
  return d.parts.slice(0, FORMS_MAX).map((part, k) => {
    const m = made[k]
    const own = d.history.steps.filter((s, i) => s.part === k && s !== m && !s.suppressed && (!d.status[i] || d.status[i]!.state === 'done'))
    const how = m ? madeAs(m) : { word: 'made outside the history', plain: false }
    const joins = own.filter((s) => (s.params.op === 'shape.extrude' && (s.params.spec.operation ?? 'new') === 'join') || ((s.params.op === 'sketch.loft' || s.params.op === 'sketch.revolve' || s.params.op === 'sketch.sweep') && s.params.operation === 'join'))
    const boxyJoins = joins.filter((s) => s.params.op === 'shape.extrude' && BOXY.has(s.params.shape.type))
    const broken = own.some((s) => s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer')
    const words = [how.word]
    if (joins.length) words.push(`${joins.length} joined on${boxyJoins.length === joins.length ? ' (boxes)' : ''}`)
    if (own.some((s) => s.params.op === 'pattern' || s.params.op === 'array.merged')) words.push('patterned')
    // a plain block is all sharp edges by its name; anything else says how its edges are
    if (how.plain && boxyJoins.length === joins.length && !broken) words.push('plain block')
    else words.push(broken ? 'rounded or beveled edges' : 'sharp edges')
    // where it sits: on the part under it, and at which end of the design's long side
    const b = bx[k]!
    const under = bx.findIndex((o, j) => j !== k && Math.abs(o.hi[2]! - b.lo[2]!) < 0.4 && (b.lo[0]! + b.hi[0]!) / 2 >= o.lo[0]! && (b.lo[0]! + b.hi[0]!) / 2 <= o.hi[0]! && (b.lo[1]! + b.hi[1]!) / 2 >= o.lo[1]! && (b.lo[1]! + b.hi[1]!) / 2 <= o.hi[1]!)
    const mid = ((b.lo[long]! + b.hi[long]!) / 2 - all.lo[long]!) / (span || 1)
    const axis = long === 0 ? 'x' : 'y'
    const end = d.parts.length > 1 && span > 0 ? (mid < 0.33 ? `low ${axis} end` : mid > 0.67 ? `high ${axis} end` : 'middle') : ''
    const where = [under >= 0 ? `on ${d.parts[under]!.name}` : '', end].filter(Boolean).join(', ')
    return `${part.name}: ${words.join(', ')}${where ? `; ${where}` : ''}`
  })
}
