// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature patterns: a shape on a face repeated along a line, a grid or a circle, or at points, as one step (sx-geom
// face.rs, Pattern). The engine makes the copies; this places them for the preview the same way, counts them,
// reads the panel's fields and says what is wrong with a pattern in words. Positions are face coordinates (u, v),
// mm, and the shape itself is always the first copy.
import type { Vec2 } from '../geom/cad'
import { num } from './panel-kit'

export type Pattern =
  | { kind: 'linear'; count: number; stepMm: Vec2; count2?: number; step2Mm?: Vec2 }
  | { kind: 'circular'; count: number; center: Vec2; angleDeg?: number }
  | { kind: 'points'; offsets: Vec2[] }

/** At most this many copies in one step. */
export const MAX_COPIES = 500

export function copyCount(p: Pattern): number {
  if (p.kind === 'linear') return p.count * (p.count2 ?? 1)
  if (p.kind === 'circular') return p.count
  return p.offsets.length + 1
}

/** Where each copy puts a point of the shape. */
export function patternCopies(p: Pattern): ((q: Vec2) => Vec2)[] {
  if (p.kind === 'points') return [(q) => q, ...p.offsets.map((d) => (q: Vec2): Vec2 => [q[0] + d[0], q[1] + d[1]])]
  if (p.kind === 'linear') {
    const out: ((q: Vec2) => Vec2)[] = []
    const s2 = p.step2Mm ?? [0, 0]
    for (let j = 0; j < (p.count2 ?? 1); j++) {
      for (let i = 0; i < p.count; i++) {
        const d: Vec2 = [p.stepMm[0] * i + s2[0] * j, p.stepMm[1] * i + s2[1] * j]
        out.push((q) => [q[0] + d[0], q[1] + d[1]])
      }
    }
    return out
  }
  const sweep = p.angleDeg ?? 360
  const full = Math.abs(Math.abs(sweep) - 360) < 1e-9
  const step = full ? sweep / p.count : p.count > 1 ? sweep / (p.count - 1) : 0
  const [cx, cy] = p.center
  return Array.from({ length: p.count }, (_, i) => {
    const a = (step * i * Math.PI) / 180
    const [c, s] = [Math.cos(a), Math.sin(a)]
    return (q: Vec2): Vec2 => [cx + (q[0] - cx) * c - (q[1] - cy) * s, cy + (q[0] - cx) * s + (q[1] - cy) * c]
  })
}

/** What is wrong with the pattern, in words, or null. */
export function patternProblem(p: Pattern): string | null {
  const n = copyCount(p)
  if (p.kind !== 'points' && (!Number.isInteger(p.count) || p.count < 2)) return 'A pattern has at least 2 copies.'
  if (p.kind === 'linear' && p.count2 !== undefined && (!Number.isInteger(p.count2) || p.count2 < 1)) return 'A grid has at least 1 row.'
  if (n > MAX_COPIES) return `A pattern has at most ${MAX_COPIES} copies; this one has ${n}.`
  if (p.kind === 'linear') {
    const flat = (v: Vec2 | undefined) => !v || !(Number.isFinite(v[0]) && Number.isFinite(v[1])) || Math.hypot(v[0], v[1]) === 0
    if (flat(p.stepMm) || ((p.count2 ?? 1) > 1 && flat(p.step2Mm))) return 'Give the spacing between copies, more than 0 mm.'
  }
  if (p.kind === 'circular') {
    if (!p.center.every(Number.isFinite)) return 'Give the center of the circle.'
    if (p.angleDeg !== undefined && !(Number.isFinite(p.angleDeg) && Math.abs(p.angleDeg) <= 360 && p.angleDeg !== 0)) return 'The sweep is more than 0 and at most 360 degrees.'
  }
  return null
}

/** The panel's pattern fields, as text the person typed (named values work). */
export type PatternFields =
  | { kind: 'none' }
  | { kind: 'line'; count: string; step: string; angle: string }
  | { kind: 'grid'; count: string; step: string; count2: string; step2: string }
  | { kind: 'circle'; count: string; centerX: string; centerY: string; sweep: string }
  // A pattern at points has no fields: it is kept as it is until another mode is picked.
  | { kind: 'points'; pattern: Extract<Pattern, { kind: 'points' }> }

export function patternFromFields(f: PatternFields): Pattern | null {
  switch (f.kind) {
    case 'none':
      return null
    case 'line': {
      const a = (num(f.angle || '0') * Math.PI) / 180
      const d = num(f.step)
      const r = (v: number) => Math.round(v * 1e9) / 1e9
      return { kind: 'linear', count: num(f.count), stepMm: [r(d * Math.cos(a)), r(d * Math.sin(a))] }
    }
    case 'grid':
      return { kind: 'linear', count: num(f.count), stepMm: [num(f.step), 0], count2: num(f.count2), step2Mm: [0, num(f.step2)] }
    case 'circle':
      return { kind: 'circular', count: num(f.count), center: [num(f.centerX), num(f.centerY)], angleDeg: num(f.sweep) }
    case 'points':
      return f.pattern
  }
}
