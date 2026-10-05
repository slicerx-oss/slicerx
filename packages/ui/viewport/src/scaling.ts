// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Scale gizmo math: how a handle drag becomes a scale factor and how a factor
// changes an object transform. Pure, so it is unit tested.

export type V3 = [number, number, number]

/** Factor limits of one drag, relative to the size when the drag began. */
export const MIN_SCALE = 0.01
export const MAX_SCALE = 50
/** Snap step while Shift is held: 5 percent, as in OrcaSlicer. */
export const SNAP_STEP = 0.05

function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] = (o[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0)
  return o
}

/**
 * Object transform after scaling its own axes by `factors` about `anchorLocal` (a point in the
 * object's frame that stays where it is). `m` and the result are column-major 4x4.
 */
export function scaleTransform(m: number[], factors: V3, anchorLocal: V3): number[] {
  const [sx, sy, sz] = factors
  const [ax, ay, az] = anchorLocal
  const s = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, ax * (1 - sx), ay * (1 - sy), az * (1 - sz), 1]
  return mul(m, s)
}

/** Parameter t of the point on the line P + t d nearest the ray O + s r (d and r need not be unit). Null when they are parallel. */
export function nearestOnLine(rayO: V3, rayD: V3, lineP: V3, lineD: V3): number | null {
  const w: V3 = [lineP[0] - rayO[0], lineP[1] - rayO[1], lineP[2] - rayO[2]]
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const a = dot(lineD, lineD)
  const b = dot(lineD, rayD)
  const c = dot(rayD, rayD)
  const d = dot(lineD, w)
  const e = dot(rayD, w)
  const den = a * c - b * b
  if (Math.abs(den) < 1e-9 * a * c) return null
  return (b * e - c * d) / den
}

/** Scale factor of a drag: where the cursor projects now over where it projected at the start, both measured from the anchor. */
export function dragFactor(tNow: number, tStart: number): number {
  if (Math.abs(tStart) < 1e-6) return 1
  return clampScale(tNow / tStart)
}

export function clampScale(f: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, f))
}

/** Rounds a factor to the nearest step, never below one step. */
export function snapScale(f: number, step = SNAP_STEP): number {
  return Math.max(step, Math.round(f / step) * step)
}

export type HandleId = 'xn' | 'xp' | 'yn' | 'yp' | 'zn' | 'zp' | 'cnn' | 'cpn' | 'cpp' | 'cnp'
export type ScaleLayout = 'bottom' | 'faces'

/**
 * Handle ids of a layout. `bottom` (Orca, Bambu Studio): x and y handles at the middle of the bottom edges, one z handle
 * on top, four uniform handles at the bottom corners. `faces` (PrusaSlicer): all six face centers and four corners at
 * the middle height. `n` and `p` are the negative and positive side.
 */
export function handleIds(layout: ScaleLayout): readonly HandleId[] {
  return layout === 'faces' ? ['xn', 'xp', 'yn', 'yp', 'zn', 'zp', 'cnn', 'cpn', 'cpp', 'cnp'] : ['xn', 'xp', 'yn', 'yp', 'zp', 'cnn', 'cpn', 'cpp', 'cnp']
}

export function handleAxis(id: HandleId): 'x' | 'y' | 'z' | 'uniform' {
  return id[0] === 'c' ? 'uniform' : (id[0] as 'x' | 'y' | 'z')
}

/** Position of a handle on the box `min..max`, in the box's own frame. */
export function handleLocal(id: HandleId, min: V3, max: V3, layout: ScaleLayout = 'bottom'): V3 {
  const cx = (min[0] + max[0]) / 2
  const cy = (min[1] + max[1]) / 2
  const cz = (min[2] + max[2]) / 2
  const low = layout === 'faces' ? cz : min[2]
  switch (id) {
    case 'xn': return [min[0], cy, low]
    case 'xp': return [max[0], cy, low]
    case 'yn': return [cx, min[1], low]
    case 'yp': return [cx, max[1], low]
    case 'zn': return [cx, cy, min[2]]
    case 'zp': return [cx, cy, max[2]]
    case 'cnn': return [min[0], min[1], low]
    case 'cpn': return [max[0], min[1], low]
    case 'cpp': return [max[0], max[1], low]
    default: return [min[0], max[1], low]
  }
}

const OPPOSITE: Record<HandleId, HandleId | null> = { xn: 'xp', xp: 'xn', yn: 'yp', yp: 'yn', zn: 'zp', zp: null, cnn: 'cpp', cpn: 'cnp', cpp: 'cnn', cnp: 'cpn' }

/** The handle that a pinned drag keeps fixed. The z handle of the `bottom` layout pins the bottom center instead. */
export function oppositeHandle(id: HandleId, layout: ScaleLayout): HandleId | null {
  return id === 'zp' && layout === 'faces' ? 'zn' : OPPOSITE[id]
}

