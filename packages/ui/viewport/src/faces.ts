// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Flat face patches for the lay-on-face tool: the coplanar triangles around a
// picked triangle, their normal and area, and the rotation that puts a face on
// the bed. Pure math, no three.js, so it runs anywhere and is unit tested.

export interface FacePatch {
  /** Triangle indexes (into the index buffer, three vertices each), seed first. */
  triangles: number[]
  /** Unit normal in the mesh's own frame, outward. */
  normal: [number, number, number]
  areaMm2: number
}

const adjacencyCache = new WeakMap<object, Int32Array>()

/**
 * Triangle neighbors for a mesh whose vertices may be duplicated (STL style): positions are welded at
 * 1 micrometer first, so triangles that share an edge in space are neighbors. Cached per index buffer.
 */
export function adjacencyOf(positions: ArrayLike<number>, indices: ArrayLike<number>): Int32Array {
  let adj = adjacencyCache.get(indices as object)
  if (adj) return adj
  const ids = new Map<string, number>()
  const welded = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const v = 3 * (indices[i] ?? 0)
    const key = `${Math.round((positions[v] ?? 0) * 1000)},${Math.round((positions[v + 1] ?? 0) * 1000)},${Math.round((positions[v + 2] ?? 0) * 1000)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    welded[i] = id
  }
  adj = triangleAdjacency(welded)
  adjacencyCache.set(indices as object, adj)
  return adj
}

/** For each triangle, its three edge neighbors (-1 for none). Non-manifold edges keep the first pair. */
export function triangleAdjacency(indices: ArrayLike<number>): Int32Array {
  const n = Math.floor(indices.length / 3)
  const out = new Int32Array(n * 3).fill(-1)
  const N = 2 ** 26
  const seen = new Map<number, number>()
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[3 * t + e] ?? 0
      const b = indices[3 * t + ((e + 1) % 3)] ?? 0
      const key = Math.min(a, b) * N + Math.max(a, b)
      const other = seen.get(key)
      if (other === undefined) seen.set(key, t * 3 + e)
      else {
        const ot = Math.floor(other / 3)
        if (out[other] === -1 && out[3 * t + e] === -1) {
          out[other] = t
          out[3 * t + e] = ot
        }
      }
    }
  }
  return out
}

function triNormal(p: ArrayLike<number>, i: ArrayLike<number>, t: number): [number, number, number, number] {
  const a = 3 * (i[3 * t] ?? 0), b = 3 * (i[3 * t + 1] ?? 0), c = 3 * (i[3 * t + 2] ?? 0)
  const ux = (p[b] ?? 0) - (p[a] ?? 0), uy = (p[b + 1] ?? 0) - (p[a + 1] ?? 0), uz = (p[b + 2] ?? 0) - (p[a + 2] ?? 0)
  const vx = (p[c] ?? 0) - (p[a] ?? 0), vy = (p[c + 1] ?? 0) - (p[a + 1] ?? 0), vz = (p[c + 2] ?? 0) - (p[a + 2] ?? 0)
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  return len > 0 ? [nx / len, ny / len, nz / len, len / 2] : [0, 0, 0, 0]
}

/**
 * The connected triangles around `seed` whose normals stay within `flatDeg` of
 * the seed's normal. Comparing to the seed, not the neighbor, keeps a gentle
 * curve from leaking into one big patch. `maxTriangles` bounds the work.
 */
export function facePatch(positions: ArrayLike<number>, indices: ArrayLike<number>, seed: number, flatDeg = 1, maxTriangles = 200000): FacePatch | null {
  const n = Math.floor(indices.length / 3)
  if (seed < 0 || seed >= n) return null
  const s = triNormal(positions, indices, seed)
  if (s[3] === 0) return null
  const adj = adjacencyOf(positions, indices)
  const cos = Math.cos((flatDeg * Math.PI) / 180)
  const seen = new Set<number>([seed])
  const queue = [seed]
  const tris: number[] = []
  let ax = 0, ay = 0, az = 0, area = 0
  while (queue.length && tris.length < maxTriangles) {
    const t = queue.pop() as number
    const q = triNormal(positions, indices, t)
    if (q[0] * s[0] + q[1] * s[1] + q[2] * s[2] < cos) continue
    tris.push(t)
    ax += q[0] * q[3]; ay += q[1] * q[3]; az += q[2] * q[3]
    area += q[3]
    for (let e = 0; e < 3; e++) {
      const o = adj[3 * t + e] ?? -1
      if (o >= 0 && !seen.has(o)) {
        seen.add(o)
        queue.push(o)
      }
    }
  }
  const l = Math.hypot(ax, ay, az) || 1
  return { triangles: tris, normal: [ax / l, ay / l, az / l], areaMm2: area }
}

/** Unit vector for a direction, or null when it is zero length. */
function unit(v: [number, number, number]): [number, number, number] | null {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : null
}

/** Column-major 4x4 rotation about `center` that takes `from` to `to` by the shortest turn. */
export function rotationBetween(from: [number, number, number], to: [number, number, number], center: [number, number, number] = [0, 0, 0]): number[] {
  const a = unit(from)
  const b = unit(to)
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  if (!a || !b) return I
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  let ax: [number, number, number] = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  if (dot > 1 - 1e-9) return I
  if (dot < -1 + 1e-9) {
    // Opposite: turn half a circle about any axis perpendicular to `from`.
    ax = Math.abs(a[0]) < 0.9 ? [0, a[2], -a[1]] : [-a[2], 0, a[0]]
  }
  const k = unit(ax) as [number, number, number]
  const c = dot
  const s = Math.sqrt(Math.max(0, 1 - dot * dot))
  const t = 1 - c
  const [x, y, z] = k
  const r = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ] as const
  const [cx, cy, cz] = center
  // Column-major: columns are r[0..2], r[3..5], r[6..8]; translation keeps `center` fixed.
  return [
    r[0], r[1], r[2], 0,
    r[3], r[4], r[5], 0,
    r[6], r[7], r[8], 0,
    cx - (r[0] * cx + r[3] * cy + r[6] * cz), cy - (r[1] * cx + r[4] * cy + r[7] * cz), cz - (r[2] * cx + r[5] * cy + r[8] * cz), 1,
  ]
}

function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] = (o[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0)
  return o
}

/**
 * New object transform (column-major, bed frame, Z up) that lays a face on the
 * bed: rotates about `centerBed` so the outward `normalBed` points straight
 * down (-Z). The height is not touched; drop the object onto the bed after.
 */
export function layOnFaceTransform(transform: number[], normalBed: [number, number, number], centerBed: [number, number, number]): number[] {
  return mul(rotationBetween(normalBed, [0, 0, -1], centerBed), transform)
}
