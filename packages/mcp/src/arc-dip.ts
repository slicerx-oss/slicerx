// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a loft section's arc dips under the section's lowest drawn point: an arc whose circle bottoms out between its
// ends, as one drawn from a side into a flat line through a point that does not meet the line level does. The body
// follows the arc as drawn, so it sits that much lower than every point the section names. Named by geom.loft as a
// note, never refused and never changed; a replay says nothing. design.edit_step's section edit takes only sections
// drawn as points, which have no arcs, so it has nothing to name.
import type { SketchLoop } from '@slicerx/cad-history'

type P2 = readonly [number, number]
type V3 = readonly [number, number, number]

/** A section whose arc dips: its place in the loft (from 1), the loft's section count, the dip in mm and the arc's end. */
export interface ArcDip {
  index: number
  of: number
  mm: number
  end: [number, number]
}

/** A loft section as the note reads it: its loops, whether it is an open chain, and its frame when it has one. */
export interface DipSection {
  loops: readonly SketchLoop[]
  open?: boolean | undefined
  frame?: { origin: readonly number[]; normal: readonly number[]; u?: readonly number[]; v?: readonly number[] } | undefined
}

/** A dip under this is the flattening's own, mm, and is not named. */
const FLOOR_MM = 0.01

const r2 = (v: number): number => Math.round(v * 100) / 100
const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0

/**
 * The note geom.loft adds for the section whose arc dips deepest (the answer's arcDips lists them all). Its words stay as they are; only the numbers change: "Section 4 of 9 dips 0.12 mm under its lowest drawn point:
 * the arc ending at (6.72, 0) bottoms out before it gets there, and the body follows it. Move that arc's through point so
 * it runs level into (6.72, 0), tangent to the line it meets, or draw that stretch as a line."
 */
export function arcDipNote(d: ArcDip): string {
  const at = `(${d.end[0]}, ${d.end[1]})`
  return `Section ${d.index} of ${d.of} dips ${d.mm} mm under its lowest drawn point: the arc ending at ${at} bottoms out before it gets there, and the body follows it. Move that arc's through point so it runs level into ${at}, tangent to the line it meets, or draw that stretch as a line.`
}

/** One arc of a loop in its plane: its ends, its circle and the way it turns (sweep, radians, counterclockwise positive). */
interface Arc {
  from: P2
  to: P2
  center: P2
  radius: number
  start: number
  sweep: number
}

/** The circle through three points, or null when they are in a line. */
function circleThrough(a: P2, b: P2, c: P2): { center: P2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const [a2, b2, c2] = [a[0] ** 2 + a[1] ** 2, b[0] ** 2 + b[1] ** 2, c[0] ** 2 + c[1] ** 2]
  const center: P2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d]
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) }
}

const angle = (c: P2, p: P2): number => Math.atan2(p[1] - c[1], p[0] - c[0])

/**
 * A loop's arcs and every point it draws (its start, each piece's end, an arc's through point and a spline's points),
 * or null for a loop this cannot place: a circle, an ellipse, or a piece drawn by lengths and turns.
 */
function loopArcs(l: SketchLoop): { arcs: Arc[]; drawn: P2[] } | null {
  if (!('segments' in l)) return 'points' in l && !('type' in l) ? { arcs: [], drawn: l.points.map((p) => [p[0], p[1]] as const) } : null
  let at: P2 = [l.start[0], l.start[1]]
  const drawn: P2[] = [at]
  const arcs: Arc[] = []
  for (const g of l.segments as Record<string, unknown>[]) {
    const to = Array.isArray(g['to']) ? ([(g['to'] as number[])[0]!, (g['to'] as number[])[1]!] as const) : null
    if (g['type'] === 'arc' && Array.isArray(g['through']) && to) {
      const th: P2 = [(g['through'] as number[])[0]!, (g['through'] as number[])[1]!]
      const c = circleThrough(at, th, to)
      if (c) {
        // the way from the start through the point: counterclockwise when the point is left of the chord
        const ccw = (th[0] - at[0]) * (to[1] - at[1]) - (th[1] - at[1]) * (to[0] - at[0]) > 0
        const turn = (angle(c.center, to) - angle(c.center, at) + 4 * Math.PI) % (2 * Math.PI)
        arcs.push({ from: at, to, ...c, start: angle(c.center, at), sweep: ccw ? turn : turn - 2 * Math.PI })
      }
      drawn.push(th)
    } else if (g['type'] === 'arc' && Array.isArray(g['center']) && typeof g['sweepDeg'] === 'number') {
      const center: P2 = [(g['center'] as number[])[0]!, (g['center'] as number[])[1]!]
      const sweep = ((g['sweepDeg'] as number) * Math.PI) / 180
      const radius = Math.hypot(at[0] - center[0], at[1] - center[1])
      const start = angle(center, at)
      const end: P2 = [center[0] + radius * Math.cos(start + sweep), center[1] + radius * Math.sin(start + sweep)]
      arcs.push({ from: at, to: end, center, radius, start, sweep })
      at = end
      drawn.push(at)
      continue
    } else if (g['type'] === 'spline' && Array.isArray(g['points'])) {
      for (const q of g['points'] as number[][]) drawn.push([q[0]!, q[1]!])
    } else if (!to || (g['type'] === 'arc' && !Array.isArray(g['through']))) {
      // an arc by its radius, or a piece by lengths and turns: only the sketch solver places it
      return null
    }
    if (!to) return null
    at = to
    drawn.push(at)
  }
  return { arcs, drawn }
}

