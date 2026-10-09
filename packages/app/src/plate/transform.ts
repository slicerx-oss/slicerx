// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Object transforms on the plate: 4x4 column-major matrices in mm, Z up, origin at the bed's front
// left corner (the Plate contract). Pure functions, so every edit is unit tested. Rotation is kept
// as XYZ Euler angles in degrees for the numeric fields, the way Bambu Studio and OrcaSlicer show it.
import type { Bed, MeshPart } from '@slicerx/contracts'

export type Mat4 = number[]
export type Vec3 = [number, number, number]

export interface Trs {
  /** Translation, mm. */
  position: Vec3
  /** Euler angles in degrees, applied X, then Y, then Z. */
  rotation: Vec3
  /** Scale factors, 1 = 100 %. */
  scale: Vec3
}

const RAD = Math.PI / 180

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0
    for (let k = 0; k < 4; k++) v += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0)
    out[c * 4 + r] = v
  }
  return out
}

/** Rotation matrix R = Rz * Ry * Rx for XYZ Euler angles in degrees, as a 3x3 row-major array. */
function rotation3(rot: Vec3): number[] {
  const [x, y, z] = rot.map((d) => d * RAD) as Vec3
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ]
}

export function compose(t: Trs): Mat4 {
  const r = rotation3(t.rotation)
  const [sx, sy, sz] = t.scale
  const m = identity()
  for (let row = 0; row < 3; row++) {
    m[0 * 4 + row] = (r[row * 3 + 0] ?? 0) * sx
    m[1 * 4 + row] = (r[row * 3 + 1] ?? 0) * sy
    m[2 * 4 + row] = (r[row * 3 + 2] ?? 0) * sz
  }
  m[12] = t.position[0]
  m[13] = t.position[1]
  m[14] = t.position[2]
  return m
}

const clean = (v: number, digits = 6) => {
  const r = Number(v.toFixed(digits))
  return Object.is(r, -0) ? 0 : r
}

/** Splits a matrix without shear into position, XYZ Euler rotation in degrees and scale. A negative determinant (mirrored) puts the sign on X scale. */
export function decompose(m: Mat4): Trs {
  const col = (c: number): Vec3 => [m[c * 4] ?? 0, m[c * 4 + 1] ?? 0, m[c * 4 + 2] ?? 0]
  const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
  const c0 = col(0), c1 = col(1), c2 = col(2)
  let sx = len(c0)
  const sy = len(c1), sz = len(c2)
  const det = c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1])
  if (det < 0) sx = -sx
  // Row-major rotation entries r[row][col] from the normalized columns.
  const r = (row: number, c: number) => (c === 0 ? (c0[row] ?? 0) / sx : c === 1 ? (c1[row] ?? 0) / sy : (c2[row] ?? 0) / sz)
  const ry = Math.asin(Math.max(-1, Math.min(1, -r(2, 0))))
  let rx: number
  let rz: number
  if (Math.abs(Math.cos(ry)) > 1e-6) {
    rx = Math.atan2(r(2, 1), r(2, 2))
    rz = Math.atan2(r(1, 0), r(0, 0))
  } else {
    // Gimbal lock: fold Z into X.
    rx = Math.atan2(-r(1, 2), r(1, 1))
    rz = 0
  }
  return {
    position: [clean(m[12] ?? 0), clean(m[13] ?? 0), clean(m[14] ?? 0)],
    rotation: [clean(rx / RAD, 4), clean(ry / RAD, 4), clean(rz / RAD, 4)],
    scale: [clean(sx), clean(sy), clean(sz)],
  }
}

export function apply(m: Mat4, p: Vec3): Vec3 {
  return [
    (m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0),
    (m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0),
    (m[2] ?? 0) * p[0] + (m[6] ?? 0) * p[1] + (m[10] ?? 0) * p[2] + (m[14] ?? 0),
  ]
}

export interface Box {
  min: Vec3
  max: Vec3
}

/** World-space bounds of the parts under a transform. */
export function bounds(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4): Box | null {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  // The transform inline, with no array per vertex: this runs over every vertex of the plate on many changes.
  const [m0, m1, m2, , m4, m5, m6, , m8, m9, m10, , m12, m13, m14] = Array.from({ length: 16 }, (_, k) => m[k] ?? 0) as number[]
  let x0 = Infinity
  let y0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let z1 = -Infinity
  for (const part of parts) {
    const p = part.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      const a = p[i] ?? 0
      const b = p[i + 1] ?? 0
      const c = p[i + 2] ?? 0
      const x = m0! * a + m4! * b + m8! * c + m12!
      const y = m1! * a + m5! * b + m9! * c + m13!
      const z = m2! * a + m6! * b + m10! * c + m14!
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
  }
  min[0] = x0
  min[1] = y0
  min[2] = z0
  max[0] = x1
  max[1] = y1
  max[2] = z1
  return Number.isFinite(min[0]) ? { min, max } : null
}

export function sizeOf(b: Box): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
}

function translate(m: Mat4, d: Vec3): Mat4 {
  const out = [...m]
  out[12] = (out[12] ?? 0) + d[0]
  out[13] = (out[13] ?? 0) + d[1]
  out[14] = (out[14] ?? 0) + d[2]
  return out
}

