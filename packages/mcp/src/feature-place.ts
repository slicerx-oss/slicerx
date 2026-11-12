// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a new feature may go on a design, read from the parts already there. Two rules, for any object: a cut never
// runs under a part that stands on the face it cuts (the part would be left standing on nothing), and a new part never
// shares its footprint with another part standing on the same face (two things in one place). A part joined into a body
// at another height (a handle on a mug's side, a level sunk into the one below) is not held by either. Each refusal names
// the part in the way and its box, so the feature is moved, not built.
import type { HistoryMesh, Mat4, SolidSpec } from '@slicerx/cad-history'

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

/** A box moved by a transform (column-major, as the design keeps it): the box around its eight moved corners. */
export function boxIn(b: Box | null, m: Mat4): Box | null {
  if (!b) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
    const p = [0, 1, 2].map((a) => m[a]! * x + m[4 + a]! * y + m[8 + a]! * z + m[12 + a]!)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, p[a]!)
      max[a] = Math.max(max[a]!, p[a]!)
    }
  }
  return { min, max }
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
    // stands on, read from its triangles (a hole inside a ring's opening takes none of it). A notch at the edge of that
    // footprint (a hinge's seat) leaves it standing. A part the cut goes into, from above or below, is the part being cut.
    const under = boxes.some((c) => {
      if (!(sharedArea(c, pb) > 0 && Math.abs(pb.min[2] - c.max[2]) <= AT_TOP && pb.min[2] > c.min[2] + STANDS && pb.max[2] > c.max[2] + AT_TOP)) return false
      const r = { x0: Math.max(pb.min[0], c.min[0]), y0: Math.max(pb.min[1], c.min[1]), x1: Math.min(pb.max[0], c.max[0]), y1: Math.min(pb.max[1], c.max[1]) }
      return coveredArea(p, r) > SHARED * coveredArea(p, { x0: pb.min[0], y0: pb.min[1], x1: pb.max[0], y1: pb.max[1] })
    })
    if (under) out.push(`${p.name} (${boxText(pb)})`)
  })
  return out
}

/** Samples a side of a footprint is read at, to tell how much of it a part's triangles cover from above. */
const GRID = 24

/** True when (x, y) is under one of the part's triangles, seen from above. */
function under(p: Pick<HistoryMesh, 'positions' | 'indices'>, x: number, y: number): boolean {
  const pos = p.positions
  const idx = p.indices
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3
    const b = idx[t + 1]! * 3
    const c = idx[t + 2]! * 3
    const [ax, ay, bx, by, cx, cy] = [pos[a]!, pos[a + 1]!, pos[b]!, pos[b + 1]!, pos[c]!, pos[c + 1]!]
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true
  }
  return false
}

/** The area of the rectangle `r` (seen from above) a part's triangles cover, mm², read on a GRID x GRID sample. */
function coveredArea(p: Pick<HistoryMesh, 'positions' | 'indices'>, r: { x0: number; y0: number; x1: number; y1: number }): number {
  const w = r.x1 - r.x0
  const h = r.y1 - r.y0
  if (!(w > 0 && h > 0)) return 0
  // a part given by its corners alone (no triangles) covers its whole box
  if (p.indices.length < 3) return w * h
  let hit = 0
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) if (under(p, r.x0 + ((i + 0.5) * w) / GRID, r.y0 + ((j + 0.5) * h) / GRID)) hit++
  return (hit / (GRID * GRID)) * w * h
}

/** A part a new solid would stand in, with the moves that clear it. */
export interface InPlace {
  /** The solid's index among those given. */
  solid: number
  part: string
  partBox: Box
  solidBox: Box
}

/**
 * The solids of a new part that would take another part's place, each on its own: off the bed, another part standing
 * on the same face (bottoms within a millimeter) that rises above the solid, whose real footprint (its triangles seen
 * from above, not its box) shares more than a quarter of the smaller of the two. A part made of several solids is held
 * solid by solid, so pieces that each stand clear are never refused for the box around them all.
 */
