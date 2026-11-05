// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exploded view: how far each part of an object moves out from the others, for display only. The view, the app link and
// the picture tools share this one function, so a client sees the same spread a person does. Nothing here touches the
// object's transform, the slice or the saved project.

/** The way parts move apart: out from the middle of the object, or along one bed axis. */
export type ExplodeAxis = 'radial' | 'x' | 'y' | 'z'

export const EXPLODE_AXES: readonly ExplodeAxis[] = ['radial', 'x', 'y', 'z']

/** A part's box in bed coordinates, mm (Z up). */
export interface PartBox {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}

export type Vec3 = [number, number, number]

/** Air left between neighbors along an axis at full spread, as a share of the largest part's length on that axis. */
const AXIS_AIR = 0.25

/** Spread as given (0 to 100 percent), clamped; anything that is not a number is 0. */
export function clampSpread(spread: number): number {
  if (!Number.isFinite(spread)) return 0
  return Math.min(100, Math.max(0, spread))
}

/**
 * The offset of each part, mm in bed coordinates, at `spread` percent (0 to 100) along `axis`. Fewer than 2 parts, or
 * a spread of 0, leaves every part where it is.
 *
 * - radial: each part moves away from the middle of the whole object, by its distance from it plus the object's half
 *   diagonal at 100 percent. A part centered on the middle stays. If that would take a part below the object's lowest
 *   point, everything is lifted by the same amount, so nothing sinks into the bed.
 * - x and y: parts keep their order along the axis and spread out from the middle one, a step of the largest part's
 *   length on that axis plus a quarter between neighbors at 100 percent, so no two overlap on that axis.
 * - z: the lowest part stays and each part above it rises by the same step, so nothing goes below the bed.
 */
export function explodeOffsets(parts: readonly PartBox[], spread: number, axis: ExplodeAxis): Vec3[] {
  const s = clampSpread(spread) / 100
  const zero = (): Vec3 => [0, 0, 0]
  if (parts.length < 2 || s === 0) return parts.map(zero)
  const centers = parts.map((p): Vec3 => [(p.min[0] + p.max[0]) / 2, (p.min[1] + p.max[1]) / 2, (p.min[2] + p.max[2]) / 2])
  if (axis === 'radial') {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const p of parts)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, p.min[k]!)
        hi[k] = Math.max(hi[k]!, p.max[k]!)
      }
    const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    const half = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2
    const out = centers.map((c): Vec3 => {
      const d: Vec3 = [c[0] - mid[0], c[1] - mid[1], c[2] - mid[2]]
      const len = Math.hypot(d[0], d[1], d[2])
      if (len <= half * 1e-6) return zero()
      const k = s * (1 + half / len)
      return [d[0] * k, d[1] * k, d[2] * k]
    })
    const lowest = Math.min(...parts.map((p, i) => p.min[2] + out[i]![2]))
    const lift = lowest < lo[2] ? lo[2] - lowest : 0
    if (lift > 0) for (const o of out) o[2] += lift
    return out
  }
  const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2
  const order = parts.map((_, i) => i).sort((a, b) => centers[a]![k]! - centers[b]![k]! || a - b)
  const rank = new Array<number>(parts.length)
  order.forEach((part, r) => (rank[part] = r))
  const longest = Math.max(...parts.map((p) => p.max[k]! - p.min[k]!))
  const step = s * longest * (1 + AXIS_AIR)
  const from = axis === 'z' ? 0 : (parts.length - 1) / 2
  return parts.map((_, i) => {
    const o = zero()
    o[k] = step * (rank[i]! - from)
    // -0 reads as 0 to a client
    if (o[k] === 0) o[k] = 0
    return o
  })
}
