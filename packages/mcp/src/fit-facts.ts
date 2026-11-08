// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gaps between the bodies of a design, for a print-in-place part: the engine's fit check (fit.check, the check the
// app runs on the plate) over every part as the design holds it, with the limits from the fit rule (the fit_check
// skill's assessFit) for the printer's nozzle, layer height and material. design.check and geom.fit_check read it.
import { bakeMesh, type Design as HostDesign, type DesignHost, type HistoryMesh } from '@slicerx/cad-history'
import { assessFit, lineWidthFor, printInPlaceClearance, type ClearanceProfile, type FitResult } from '@slicerx/pilot'
import { NEAR_MM, nozzleOr, type FitFacts, type FitGap, type FitLimits } from './design-check'

type V3 = [number, number, number]

/** What the fit rule needs about the print, each optional: the nozzle (0.4 mm), layer height (half the nozzle) and material (PLA). */
export type FitProfile = ClearanceProfile

/** The smallest print-in-place gaps for a profile: the gap the fit rule suggests, side by side and above or below. */
export function fitLimits(p: FitProfile = {}): FitLimits {
  return printInPlaceClearance({ ...p, nozzleMm: nozzleOr(p.nozzleMm) })
}

/**
 * How much a gap measured on the mesh may read under the modeled one. A round face is drawn as flat facets inside its
 * circle, so a pin's corner faces a bore's facet a little closer than the two circles are: the engine draws curves to
 * within 0.005 mm (sketch arcs) to 0.02 mm (a cylinder body of up to about 9 mm radius), and adding up a model's
 * coordinates leaves float error. A gap modeled at exactly the limit reads 0.28 to 0.3 mm against 0.3 mm beside a pin,
 * and 0.38 to 0.4 mm against 0.4 mm above a pin lying flat in its bore. A tenth of the 0.2 mm or so the fit rule leaves
 * after the faces grow, so a gap this much under the limit still slides.
 */
export const FIT_TOLERANCE_MM = 0.02

/** Float error in a measured gap between flat faces, which the fit rule allows for too. */
const FLOAT_MM = 1e-6

/**
 * The gap the check judges for a measured one, as the verdict does. Every gap gets the facet tolerance except one above
 * or below between flat faces (`flat`): those are drawn exactly, and the fit rule floors the gap to whole layers, so
 * 0.38 mm between flat faces against 0.4 mm is one layer, which the face printed over it closes.
 */
const credited = (measuredMm: number, direction: FitDirection, flat = false): number => measuredMm + (direction === 'z' && flat ? FLOAT_MM : FIT_TOLERANCE_MM)

// The rule design.check and geom.fit_check judge gaps by, in one place: which way a gap runs, the limit for that way,
// and whether a measured gap clears it. Anything else that judges print-in-place gaps uses these too.

/** Which way a gap runs: xy between side walls, z between a face and the one printed over it. */
export type FitDirection = 'xy' | 'z'

/** The limit a gap running this way is held to. */
export const fitLimitFor = (l: FitLimits, direction: FitDirection): number => (direction === 'z' ? l.verticalMm : l.sideMm)

/**
 * Whether a measured gap clears its limit: within FIT_TOLERANCE_MM under it does, except a gap above or below between
 * flat faces (`flat`), which clears only at the limit itself.
 */
export const clearsFitLimit = (gapMm: number, direction: FitDirection, l: FitLimits, flat = false): boolean => credited(gapMm, direction, flat) >= fitLimitFor(l, direction)

/**
 * Which way an engine gap runs: its side (horizontal) or vertical gap keeps its way; a touch or a pair apart runs z when
 * one body rests on the other (`rests`) or its two points are further apart in height than across, else xy.
 */
export function fitDirection(kind: FitGap['kind'], from: readonly number[], to: readonly number[], rests = false): FitDirection {
  if (kind === 'vertical') return 'z'
  if (kind === 'horizontal') return 'xy'
  const d = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!]
  return rests || Math.abs(d[2]!) > Math.hypot(d[0]!, d[1]!) ? 'z' : 'xy'
}

