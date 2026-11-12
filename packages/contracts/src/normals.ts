// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact corner normals as meshes carry them outside the geometry engine (MeshPart.normals): one normal per triangle
// corner, in index order, each packed into two 16-bit numbers, so six per triangle. This is the one pack and unpack;
// the engine's own copy is in Rust, and fixtures/mesh-normal-pack.json holds the vectors both are tested against.
//
// The octahedral map: the normal is scaled so that |x| + |y| + |z| is 1, which puts it on an octahedron, and the
// octahedron is unfolded onto the square from -1 to 1. The upper half (z >= 0) maps to (x, y) as it is. The lower half
// folds outward: (x, y) becomes ((1 - |y|) * sign(x), (1 - |x|) * sign(y)), with sign(0) taken as 1. Each of the two
// is stored as floor(v * 32767 + 0.5), so both lie in -32767..32767. The pair (-32768, -32768) is no normal. A
// triangle counts as exact only when all three of its corners hold a normal.

/** The value both numbers of a corner hold when it has no exact normal. */
export const NO_NORMAL = -32768

function sign(v: number): number {
  return v < 0 ? -1 : 1
}

function stored(v: number): number {
  return Math.min(32767, Math.max(-32767, Math.floor(v * 32767 + 0.5)))
}

/**
 * Packs the normal (x, y, z) into `out[at]` and `out[at + 1]`. It need not be unit length; the zero vector, or one
 * that is not a number, packs as no normal.
 */
export function packNormal(x: number, y: number, z: number, out: Int16Array, at: number): void {
  const l = Math.abs(x) + Math.abs(y) + Math.abs(z)
  if (!(Number.isFinite(l) && l > 0)) {
    out[at] = NO_NORMAL
    out[at + 1] = NO_NORMAL
    return
  }
  const px = x / l
  const py = y / l
  if (z >= 0) {
    out[at] = stored(px)
    out[at + 1] = stored(py)
  } else {
    out[at] = stored((1 - Math.abs(py)) * sign(px))
    out[at + 1] = stored((1 - Math.abs(px)) * sign(py))
  }
}

/**
 * Unpacks the pair at `packed[at]` into the unit normal `out[to..to + 3]`. Returns false, and writes the zero vector,
 * when the pair is no normal.
 */
export function unpackNormal(packed: ArrayLike<number>, at: number, out: { [i: number]: number }, to: number): boolean {
  const a = packed[at] ?? NO_NORMAL
  const b = packed[at + 1] ?? NO_NORMAL
  if (a === NO_NORMAL && b === NO_NORMAL) {
    out[to] = 0
    out[to + 1] = 0
    out[to + 2] = 0
    return false
  }
  let x = a / 32767
  let y = b / 32767
  const z = 1 - Math.abs(x) - Math.abs(y)
  if (z < 0) {
    const fx = (1 - Math.abs(y)) * sign(x)
    y = (1 - Math.abs(x)) * sign(y)
    x = fx
  }
  const l = Math.sqrt(x * x + y * y + z * z)
  out[to] = x / l
  out[to + 1] = y / l
  out[to + 2] = z / l
  return true
}

/** Whether triangle `t` of a packed buffer has an exact normal at all three corners. */
export function exactTriangle(packed: ArrayLike<number>, t: number): boolean {
  for (let k = 6 * t; k < 6 * t + 6; k += 2) {
    if (k + 1 >= packed.length || (packed[k] === NO_NORMAL && packed[k + 1] === NO_NORMAL)) return false
  }
  return true
}

/** Packs corner normals given as three numbers each (nine per triangle) into six numbers per triangle. */
export function packNormals(corners: ArrayLike<number>): Int16Array {
  const n = Math.floor(corners.length / 3)
  const out = new Int16Array(2 * n)
  for (let i = 0; i < n; i++) packNormal(corners[3 * i] ?? 0, corners[3 * i + 1] ?? 0, corners[3 * i + 2] ?? 0, out, 2 * i)
  return out
}

/** Unpacks six numbers per triangle into unit corner normals, nine per triangle; a corner with no normal gets zeros. */
export function unpackNormals(packed: ArrayLike<number>): Float32Array {
  const n = Math.floor(packed.length / 2)
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) unpackNormal(packed, 2 * i, out, 3 * i)
  return out
}
