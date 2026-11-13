// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How thin a loft's sections are across, read in each section's own plane the way design.check reads a wall: from
// points along every edge of the outline, straight in to the first other edge. A hit on the next or the previous edge
// within two nozzle lines of their shared corner is the tip of a V (a keel, a pointed nose), not a wall, as body-facts'
// minWall skips tips. A first or last section thin only at the body's end, past two lines a nozzle width in, is the
// end's taper, as design.check leaves a sharp edge's taper out. A section under two nozzle lines across is named in a
// note by geom.loft and design.edit_step, never refused: a section cannot see a body joined over its edge, and
// design.check, which reads the whole part, has the last word.
import type { SketchLoop } from '@slicerx/cad-history'

type P2 = readonly [number, number]

/** A section under the floor: its place in the loft (from 1), the loft's section count and its thinnest, mm. */
export interface ThinSection {
  index: number
  of: number
  mm: number
}

/**
 * The note geom.loft and design.edit_step add when a section is under two nozzle lines across, for the thinnest such
 * section (the answer's thinSections lists them all). Its words stay as they are; only the numbers change: "Section 9 of 9 is 0.46 mm across at its narrowest, under the 0.8 mm a 0.4 mm nozzle prints (two lines).
 * Widen it there, or leave it if another body covers that edge."
 */
export const thinSectionNote = (s: ThinSection, floorMm: number, nozzleMm: number): string =>
  `Section ${s.index} of ${s.of} is ${s.mm} mm across at its narrowest, under the ${floorMm} mm a ${nozzleMm} mm nozzle prints (two lines). Widen it there, or leave it if another body covers that edge.`

/** Samples along each edge. */
const SAMPLES = 9
const r2 = (v: number): number => Math.round(v * 100) / 100

/**
 * A loop's outline in its plane: points, a closed spline's points, or a chain whose every segment ends at a point
 * (lines and arcs to a point, an arc through a point, a spline's points); a circle or an ellipse is its narrowest
 * axis. null for a loop drawn by lengths and turns, which only the sketch solver places.
 */
export function loopOutline(l: SketchLoop): { points: P2[] } | { acrossMm: number } | null {
  if ('type' in l && l.type === 'circle') return { acrossMm: l.diameterMm }
  if ('type' in l && l.type === 'ellipse') return { acrossMm: Math.min(l.widthMm, l.heightMm) }
  if ('points' in l) return { points: l.points.map((p) => [p[0], p[1]] as const) }
  const out: P2[] = [[l.start[0], l.start[1]]]
  for (const g of l.segments as Record<string, unknown>[]) {
    if (!Array.isArray(g['to'])) return null
    if (Array.isArray(g['through'])) out.push([(g['through'] as number[])[0]!, (g['through'] as number[])[1]!])
    if (Array.isArray(g['points'])) for (const q of g['points'] as number[][]) out.push([q[0]!, q[1]!])
    out.push([(g['to'] as number[])[0]!, (g['to'] as number[])[1]!])
  }
  const [a, b] = [out[0]!, out[out.length - 1]!]
  if (out.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) out.pop()
  return { points: out }
}

const area = (p: readonly P2[]): number => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * a[1], 0) / 2

/** Where a ray from `o` along `d` meets segment a-b: the distance along the ray, or null. */
function hit(o: P2, d: P2, a: P2, b: P2): number | null {
  const ex = b[0] - a[0]
  const ey = b[1] - a[1]
  const den = d[0] * ey - d[1] * ex
  if (Math.abs(den) < 1e-15) return null
  const ax = a[0] - o[0]
  const ay = a[1] - o[1]
  const t = (ax * ey - ay * ex) / den
  const u = (ax * d[1] - ay * d[0]) / den
  return t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null
}

/** The thinnest a closed outline is across, mm, not counting tips within `tipMm` of a corner; null when nothing reads. */
export function outlineWidth(pts: readonly P2[], tipMm: number): number | null {
  const n = pts.length
  if (n < 3) return null
  const s = area(pts)
  if (Math.abs(s) < 1e-12) return 0
  let best = Infinity
  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-9) continue
    const ex = (b[0] - a[0]) / len
    const ey = (b[1] - a[1]) / len
    // inward: left of the edge on a counterclockwise outline
    const d: P2 = s > 0 ? [-ey, ex] : [ey, -ex]
    for (let k = 1; k <= SAMPLES; k++) {
      const o: P2 = [a[0] + (b[0] - a[0]) * (k / (SAMPLES + 1)), a[1] + (b[1] - a[1]) * (k / (SAMPLES + 1))]
      let t = Infinity
      let j = -1
      for (let m = 0; m < n; m++) {
        if (m === i) continue
        const h = hit(o, d, pts[m]!, pts[(m + 1) % n]!)
        if (h !== null && h < t) [t, j] = [h, m]
      }
      if (j < 0 || t >= best) continue
      const corner = j === (i + 1) % n ? b : (j + 1) % n === i ? a : null
      if (corner && Math.hypot(o[0] - corner[0], o[1] - corner[1]) <= tipMm) continue
      best = t
    }
  }
  return Number.isFinite(best) ? best : null
}