/** What a gap of this size does when printed in place: fuses, binds or slides, by the fit rule, with the check's allowance. */
export function fitVerdict(g: Pick<FitGap, 'kind' | 'gapMm' | 'direction' | 'flat'>, l: FitLimits): FitResult['outcome'] {
  if (g.kind === 'fused') return 'fuses'
  return assessFit({ gapMm: Math.min(5, credited(g.gapMm, g.direction, g.flat === true)), feature: 'print_in_place', direction: g.direction, layerHeight: l.layerHeightMm, lineWidth: lineWidthFor(l.nozzleMm), nozzle: l.nozzleMm, material: l.material }).outcome
}

interface EngineGap {
  parts: [number, number]
  gapMm: number
  limitMm: number
  kind: FitGap['kind']
  from: V3
  to: V3
}
interface EngineReport {
  parts: { bounds: { min: V3; max: V3 }; item: number }[]
  gaps: EngineGap[]
  pieces: number
}

/** Faces closer than this are the same face, for saying where two bodies touch. */
const ON_FACE_MM = 0.05

type Mesh = { positions: number[]; indices: number[] }

/**
 * The bodies and gaps of the design's parts (all, or those in `only`, by index). Bodies are named for their part, with
 * a number when a part holds several or two parts share a name.
 */
export async function fitFacts(host: DesignHost, d: HostDesign, limits: FitLimits, only?: readonly number[], parts: readonly HistoryMesh[] = d.parts): Promise<FitFacts> {
  const picked = (only ?? parts.map((_, k) => k)).filter((k) => parts[k])
  const meshes = picked.map((k) => {
    const w = bakeMesh(parts[k]!, d.transform)
    return { positions: Array.from(w.positions), indices: Array.from(w.indices) }
  })
  // per two bodies, the closest side gap and the closest gap above and below, each against its own limit
  const r = (await host.call('fit.check', { meshes, minGapMm: limits.sideMm, minVerticalGapMm: limits.verticalMm, layerHeightMm: limits.layerHeightMm, apartMm: NEAR_MM, byDirection: true })) as EngineReport
  const partOf = (b: number): number => picked[r.parts[b]?.item ?? 0] ?? 0
  const nameOf = (k: number): string => parts[k]?.name?.trim() || `Part ${k + 1}`
  const count = new Map<string, number>()
  for (const k of picked) count.set(nameOf(k), (count.get(nameOf(k)) ?? 0) + 1)
  const seen = new Map<number, number>()
  const perPart = new Map<number, number>()
  for (const p of r.parts) perPart.set(p.item, (perPart.get(p.item) ?? 0) + 1)
  // a part an array of separate copies made, or the part it copied, by its name; only a name no other part has
  const copies = arrayCopies(d)
  const named = new Map<string, number>()
  for (const k of parts.keys()) named.set(nameOf(k), (named.get(nameOf(k)) ?? 0) + 1)
  const bodies = r.parts.map((p, b) => {
    const part = partOf(b)
    const n = (seen.get(p.item) ?? 0) + 1
    seen.set(p.item, n)
    const base = (count.get(nameOf(part)) ?? 0) > 1 ? `${nameOf(part)} (part ${part + 1})` : nameOf(part)
    const array = named.get(nameOf(part)) === 1 ? copies.get(nameOf(part)) : undefined
    return { part, name: (perPart.get(p.item) ?? 0) > 1 ? `${base} ${n}` : base, partName: nameOf(part), ...(array ? { array } : {}) }
  })
  const flatsOf = new Map<Mesh, { up: Flat[]; down: Flat[]; leaning: Flat[] }>()
  const facing = (m: Mesh) => flatsOf.get(m) ?? flatsOf.set(m, { up: flats(m, true), down: flats(m, false), leaning: flats(m, false, LEANS) }).get(m)!
  const all = r.gaps.map((g): FitGap => {
    const [a, b] = g.parts
    const ma = meshes[r.parts[a]?.item ?? 0]!
    const mb = meshes[r.parts[b]?.item ?? 0]!
    // which body, if either, lies under the other with a top face and a bottom face at the gap's own points
    const flatGap = g.kind === 'fused' ? 0 : g.gapMm
    const under = g.kind === 'horizontal' ? null : restsOn(facing(ma).up, facing(mb), flatGap, g.from, g.to) ? a : restsOn(facing(mb).up, facing(ma), flatGap, g.to, g.from) ? b : null
    // a gap above or below with both ends on flat faces is measured exactly; any other gap gets the facet tolerance
    const flat = under !== null && fitDirection(g.kind, g.from, g.to, true) === 'z'
    // the engine judged the gap against the bare limit; one within the tolerance of it clears
    const kind = g.kind !== 'fused' && g.kind !== 'apart' && clearsFitLimit(g.gapMm, fitDirection(g.kind, g.from, g.to, under !== null), limits, flat) ? 'apart' : g.kind
    // a touch, or a gap above and below, where one body's top face lies under the other's bottom face at the gap's own
    // points: the upper one is named first
    const lower = kind === 'fused' || kind === 'vertical' ? under : null
    const direction = fitDirection(g.kind, g.from, g.to, lower !== null)
    const pair: [number, number] = lower === a ? [b, a] : [a, b]
    const ends = lower === a ? { from: g.to, to: g.from } : { from: g.from, to: g.to }
    const where = lower !== null ? `on the top face of ${bodies[lower]!.name}` : undefined
    return { bodies: pair, kind, gapMm: g.gapMm, limitMm: fitLimitFor(limits, direction), ...ends, direction, ...(where ? { where } : {}), ...(flat && direction === 'z' ? { flat: true as const } : {}) }
  })
  // two bodies with nothing under the limit keep one gap: their closest
  const tightPair = new Set(all.filter((g) => g.kind !== 'apart').map((g) => pairKey(g.bodies)))
  const closest = new Map<string, FitGap>()
  for (const g of all) {
    const k = pairKey(g.bodies)
    const kept = closest.get(k)
    if (g.kind === 'apart' && !tightPair.has(k) && (!kept || g.gapMm < kept.gapMm)) closest.set(k, g)
  }
  const gaps = all.filter((g) => g.kind !== 'apart' || closest.get(pairKey(g.bodies)) === g)
  return { limits, bodies, pieces: r.pieces, gaps }
}