export function solidsInPlace(parts: readonly Pick<HistoryMesh, 'name' | 'positions' | 'indices'>[], solids: readonly (Box | null)[]): InPlace[] {
  const out: InPlace[] = []
  solids.forEach((added, k) => {
    // parts laid out together on the bed (an assembly, pieces that print in place) are placed as a whole, not held here
    if (!added || added.min[2] <= ON_BED) return
    for (const p of parts) {
      const pb = boxOf(p.positions)
      // another part standing on the same face that rises above the new one: the new one would be inside it
      if (!pb || Math.abs(pb.min[2] - added.min[2]) > SAME_FACE || pb.max[2] <= added.max[2]) continue
      const r = { x0: Math.max(pb.min[0], added.min[0]), y0: Math.max(pb.min[1], added.min[1]), x1: Math.min(pb.max[0], added.max[0]), y1: Math.min(pb.max[1], added.max[1]) }
      const shared = coveredArea(p, r)
      if (!(shared > 0)) continue
      const own = coveredArea(p, { x0: pb.min[0], y0: pb.min[1], x1: pb.max[0], y1: pb.max[1] })
      const small = Math.min(footprint(added), own)
      if (small > 0 && shared > SHARED * small) out.push({ solid: k, part: p.name, partBox: pb, solidBox: added })
    }
  })
  return out
}

/**
 * Parts a new part would take the place of, the part read as one solid (solidsInPlace): each as a line naming it and
 * its box. Empty when none.
 */
export function sharesPlace(parts: readonly Pick<HistoryMesh, 'name' | 'positions' | 'indices'>[], added: Box): string[] {
  return [...new Set(solidsInPlace(parts, [added]).map((h) => `${h.part} (${boxText(h.partBox)})`))]
}

/**
 * What clears a solid of the part it would stand in, as a call can give it: start it on that part's top, or move it
 * the least way in x or y that takes it off that part's footprint.
 */
export function clearOf(h: InPlace): string {
  const s = h.solidBox
  const p = h.partBox
  const moves = [
    { by: p.max[0] - s.min[0], words: 'x' },
    { by: -(s.max[0] - p.min[0]), words: 'x' },
    { by: p.max[1] - s.min[1], words: 'y' },
    { by: -(s.max[1] - p.min[1]), words: 'y' },
  ].sort((a, b) => Math.abs(a.by) - Math.abs(b.by))[0]!
  const up = r1(p.max[2] - s.min[2])
  return `solids[${h.solid}] (${boxText(s)}) stands in ${h.part} (${boxText(p)}): raise it by ${up} mm so it starts at z ${r1(p.max[2])} on ${h.part}'s top, or move it ${moves.by > 0 ? '+' : ''}${r1(moves.by)} mm in ${moves.words} so it stands clear beside it`
}

/** The refusal for a new part whose solids would stand where other parts stand: each solid in the way, and what clears it. */
export function solidsNote(inWay: readonly InPlace[]): string {
  return `Nothing was built: ${inWay.map(clearOf).join('; ')}. Send geom.build again with those solids moved, keeping the others as they are, or say why it must go there.`
}

/** The refusal for a feature that would go where another part is: what is in the way, and to move it clear. */
export function placeNote(what: 'cut' | 'part', inWay: readonly string[], box: Box | null): string {
  const here = box ? ` (${boxText(box)})` : ''
  return what === 'cut'
    ? `Nothing was cut: the cut${here} runs under ${inWay.join(', ')}, which stands on the face it cuts and would be left on nothing. Put it on an open area of that face, clear of every part standing there (each part's box is in geom.info), or say why it must go there.`
    : `Nothing was built: the new part${here} stands where ${inWay.join(', ')} already stands on the same face. Move it to an open area clear of them (each part's box is in geom.info), or build it on top of them if that is what is meant.`
}