/** Lowers or raises the object so its lowest point touches the bed. */
export function dropToBed(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4): Mat4 {
  const b = bounds(parts, m)
  return b ? translate(m, [0, 0, -b.min[2]]) : m
}

/** Moves the object so its bounds are centered on the bed in X and Y. */
export function centerOnBed(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4, bed: Bed): Mat4 {
  const b = bounds(parts, m)
  if (!b) return m
  return translate(m, [bed.widthMm / 2 - (b.min[0] + b.max[0]) / 2, bed.depthMm / 2 - (b.min[1] + b.max[1]) / 2, 0])
}

/** Replaces position, rotation or scale, keeping the rest. */
export function withTrs(m: Mat4, patch: Partial<Trs>): Mat4 {
  return compose({ ...decompose(m), ...patch })
}

/**
 * Scales to a target size in mm on one axis. With `uniform` the other axes follow by the same
 * factor. Scaling keeps the bounds' center in X and Y and the bottom on the bed.
 */
export function scaleToSize(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4, axis: 0 | 1 | 2, sizeMm: number, uniform: boolean): Mat4 {
  const b = bounds(parts, m)
  if (!b || !(sizeMm > 0)) return m
  const current = sizeOf(b)[axis]
  if (!(current > 0)) return m
  const f = sizeMm / current
  const t = decompose(m)
  const scale: Vec3 = uniform ? [t.scale[0] * f, t.scale[1] * f, t.scale[2] * f] : (t.scale.map((s, i) => (i === axis ? s * f : s)) as Vec3)
  return keepFootprint(parts, m, compose({ ...t, scale }))
}

/** Scales by factors (1 = 100 %), keeping the center in X and Y and the bottom on the bed. */
export function setScale(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4, scale: Vec3): Mat4 {
  return keepFootprint(parts, m, withTrs(m, { scale }))
}

function keepFootprint(parts: readonly Pick<MeshPart, 'positions'>[], before: Mat4, after: Mat4): Mat4 {
  const a = bounds(parts, before)
  const b = bounds(parts, after)
  if (!a || !b) return after
  return translate(after, [(a.min[0] + a.max[0]) / 2 - (b.min[0] + b.max[0]) / 2, (a.min[1] + a.max[1]) / 2 - (b.min[1] + b.max[1]) / 2, a.min[2] - b.min[2]])
}

/** Rotation matrix (4x4) that turns unit vector `from` onto unit vector `to`. */
function rotateOnto(from: Vec3, to: Vec3): Mat4 {
  const [ax, ay, az] = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]]
  const c = from[0] * to[0] + from[1] * to[1] + from[2] * to[2]
  const m = identity()
  if (c < -0.999999) {
    // Opposite: turn half a circle about any axis perpendicular to `from`.
    const p: Vec3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const ax2: Vec3 = [from[1] * p[2] - from[2] * p[1], from[2] * p[0] - from[0] * p[2], from[0] * p[1] - from[1] * p[0]]
    const l = Math.hypot(...ax2)
    const [x, y, z] = ax2.map((v) => v / l) as Vec3
    return [2 * x * x - 1, 2 * x * y, 2 * x * z, 0, 2 * x * y, 2 * y * y - 1, 2 * y * z, 0, 2 * x * z, 2 * y * z, 2 * z * z - 1, 0, 0, 0, 0, 1]
  }
  const k = 1 / (1 + c)
  m[0] = ax * ax * k + c
  m[1] = ay * ax * k + az
  m[2] = az * ax * k - ay
  m[4] = ax * ay * k - az
  m[5] = ay * ay * k + c
  m[6] = az * ay * k + ax
  m[8] = ax * az * k + ay
  m[9] = ay * az * k - ax
  m[10] = az * az * k + c
  return m
}

/**
 * Lay on face: turns the object about the center of its bounds so the picked face's outward normal
 * points straight down, then puts it on the bed. `normal` is in the bed frame, after the transform.
 */
export function layOnFace(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4, normal: Vec3, center: Vec3): Mat4 {
  const l = Math.hypot(...normal)
  if (!(l > 0)) return m
  const r = rotateOnto(normal.map((v) => v / l) as Vec3, [0, 0, -1])
  const toOrigin = translate(identity(), [-center[0], -center[1], -center[2]])
  const back = translate(identity(), center)
  return dropToBed(parts, multiply(back, multiply(r, multiply(toOrigin, m))))
}

/** Mirror along one axis in the bed frame, about the bounds' center; stays on the bed. */
export function mirror(parts: readonly Pick<MeshPart, 'positions'>[], m: Mat4, axis: 0 | 1 | 2): Mat4 {
  const b = bounds(parts, m)
  if (!b) return m
  const c = (b.min[axis] + b.max[axis]) / 2
  const f = identity()
  f[axis * 5] = -1
  f[12 + axis] = 2 * c
  return dropToBed(parts, multiply(f, m))
}

/** True when the bounds sit inside the bed volume, with a small tolerance. */
export function fitsBed(b: Box, bed: Bed, tol = 0.01): boolean {
  return b.min[0] >= -tol && b.min[1] >= -tol && b.min[2] >= -tol && b.max[0] <= bed.widthMm + tol && b.max[1] <= bed.depthMm + tol && b.max[2] <= bed.heightMm + tol
}