/**
 * What the design's array steps recorded (geom.array with separate copies): each copy's name with the part it copied
 * and its place in the row, and the part copied as place 1. Steps that did not go through are left out, and so is a
 * name two of them give different places.
 */
function arrayCopies(d: HostDesign): Map<string, { of: string; n: number }> {
  const out = new Map<string, { of: string; n: number } | null>()
  const put = (name: string, v: { of: string; n: number }, only = false) => {
    const was = out.get(name)
    if (was === undefined) out.set(name, v)
    else if (!only && (was === null || was.of !== v.of || was.n !== v.n)) out.set(name, null)
  }
  d.history.steps.forEach((s, k) => {
    const p = s.params
    if (p.op !== 'parts.add' || typeof p.arrayOf !== 'string' || s.suppressed || (d.status[k] && d.status[k].state !== 'done')) return
    const of = p.arrayOf
    p.parts.forEach((m, j) => put(m.name.trim(), { of, n: j + 2 }))
    put(of.trim(), { of, n: 1 }, true)
  })
  return new Map([...out].filter((e): e is [string, { of: string; n: number }] => e[1] !== null))
}

const pairKey = ([a, b]: readonly [number, number]): string => `${Math.min(a, b)} ${Math.max(a, b)}`

/** A facet facing straight up or down: its height, its corners seen from above, and their box for a quick test. */
type Flat = { z: number; xy: [[number, number], [number, number], [number, number]]; min: [number, number]; max: [number, number] }

/**
 * How straight up (or down) a facet must face to be part of a flat face: flat faces are drawn exactly, while the
 * facets of a round face nearest its top lean by half a facet's turn, a few degrees at most.
 */
const LEVEL = 1 - 1e-6

/**
 * How far from straight down the facets beside a level strip may lean for the strip to be the top of a bore: a round
 * face's next facet turns 360/n degrees, 30 at 12 sides, and drops below the strip. A flat face meets a wall, a
 * chamfer, nothing, or a rounded edge that rises from it.
 */
