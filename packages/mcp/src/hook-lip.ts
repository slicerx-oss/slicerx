// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A hook reaching out from an upright stem, read from the part itself, whatever made it (a loft, a revolve, a sweep or
// an extrude): the stem, where the hook leaves it, and how far the hook's tip rises at the end of its reach, as a lip
// that keeps a headband or a strap from sliding off. design.check reads it for a plan with a hook and a lip, and the
// build evals score their stand's hook with the same reading.

/** Positions and triangles, in mm, as a mesh part or a design's baked part has them. */
export interface HookMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

export type V3 = [number, number, number]
type Ring = { z: number; c: [number, number]; r: number }

/** How far a lip rises above the hook's lowest point toward its end, at least, mm. */
export const LIP_RISE_MM = 3

/** Sectors around the stem's axis that a ring of its side must reach, so a hook reaching out one side is not read as stem. */
const SECTORS = 12
/** Height of each ring read off the stem, mm: more than the spacing of surfacePoints along a long side (up to 60 a side). */
const RING_MM = 5

/** The largest and smallest of `of` over `xs`, without spreading a large array into arguments. */
export const most = <T,>(xs: readonly T[], of: (x: T) => number): number => xs.reduce((m, x) => Math.max(m, of(x)), -Infinity)
export const least = <T,>(xs: readonly T[], of: (x: T) => number): number => xs.reduce((m, x) => Math.min(m, of(x)), Infinity)

/** Points over every triangle of the meshes, about 1.5 mm apart, so a long straight side is read along its length too. */
export function surfacePoints(meshes: readonly HookMesh[]): V3[] {
  const out: V3[] = []
  for (const p of meshes) {
    const at = (i: number): V3 => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!]
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const [a, b, c] = [at(p.indices[t]!), at(p.indices[t + 1]!), at(p.indices[t + 2]!)]
      const edge = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]))
      const n = Math.min(60, Math.max(1, Math.ceil(edge / 1.5)))
      for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) out.push([0, 1, 2].map((k) => a[k]! + ((b[k]! - a[k]!) * i) / n + ((c[k]! - a[k]!) * j) / n) as V3)
    }
  }
  return out
}

/**
 * The stem: rings of its outer side at each height around a vertical axis through the middle of the part halfway up.
 * A ring's radius is the median of its farthest points in each sector, so a hook or arm on one side does not widen it;
 * the stem is the run of round rings that go all the way round and are no wider than half again its width halfway up,
 * which leaves out a wide base under it and whatever stands on its top. `hollow` when its side has a bore inside it
 * halfway up. Null when there is no such column.
 */
function stemOf(pts: readonly V3[]): { rings: Ring[]; hollow: boolean } | null {
  const z0 = least(pts, (q) => q[2])
  const z1 = most(pts, (q) => q[2])
  const h = z1 - z0
  if (h < 20) return null
  const mid = pts.filter((q) => q[2] > z0 + 0.4 * h && q[2] < z0 + 0.6 * h)
  if (!mid.length) return null
  const c: [number, number] = [(least(mid, (q) => q[0]) + most(mid, (q) => q[0])) / 2, (least(mid, (q) => q[1]) + most(mid, (q) => q[1])) / 2]
  const d = (q: V3) => Math.hypot(q[0] - c[0], q[1] - c[1])
  const sector = (q: V3) => Math.min(SECTORS - 1, Math.floor(((Math.atan2(q[1] - c[1], q[0] - c[0]) + Math.PI) / (2 * Math.PI)) * SECTORS))
  // each ring: the median of the farthest point in each sector, or null when a sector has none
  const bins = Math.ceil(h / RING_MM)
  const far: number[][] = Array.from({ length: bins }, () => new Array<number>(SECTORS).fill(-1))
  for (const q of pts) {
    const b = Math.min(bins - 1, Math.floor((q[2] - z0) / RING_MM))
    const k = sector(q)
    far[b]![k] = Math.max(far[b]![k]!, d(q))
  }
  // a ring is round: its lower and upper quartile sectors agree, so an arm out one side does not spoil it, while a
  // part across the axis (an arm laid over the stem's top) is not read as stem
  const radius = far.map((f) => {
    if (f.some((r) => r < 0)) return null
    const o = [...f].sort((a, b) => a - b)
    return o[(3 * SECTORS) / 4 - 1]! <= o[SECTORS / 4 - 1]! * 1.25 ? o[SECTORS / 2]! : null
  })
  const half = Math.floor(bins / 2)
  const width = radius[half]
  if (width == null) return null
  const isStem = (r: number | null) => r !== null && r <= width * 1.5
  let lo = half
  let hi = half
  while (lo > 0 && isStem(radius[lo - 1]!)) lo--
  while (hi < bins - 1 && isStem(radius[hi + 1]!)) hi++
  // the end rings are cut through by the base's top and the stem's own top: read the rings inside them
  const rings: Ring[] = []
  for (let b = Math.min(lo + 1, hi); b <= Math.max(hi - 1, lo); b++) rings.push({ z: z0 + (b + 0.5) * RING_MM, c, r: radius[b]! })
  if (rings.length < 2) return null
  // a bore: points of the side well inside the stem's outer radius, all the way round, halfway up
  const ring = pts.filter((q) => Math.floor((q[2] - z0) / RING_MM) === half)
  const inner = new Set(ring.filter((q) => d(q) < width - 1 && d(q) > 0.5).map(sector))
  return { rings, hollow: inner.size === SECTORS }
}