/** The section's plane: where a point of it is in the world, or null for a frame with no axes given. */
function placer(frame: DipSection['frame']): ((p: P2) => V3) | null {
  if (!frame) return (p) => [p[0], p[1], 0]
  const { origin: o, u, v } = frame
  if (!u || !v) return null
  return (p) => [0, 1, 2].map((i) => (o[i] ?? 0) + (u[i] ?? 0) * p[0] + (v[i] ?? 0) * p[1]) as unknown as V3
}

/** How far a section's deepest arc goes under its lowest drawn point, mm, and that arc's end nearest the dip. */
function sectionDip(s: DipSection): { mm: number; end: P2 } | null {
  if (s.open) return null
  const at = placer(s.frame)
  if (!at) return null
  const read = s.loops.filter((l) => !l.construction).map(loopArcs)
  if (read.some((r) => r === null)) return null
  const loops = read as { arcs: Arc[]; drawn: P2[] }[]
  const lowest = Math.min(...loops.flatMap((l) => l.drawn.map((p) => at(p)[2])))
  // the height of the world over the plane's two axes, so a circle's lowest point is where it turns against it
  const o = at([0, 0])
  const [hu, hv] = [at([1, 0])[2] - o[2], at([0, 1])[2] - o[2]]
  let best: { mm: number; end: P2 } | null = null
  for (const a of loops.flatMap((l) => l.arcs)) {
    if (Math.hypot(hu, hv) < 1e-12) continue
    const bottom = Math.atan2(-hv, -hu)
    // the bottom lies on the arc when it is within the sweep from the start, the way the arc turns
    const into = ((((bottom - a.start) * Math.sign(a.sweep)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    if (into > Math.abs(a.sweep)) continue
    const z = at([a.center[0] + a.radius * Math.cos(bottom), a.center[1] + a.radius * Math.sin(bottom)])[2]
    const mm = lowest - z
    if (mm <= FLOOR_MM || (best && mm <= best.mm + 1e-9)) continue
    best = { mm, end: into <= Math.abs(a.sweep) / 2 ? a.from : a.to }
  }
  return best
}

/** The sections of a loft whose arcs dip under their lowest drawn point by more than the floor, deepest first. */
export function arcDips(profiles: readonly DipSection[]): ArcDip[] {
  const out: ArcDip[] = []
  profiles.forEach((p, k) => {
    const d = sectionDip(p)
    if (d) out.push({ index: k + 1, of: profiles.length, mm: r2(d.mm), end: [r3(d.end[0]), r3(d.end[1])] })
  })
  return out.sort((a, b) => b.mm - a.mm || a.index - b.index)
}

/**
 * A loft's answer with its dipping arcs named: the note after the summary and the sections as arcDips. An answer with
 * none comes back as it is.
 */
export function withArcDipNote<T extends { summary: string; output: Record<string, unknown> }>(out: T, profiles: readonly DipSection[]): T {
  const dips = arcDips(profiles)
  if (!dips.length) return out
  return { ...out, summary: `${out.summary.replace(/[.\s]+$/, '')}. ${arcDipNote(dips[0]!)}`, output: { ...out.output, arcDips: dips } }
}
