// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a new feature may go on a design, read from the parts already there. Two rules, for any object: a cut never
// runs under a part that stands on the face it cuts (the part would be left standing on nothing), and a new part never
// shares its footprint with another part standing on the same face (two things in one place). A part joined into a body
// at another height (a handle on a mug's side, a level sunk into the one below) is not held by either. Each refusal names
// the part in the way and its box, so the feature is moved, not built.
import type { HistoryMesh, SolidSpec } from '@slicerx/cad-history'

export interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

/** A part's box from its triangles, in the design's own frame. */
export function boxOf(positions: ArrayLike<number>): Box | null {
  if (positions.length < 3) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!
      if (v < min[a]!) min[a] = v
      if (v > max[a]!) max[a] = v
    }
  }
  return { min, max }
}

/** A cutter's box: a box as given, a cylinder as the box around its two end discs. */
export function solidBox(s: SolidSpec): Box | null {
  if (s.type === 'box') return { min: [...s.min], max: [...s.max] }
  if (s.type === 'cylinder') {
    const l = Math.hypot(...s.axis)
    if (!(l > 0)) return null
    const n = s.axis.map((c) => c / l) as [number, number, number]
    const end = s.origin.map((o, a) => o + n[a]! * s.heightMm) as [number, number, number]
    const r = s.diameterMm / 2
    // across the axis the disc reaches r times the sine of each axis' angle to it
    const reach = n.map((c) => r * Math.sqrt(Math.max(0, 1 - c * c))) as [number, number, number]
    return { min: [0, 1, 2].map((a) => Math.min(s.origin[a]!, end[a]!) - reach[a]!) as Box['min'], max: [0, 1, 2].map((a) => Math.max(s.origin[a]!, end[a]!) + reach[a]!) as Box['max'] }
  }
  return null
}

/** The area two boxes share seen from above, in mm². */
function sharedArea(a: Box, b: Box): number {
  const w = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0])
  const d = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1])
  return w > 0 && d > 0 ? w * d : 0
}
const footprint = (b: Box): number => Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1])
const r1 = (n: number): number => Math.round(n * 10) / 10
const boxText = (b: Box): string => `x ${r1(b.min[0])} to ${r1(b.max[0])}, y ${r1(b.min[1])} to ${r1(b.max[1])}, z ${r1(b.min[2])} to ${r1(b.max[2])}`

/** How much deeper than a standing part's bottom a cut reaches before it takes away what the part stands on, in mm. */
const STANDS = 0.6
/** How far a standing part's bottom may be from the cut's top (a cutter often runs a little past the face), in mm. */
const AT_TOP = 1.5
/** How far apart two bottoms may be and still stand on the same face, in mm. */
const SAME_FACE = 1
/** A part whose bottom is this close to the bed stands on the bed, not on another part, in mm. */
const ON_BED = 0.5
/**
 * The share of the smaller footprint two parts on one face may overlap before they are in each other's place, and the
 * share of a standing part's footprint a cut may take from under it before the part no longer stands.
 */
const SHARED = 0.25

/**
 * Parts a cut would run under: another part (not the one cut) whose footprint the cut overlaps from above and whose
 * bottom stands on the cut's span, the face being cut. Each as a line naming it and its box. Empty when none.
 */
export function undercut(parts: readonly HistoryMesh[], cut: number, cutters: readonly SolidSpec[]): string[] {
  const boxes = cutters.map(solidBox).filter((b): b is Box => b !== null)
  const out: string[] = []
  parts.forEach((p, n) => {
    if (n === cut) return
    const pb = boxOf(p.positions)
    if (!pb) return
    // it stands on what the cut takes away: its bottom is at the cut's top (the face the cut opens), the cut reaches
    // deeper than that bottom, the part rises above the cut, and the cut takes more than a quarter of the footprint it
    // stands on. A notch at the edge of that footprint (a hinge's seat) leaves it standing. A part the cut goes into,
    // from above or below, is the part being cut.
    const under = boxes.some((c) => sharedArea(c, pb) > SHARED * footprint(pb) && Math.abs(pb.min[2] - c.max[2]) <= AT_TOP && pb.min[2] > c.min[2] + STANDS && pb.max[2] > c.max[2] + AT_TOP)
    if (under) out.push(`${p.name} (${boxText(pb)})`)
  })
  return out
}

/**
 * Parts a new part would take the place of: off the bed, another part standing on the same face (bottoms within a
 * millimeter) that rises above the new one, whose footprint shares more than a quarter of the smaller one's. Each as a
 * line naming it and its box. Empty when none.
 */
export function sharesPlace(parts: readonly HistoryMesh[], added: Box): string[] {
  const out: string[] = []
  // parts laid out together on the bed (an assembly, pieces that print in place) are placed as a whole, not held here
  if (added.min[2] <= ON_BED) return out
  for (const p of parts) {
    const pb = boxOf(p.positions)
    // another part standing on the same face that rises above the new one: the new part would be inside it
    if (!pb || Math.abs(pb.min[2] - added.min[2]) > SAME_FACE || pb.max[2] <= added.max[2]) continue
    const small = Math.min(footprint(pb), footprint(added))
    if (small > 0 && sharedArea(pb, added) > SHARED * small) out.push(`${p.name} (${boxText(pb)})`)
  }
  return out
}

/** The refusal for a feature that would go where another part is: what is in the way, and to move it clear. */
export function placeNote(what: 'cut' | 'part', inWay: readonly string[], box: Box | null): string {
  const here = box ? ` (${boxText(box)})` : ''
  return what === 'cut'
    ? `Nothing was cut: the cut${here} runs under ${inWay.join(', ')}, which stands on the face it cuts and would be left on nothing. Put it on an open area of that face, clear of every part standing there (each part's box is in geom.info), or say why it must go there.`
    : `Nothing was built: the new part${here} stands where ${inWay.join(', ')} already stands on the same face. Move it to an open area clear of them (each part's box is in geom.info), or build it on top of them if that is what is meant.`
}