const LEANS = Math.cos((30 * Math.PI) / 180)

/**
 * How wide a disc of level facets near a gap's end must be for it to be on a flat face. A pin lying flat in its bore
 * can have a level facet strip along its top; the strip is one chord wide (0.6 mm on a 2.5 mm pin drawn in 25 sides,
 * less on finer ones), so it is no flat face, whichever way the pin runs.
 */
const FLAT_SPAN_MM = 1

/**
 * The mesh's facets that face straight up (or down), each as its height and its corners seen from above; with `leans`,
 * the ones that face down at least that much (a cosine) without facing straight down.
 */
function flats(m: Mesh, up: boolean, leans?: number): Flat[] {
  const out: Flat[] = []
  const at = (i: number, k: number): number => m.positions[i * 3 + k]!
  for (let t = 0; t + 2 < m.indices.length; t += 3) {
    const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
    const e1 = [at(j, 0) - at(i, 0), at(j, 1) - at(i, 1), at(j, 2) - at(i, 2)] as const
    const e2 = [at(k, 0) - at(i, 0), at(k, 1) - at(i, 1), at(k, 2) - at(i, 2)] as const
    const nz = e1[0] * e2[1] - e1[1] * e2[0]
    const l = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz)
    const toward = l < 1e-12 ? -1 : (up ? nz : -nz) / l
    if (leans === undefined ? toward < LEVEL : toward < leans || toward >= LEVEL) continue
    const xs = [at(i, 0), at(j, 0), at(k, 0)]
    const ys = [at(i, 1), at(j, 1), at(k, 1)]
    out.push({ z: (at(i, 2) + at(j, 2) + at(k, 2)) / 3, xy: [[xs[0]!, ys[0]!], [xs[1]!, ys[1]!], [xs[2]!, ys[2]!]], min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] })
  }
  return out
}

/** How far a point lies from the facet seen from above: 0 inside it, else the distance to its nearest edge. */
function apart(f: Flat, x: number, y: number): number {
  const [a, b, c] = f.xy
  const side = (p: [number, number], q: [number, number]): number => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
  const s = [side(a, b), side(b, c), side(c, a)]
  if (s.every((v) => v >= 0) || s.every((v) => v <= 0)) return 0
  const edge = (p: [number, number], q: [number, number]): number => {
    const [dx, dy] = [q[0] - p[0], q[1] - p[1]]
    const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy)
  }
  return Math.min(edge(a, b), edge(b, c), edge(c, a))
}

/** Whether a flat facet holds the point: at its height and on it seen from above, each within ON_FACE_MM. */
const holds = (f: Flat, p: V3): boolean => Math.abs(f.z - p[2]) <= ON_FACE_MM && apart(f, p[0], p[1]) <= ON_FACE_MM

/**
 * Whether the gap's own ends lie on a top face of the lower body (at `low`) and a bottom face of the upper one (at
 * `high`), `gapMm` apart. Only the facets at the two points count, so faces elsewhere on the meshes, or another body
 * of the same part, never decide it. The upper face is the one printed over the gap, which closes it, so it must be a
 * flat face (wide); the lower end needs only a level facet, so a rail or rib narrower than FLAT_SPAN_MM under a flat
 * bottom is still a gap between flat faces.
 */
function restsOn(tops: readonly Flat[], upper: { down: readonly Flat[]; leaning: readonly Flat[] }, gapMm: number, low: V3, high: V3): boolean {
  const bottoms = upper.down
  if (high[2] - low[2] < gapMm - ON_FACE_MM) return false
  const t = tops.filter((f) => holds(f, low))
  if (!t.length) return false
  const u = bottoms.filter((b) => holds(b, high) && t.some((f) => Math.abs(b.z - f.z - gapMm) <= ON_FACE_MM))
  return u.length > 0 && wide(high, bottoms, upper.leaning)
}

/** How close to a facet, seen from above, a sample point must be to lie on it: the facets of one face share their edges. */
const ON_EDGE_MM = 1e-6