/** A hook on an upright stem, as read from the part. */
export type HookReading =
  | { found: 'no stem' }
  | { found: 'no hook'; stem: StemShape }
  | { found: 'hook'; stem: StemShape; side: boolean; riseMm: number }

/** The stem's outer width across at its lowest and highest rings read, mm, and whether it has a bore. */
export interface StemShape {
  bottomMm: number
  topMm: number
  hollow: boolean
}

/**
 * The hook on the part's upright stem: whether it leaves the stem's side below its top (`side`), and how far the top of
 * its tip, at the very end of its reach, rises above the lowest top of the hook's outer half (`riseMm`, unrounded; a
 * lip rises LIP_RISE_MM or more). Takes the surface points of the part (surfacePoints), so a caller that reads them for more
 * than the hook reads them once.
 */
export function hookOn(pts: readonly V3[]): HookReading {
  const stem = stemOf(pts)
  if (!stem) return { found: 'no stem' }
  const rings = stem.rings
  const bottom = rings[0]!
  const top = rings.at(-1)!
  const shape: StemShape = { bottomMm: Math.round(2 * bottom.r), topMm: Math.round(2 * top.r), hollow: stem.hollow }
  // the stem's outer radius at a height, between its profiles and held at the ends
  const radius = (z: number): number => {
    if (z <= bottom.z) return bottom.r
    for (let k = 1; k < rings.length; k++) if (z <= rings[k]!.z) return rings[k - 1]!.r + ((rings[k]!.r - rings[k - 1]!.r) * (z - rings[k - 1]!.z)) / (rings[k]!.z - rings[k - 1]!.z)
    return top.r
  }
  const d = (q: V3) => Math.hypot(q[0] - top.c[0], q[1] - top.c[1])
  const hook = pts.filter((q) => q[2] > bottom.z + 5 && d(q) > radius(q[2]) + 1.5)
  if (!hook.length) return { found: 'no hook', stem: shape }
  const side = hook.some((q) => q[2] < top.z - 3 && d(q) < radius(q[2]) + 6)
  // the top of the hook along its reach, in the outer half: a lip is a tip that rises again past the lowest top there
  const near = least(hook, d)
  const far = most(hook, d)
  const tops = new Map<number, number>()
  for (const q of hook) {
    const r = d(q)
    if (r < (near + far) / 2) continue
    const bin = Math.floor(r / 2)
    tops.set(bin, Math.max(tops.get(bin) ?? -Infinity, q[2]))
  }
  // the top at the very end of the reach against the lowest top on the way out to it
  const tip = tops.get(Math.floor(far / 2)) ?? -Infinity
  const rise = tip - Math.min(...tops.values())
  return { found: 'hook', stem: shape, side, riseMm: rise }
}
