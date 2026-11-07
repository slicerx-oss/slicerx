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
 * How much a side gap measured on the mesh may read under the modeled one. A round face is drawn as flat facets inside its
 * circle, so a pin's corner faces a bore's facet a little closer than the two circles are: the engine draws curves to
 * within 0.005 mm (sketch arcs) to 0.02 mm (a cylinder body of up to about 9 mm radius), and adding up a model's
 * coordinates leaves float error. A gap modeled at exactly the limit reads 0.28 to 0.3 mm against 0.3 mm. A tenth of
 * the 0.2 mm or so the fit rule leaves after the faces grow, so a gap this much under the limit still slides.
 */
export const FIT_TOLERANCE_MM = 0.02

/** Float error in a measured gap above or below, which the fit rule allows for too. */
const FLOAT_MM = 1e-6

/**
 * The gap the check judges for a measured one, as the verdict does. Only a side gap gets the
 * tolerance: facets bend side walls, while a gap above or below lies between flat faces and the fit rule floors it to
 * whole layers, so 0.38 mm against 0.4 mm is one layer, which the face printed over it closes.
 */
const credited = (measuredMm: number, direction: FitDirection): number => measuredMm + (direction === 'xy' ? FIT_TOLERANCE_MM : FLOAT_MM)

// The rule design.check and geom.fit_check judge gaps by, in one place: which way a gap runs, the limit for that way,
// and whether a measured gap clears it. Anything else that judges print-in-place gaps uses these too.

/** Which way a gap runs: xy between side walls, z between a face and the one printed over it. */
export type FitDirection = 'xy' | 'z'

/** The limit a gap running this way is held to. */
export const fitLimitFor = (l: FitLimits, direction: FitDirection): number => (direction === 'z' ? l.verticalMm : l.sideMm)

/** Whether a measured gap clears its limit: a side gap within FIT_TOLERANCE_MM under it does, one above or below only at it. */
export const clearsFitLimit = (gapMm: number, direction: FitDirection, l: FitLimits): boolean => credited(gapMm, direction) >= fitLimitFor(l, direction)

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

/** What a gap of this size does when printed in place: fuses, binds or slides, by the fit rule. */
export function fitVerdict(g: Pick<FitGap, 'kind' | 'gapMm' | 'direction'>, l: FitLimits): FitResult['outcome'] {
  if (g.kind === 'fused') return 'fuses'
  // the fit rule allows for float error above and below itself
  return assessFit({ gapMm: Math.min(5, g.direction === 'z' ? g.gapMm : credited(g.gapMm, 'xy')), feature: 'print_in_place', direction: g.direction, layerHeight: l.layerHeightMm, lineWidth: lineWidthFor(l.nozzleMm), nozzle: l.nozzleMm, material: l.material }).outcome
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
  const bodies = r.parts.map((p, b) => {
    const part = partOf(b)
    const n = (seen.get(p.item) ?? 0) + 1
    seen.set(p.item, n)
    const base = (count.get(nameOf(part)) ?? 0) > 1 ? `${nameOf(part)} (part ${part + 1})` : nameOf(part)
    return { part, name: (perPart.get(p.item) ?? 0) > 1 ? `${base} ${n}` : base, partName: nameOf(part) }
  })
  const flatsOf = new Map<Mesh, { up: Flat[]; down: Flat[] }>()
  const facing = (m: Mesh) => flatsOf.get(m) ?? flatsOf.set(m, { up: flats(m, true), down: flats(m, false) }).get(m)!
  const all = r.gaps.map((g): FitGap => {
    const [a, b] = g.parts
    const ma = meshes[r.parts[a]?.item ?? 0]!
    const mb = meshes[r.parts[b]?.item ?? 0]!
    // the engine judged the gap against the bare limit; a side gap within the tolerance of it clears, one above and
    // below only at the limit itself
    const kind = g.kind !== 'fused' && g.kind !== 'apart' && clearsFitLimit(g.gapMm, fitDirection(g.kind, g.from, g.to), limits) ? 'apart' : g.kind
    // a touch, or a gap above and below, where one body's top face lies under the other's bottom face at the gap's own
    // points: the upper one is named first
    const flat = kind === 'fused' ? 0 : g.gapMm
    const rests = kind === 'fused' || kind === 'vertical'
    const lower = !rests ? null : restsOn(facing(ma).up, facing(mb).down, flat, g.from, g.to) ? a : restsOn(facing(mb).up, facing(ma).down, flat, g.to, g.from) ? b : null
    const direction = fitDirection(g.kind, g.from, g.to, lower !== null)
    const pair: [number, number] = lower === a ? [b, a] : [a, b]
    const ends = lower === a ? { from: g.to, to: g.from } : { from: g.from, to: g.to }
    const where = lower !== null ? `on the top face of ${bodies[lower]!.name}` : undefined
    return { bodies: pair, kind, gapMm: g.gapMm, limitMm: fitLimitFor(limits, direction), ...ends, direction, ...(where ? { where } : {}) }
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

const pairKey = ([a, b]: readonly [number, number]): string => `${Math.min(a, b)} ${Math.max(a, b)}`

type Flat = { z: number; min: [number, number]; max: [number, number] }

/** The mesh's facets that face up (or down), each as its height and its box seen from above. */
function flats(m: Mesh, up: boolean): Flat[] {
  const out: Flat[] = []
  const at = (i: number, k: number): number => m.positions[i * 3 + k]!
  for (let t = 0; t + 2 < m.indices.length; t += 3) {
    const [i, j, k] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]
    const e1 = [at(j, 0) - at(i, 0), at(j, 1) - at(i, 1), at(j, 2) - at(i, 2)] as const
    const e2 = [at(k, 0) - at(i, 0), at(k, 1) - at(i, 1), at(k, 2) - at(i, 2)] as const
    const nz = e1[0] * e2[1] - e1[1] * e2[0]
    const l = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz)
    if (l < 1e-12 || (up ? nz : -nz) / l < 0.99) continue
    const xs = [at(i, 0), at(j, 0), at(k, 0)]
    const ys = [at(i, 1), at(j, 1), at(k, 1)]
    out.push({ z: (at(i, 2) + at(j, 2) + at(k, 2)) / 3, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] })
  }
  return out
}

/** Whether a flat facet holds the point, seen from above and in height, within ON_FACE_MM. */
const holds = (f: Flat, p: V3): boolean => Math.abs(f.z - p[2]) <= ON_FACE_MM && p[0] >= f.min[0] - ON_FACE_MM && p[0] <= f.max[0] + ON_FACE_MM && p[1] >= f.min[1] - ON_FACE_MM && p[1] <= f.max[1] + ON_FACE_MM

/**
 * Whether the gap's own ends lie on a top face of the lower body (at `low`) and a bottom face of the upper one (at
 * `high`), `gapMm` apart. Only the facets at the two points count, so faces elsewhere on the meshes, or another body
 * of the same part, never decide it.
 */
function restsOn(tops: readonly Flat[], bottoms: readonly Flat[], gapMm: number, low: V3, high: V3): boolean {
  if (high[2] - low[2] < gapMm - ON_FACE_MM) return false
  const t = tops.filter((f) => holds(f, low))
  if (!t.length) return false
  return bottoms.some((u) => holds(u, high) && t.some((f) => Math.abs(u.z - f.z - gapMm) <= ON_FACE_MM))
}