/** A loft section as the note reads it: its loops, whether it is an open chain, and its frame when it has one. */
export interface LoftSection {
  loops: readonly SketchLoop[]
  open?: boolean | undefined
  frame?: { origin: readonly number[]; normal: readonly number[] } | undefined
}

/** How thin a section is across: its outer outline (its largest loop that is not a construction loop), or null. */
function sectionWidth(p: LoftSection, floor: number): number | null {
  // an open chain has no inside to be thin across: it lofts only thickened
  if (p.open) return null
  const outlines = p.loops.filter((l) => !l.construction).map(loopOutline)
  const across = outlines.flatMap((o) => (o && 'acrossMm' in o ? [o.acrossMm] : []))
  const rings = outlines.flatMap((o) => (o && 'points' in o ? [o.points] : []))
  const outer = rings.reduce<P2[] | null>((m, r) => (!m || Math.abs(area(r)) > Math.abs(area(m)) ? r : m), null)
  // a round loop is the outline when it is the only one, or wider than every ring
  const round = across.length && (!outer || across.some((a) => (Math.PI * a * a) / 4 > Math.abs(area(outer)))) ? Math.max(...across) : null
  return round !== null ? round : outer ? outlineWidth(outer, floor) : null
}

/**
 * Whether a thin end section is the taper of the body's end: the width one nozzle width inboard, read straight between
 * it and the section next to it over the distance between their planes, is at least the floor. The slicer prints that
 * last fraction of a millimeter thin or drops it, as design.check leaves a sharp edge's taper out of the wall. Only the
 * first and the last section are ends; a section with no frame, or one whose neighbor does not read, is not a taper.
 */
function endTaper(profiles: readonly LoftSection[], k: number, mm: number, floor: number, nozzleMm: number): boolean {
  const n = profiles.length
  if (n < 2 || (k !== 0 && k !== n - 1)) return false
  const [end, next] = [profiles[k]!, profiles[k === 0 ? 1 : n - 2]!]
  const inboard = next && sectionWidth(next, floor)
  if (!end.frame || !next.frame || inboard === null || inboard === undefined) return false
  const nl = Math.hypot(end.frame.normal[0] ?? 0, end.frame.normal[1] ?? 0, end.frame.normal[2] ?? 0)
  const gap = nl > 1e-9 ? Math.abs([0, 1, 2].reduce((s, i) => s + ((next.frame!.origin[i] ?? 0) - (end.frame!.origin[i] ?? 0)) * (end.frame!.normal[i] ?? 0), 0)) / nl : 0
  if (gap < 1e-6) return false
  return mm + ((inboard - mm) * Math.min(nozzleMm, gap)) / gap >= floor - 1e-9
}

/**
 * The sections of a loft under two nozzle lines across, thinnest first. Each section is read by its outer outline (its
 * largest loop that is not a construction loop); a hole in it is left to design.check, and an open chain is skipped.
 * A first or last section that is only the taper of the body's end (endTaper) is left out.
 */
export function thinSections(profiles: readonly LoftSection[], nozzleMm: number): ThinSection[] {
  const floor = 2 * nozzleMm
  const out: ThinSection[] = []
  profiles.forEach((p, k) => {
    const mm = sectionWidth(p, floor)
    if (mm !== null && mm < floor - 1e-9 && !endTaper(profiles, k, mm, floor, nozzleMm)) out.push({ index: k + 1, of: profiles.length, mm: r2(mm) })
  })
  return out.sort((a, b) => a.mm - b.mm)
}

/**
 * A loft's answer with its thin sections named: the note after the summary and the sections as thinSections. An answer
 * with none comes back as it is.
 */
export function withThinNote<T extends { summary: string; output: Record<string, unknown> }>(out: T, profiles: readonly LoftSection[], nozzleMm: number): T {
  const thin = thinSections(profiles, nozzleMm)
  if (!thin.length) return out
  const note = thinSectionNote(thin[0]!, r2(2 * nozzleMm), nozzleMm)
  return { ...out, summary: `${out.summary.replace(/[.\s]+$/, '')}. ${note}`, output: { ...out.output, thinSections: thin } }
}
