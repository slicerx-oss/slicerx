// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gaps between the bodies of a design, for a print-in-place part: the engine's fit check (fit.check, the check the
// app runs on the plate) over every part as the design holds it, with the limits from the fit rule (the fit_check
// skill's assessFit) for the printer's nozzle, layer height and material. design.check and geom.fit_check read it.
import { bakeMesh, type Design as HostDesign, type DesignHost, type HistoryMesh } from '@slicerx/cad-history'
import { assessFit, type FitResult } from '@slicerx/pilot'
import { NEAR_MM, nozzleOr, type FitFacts, type FitGap, type FitLimits } from './design-check'

type V3 = [number, number, number]

/** What the fit rule needs about the print, each optional: the nozzle (0.4 mm), layer height (half the nozzle) and material (PLA). */
export interface FitProfile {
  nozzleMm?: number | undefined
  layerHeightMm?: number | undefined
  material?: string | undefined
}

const lineWidth = (nozzle: number): number => Math.round(nozzle * 1.05 * 100) / 100

/** The smallest print-in-place gaps for a profile: the gap the fit rule suggests, side by side and above or below. */
export function fitLimits(p: FitProfile = {}): FitLimits {
  const nozzleMm = nozzleOr(p.nozzleMm)
  const layerHeightMm = typeof p.layerHeightMm === 'number' && Number.isFinite(p.layerHeightMm) && p.layerHeightMm > 0 ? p.layerHeightMm : nozzleMm / 2
  const material = p.material?.trim() || 'pla'
  const base = { gapMm: 0, feature: 'print_in_place' as const, layerHeight: layerHeightMm, lineWidth: lineWidth(nozzleMm), nozzle: nozzleMm, material }
  return { sideMm: assessFit({ ...base, direction: 'xy' }).suggestedGapMm, verticalMm: assessFit({ ...base, direction: 'z' }).suggestedGapMm, material, nozzleMm, layerHeightMm }
}

/** What a gap of this size does when printed in place: fuses, binds or slides, by the fit rule. */
export function fitVerdict(g: Pick<FitGap, 'kind' | 'gapMm' | 'direction'>, l: FitLimits): FitResult['outcome'] {
  if (g.kind === 'fused') return 'fuses'
  return assessFit({ gapMm: Math.min(5, g.gapMm), feature: 'print_in_place', direction: g.direction, layerHeight: l.layerHeightMm, lineWidth: lineWidth(l.nozzleMm), nozzle: l.nozzleMm, material: l.material }).outcome
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
  const r = (await host.call('fit.check', { meshes, minGapMm: limits.sideMm, minVerticalGapMm: limits.verticalMm, layerHeightMm: limits.layerHeightMm, apartMm: NEAR_MM })) as EngineReport
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
    return { part, name: (perPart.get(p.item) ?? 0) > 1 ? `${base} ${n}` : base }
  })
  const gaps = r.gaps.map((g): FitGap => {
    const [a, b] = g.parts
    const ma = meshes[r.parts[a]?.item ?? 0]!
    const mb = meshes[r.parts[b]?.item ?? 0]!
    // one body's top face under the other's bottom face, touching or across the gap: the upper one is named first
    const flat = g.kind === 'fused' ? 0 : g.gapMm
    const lower = g.kind === 'apart' ? null : restsOn(ma, mb, flat) ? a : restsOn(mb, ma, flat) ? b : null
    const d: V3 = [g.to[0] - g.from[0], g.to[1] - g.from[1], g.to[2] - g.from[2]]
    const direction = lower !== null || g.kind === 'vertical' || (g.kind !== 'horizontal' && Math.abs(d[2]) > Math.hypot(d[0], d[1])) ? 'z' : 'xy'
    const pair: [number, number] = lower === a ? [b, a] : [a, b]
    const ends = lower === a ? { from: g.to, to: g.from } : { from: g.from, to: g.to }
    const where = lower !== null ? `on the top face of ${bodies[lower]!.name}` : undefined
    return { bodies: pair, kind: g.kind, gapMm: g.gapMm, limitMm: g.limitMm, ...ends, direction, ...(where ? { where } : {}) }
  })
  return { limits, bodies, pieces: r.pieces, gaps }
}

type Flat = { z: number; min: [number, number]; max: [number, number] }

/** The mesh's facets that face up (or down), each as its height and its box seen from above. */
function flats(m: { positions: number[]; indices: number[] }, up: boolean): Flat[] {
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

/** Whether `upper`'s bottom faces sit `gapMm` over `lower`'s top faces somewhere, overlapping seen from above. */
function restsOn(lower: { positions: number[]; indices: number[] }, upper: { positions: number[]; indices: number[] }, gapMm: number): boolean {
  const tops = flats(lower, true)
  if (!tops.length) return false
  for (const u of flats(upper, false))
    for (const t of tops)
      if (Math.abs(u.z - t.z - gapMm) <= ON_FACE_MM && Math.min(u.max[0], t.max[0]) - Math.max(u.min[0], t.min[0]) > ON_FACE_MM && Math.min(u.max[1], t.max[1]) - Math.max(u.min[1], t.min[1]) > ON_FACE_MM) return true
  return false
}