/** Directions a disc may lie in from a gap's end, and how far: the end can be at a face's edge or corner. */
const TURNS = 12
const REACH_MM = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]

/**
 * How finely the way to a disc and its rim are sampled: a groove or slot this wide or wider between two level faces at
 * one height is always seen, so a narrow face beside it is not taken for part of the wide one.
 */
const SAMPLE_MM = 0.05

/** How far across from a disc's center a level strip is looked at for the leaning facets of a round face beside it. */
const STRIP_MM = 3

/** How far below the level strip the leaning facets beside it may lie, seen at their middles. */
const LEAN_DROP_MM = 0.5

/**
 * Whether the level facets at the point's height hold a disc FLAT_SPAN_MM across that the point reaches over level
 * facets: a flat face, not one strip of facets along a round one. Each disc is tested at its center and points on its
 * rim SAMPLE_MM apart, each inside an actual facet seen from above, so the answer does not depend on how the part is
 * turned. A disc on a strip that ends on facets leaning a few degrees on both sides (`leaning`) is the top of a
 * bore, however wide the strip a bore drawn with few sides has there.
 */
function wide(p: V3, all: readonly Flat[], leaning: readonly Flat[] = []): boolean {
  const r = FLAT_SPAN_MM / 2
  const room = REACH_MM.at(-1)! + Math.max(r, STRIP_MM) + 2 * SAMPLE_MM + ON_FACE_MM
  const near = (f: Flat): boolean => f.min[0] <= p[0] + room && f.max[0] >= p[0] - room && f.min[1] <= p[1] + room && f.max[1] >= p[1] - room
  const level = all.filter((f) => Math.abs(f.z - p[2]) <= ON_FACE_MM && near(f))
  const beside = leaning.filter((f) => f.z < p[2] + ON_FACE_MM && f.z > p[2] - LEAN_DROP_MM && near(f))
  const inside = (fs: readonly Flat[], x: number, y: number): boolean => fs.some((f) => x >= f.min[0] - ON_EDGE_MM && x <= f.max[0] + ON_EDGE_MM && y >= f.min[1] - ON_EDGE_MM && y <= f.max[1] + ON_EDGE_MM && apart(f, x, y) <= ON_EDGE_MM)
  const on = (x: number, y: number): boolean => inside(level, x, y)
  const turns = (n: number) => Array.from({ length: n }, (_, k): [number, number] => [Math.cos((2 * Math.PI * k) / n), Math.sin((2 * Math.PI * k) / n)])
  const ways = turns(TURNS)
  const rim = turns(Math.ceil((Math.PI * FLAT_SPAN_MM) / SAMPLE_MM))
  const disc = (x: number, y: number): boolean => on(x, y) && rim.every(([c, s]) => on(x + r * c, y + r * s))
  // where the level facets end going one way from (x, y), within STRIP_MM, and whether a leaning facet is there
  const endsLeaning = (x: number, y: number, c: number, s: number): boolean => {
    for (let d = SAMPLE_MM; d <= STRIP_MM; d += SAMPLE_MM) if (!on(x + d * c, y + d * s)) return inside(beside, x + (d + SAMPLE_MM) * c, y + (d + SAMPLE_MM) * s)
    return false
  }
  const round = (x: number, y: number): boolean => beside.length > 0 && ways.slice(0, TURNS / 2).some(([c, s]) => endsLeaning(x, y, c, s) && endsLeaning(x, y, -c, -s))
  for (const [c, s] of ways)
    for (const [k, d] of REACH_MM.entries()) {
      // the way from the point (which holds() found on a facet) to the disc's center stays on level facets, so the
      // disc is on the point's own face
      let joined = true
      for (let e = (REACH_MM[k - 1] ?? 0) + SAMPLE_MM; e <= d + 1e-9 && joined; e += SAMPLE_MM) joined = on(p[0] + e * c, p[1] + e * s)
      if (!joined) break
      const [x, y] = [p[0] + d * c, p[1] + d * s]
      if (disc(x, y) && !round(x, y)) return true
    }
  return false
}