export interface ScaleOrigin {
  layout: ScaleLayout
  pivot: 'bottom-center' | 'center'
  cornerPinLocksZ: boolean
}

function basePivot(min: V3, max: V3, pivot: 'bottom-center' | 'center'): V3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, pivot === 'center' ? (min[2] + max[2]) / 2 : min[2]]
}

/**
 * The point a drag keeps fixed. Unpinned it is the layout's pivot. Pinned, an axis handle keeps the opposite handle where it
 * is, and (when `cornerPinLocksZ`) a corner keeps the opposite corner in x and y.
 */
export function pivotFor(id: HandleId, min: V3, max: V3, o: ScaleOrigin, pinned: boolean): V3 {
  const base = basePivot(min, max, o.pivot)
  if (!pinned) return base
  const axis = handleAxis(id)
  if (axis === 'uniform') {
    if (!o.cornerPinLocksZ) return base
    const opp = oppositeHandle(id, o.layout)
    const p = opp ? handleLocal(opp, min, max, o.layout) : base
    return [p[0], p[1], base[2]]
  }
  const opp = oppositeHandle(id, o.layout)
  if (!opp || (id === 'zp' && o.layout === 'bottom')) return base
  return handleLocal(opp, min, max, o.layout)
}

/** The pivot a drag's ratio is measured from: only a pinned axis handle moves it off the layout's pivot. */
export function ratioPivotFor(id: HandleId, min: V3, max: V3, o: ScaleOrigin, pinned: boolean): V3 {
  return handleAxis(id) === 'uniform' ? basePivot(min, max, o.pivot) : pivotFor(id, min, max, o, pinned)
}

/** Per-axis factors: one axis for an axis handle, all three for a corner (x and y only for a pinned corner that locks z). */
export function factorsFor(id: HandleId, f: number, pinnedCornerLocksZ: boolean): V3 {
  switch (handleAxis(id)) {
    case 'x': return [f, 1, 1]
    case 'y': return [1, f, 1]
    case 'z': return [1, 1, f]
    default: return [f, f, pinnedCornerLocksZ ? 1 : f]
  }
}

/** The factor below which a drag would leave less than `minSizeMm` (PrusaSlicer keeps at least 1 mm). `sizesMm` are the box sizes in world mm. */
export function minFactorFor(id: HandleId, sizesMm: V3, minSizeMm: number | null): number {
  if (minSizeMm === null) return 0
  const axis = handleAxis(id)
  const size = axis === 'x' ? sizesMm[0] : axis === 'y' ? sizesMm[1] : axis === 'z' ? sizesMm[2] : Math.min(...sizesMm)
  return size > 0 ? minSizeMm / size : 0
}

// ---- how the pointer becomes a ratio, one function per source ----

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** PrusaSlicer: where the handle line meets the pointer, measured from the start of the drag: (len + (t - tStart)) / len. */
export function ratioLine(tNow: number, tStart: number, len: number): number {
  return len > 0 ? (len + (tNow - tStart)) / len : 1
}

/** Bambu Studio: the point of the ray nearest the handle's start position, projected on the pivot to handle direction. */
export function ratioPoint(rayO: V3, rayD: V3, drag: V3, pivot: V3): number {
  const start = sub3(drag, pivot)
  const len = Math.hypot(...start)
  if (len === 0) return 1
  const d = norm3(rayD)
  const k = dot3(sub3(drag, rayO), d) / dot3(d, d)
  const near: V3 = [rayO[0] + k * d[0], rayO[1] + k * d[1], rayO[2] + k * d[2]]
  return (len + dot3(sub3(near, drag), norm3(start))) / len
}

/**
 * Orca: the ray meets the plane through the handle's start position whose normal is the box's up axis (for the z handle, a
 * plane containing that axis and facing the ray), and the offset is projected on the pivot to handle direction. A ray
 * nearly parallel to the plane (85 to 95 degrees) leaves the ratio at 1.
 */
export function ratioPlane(rayO: V3, rayD: V3, drag: V3, pivot: V3, up: V3, isZHandle: boolean): number {
  const start = sub3(drag, pivot)
  const len = Math.hypot(...start)
  if (len === 0) return 1
  const d = norm3(rayD)
  let n = norm3(up)
  if (isZHandle) {
    const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    n = norm3(cross(cross(d, n), n))
  }
  const angle = (Math.acos(Math.max(-1, Math.min(1, dot3(n, d)))) * 180) / Math.PI
  if (angle > 85 && angle < 95) return 1
  const denom = dot3(n, d)
  if (Math.abs(denom) < 1e-12) return 1
  const t = dot3(n, sub3(drag, rayO)) / denom
  const hit: V3 = [rayO[0] + t * d[0], rayO[1] + t * d[1], rayO[2] + t * d[2]]
  return (len + dot3(sub3(hit, drag), norm3(start))) / len
}
