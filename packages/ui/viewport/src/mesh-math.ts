// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mesh math behind a model's look, on plain typed arrays and with no three.js, so it runs the same on the page and in
// a worker (mesh-worker.ts): welding, creased normals, feature edges and the quick smooth normals.

/**
 * Spreads three quantized coordinates over a table index. The coordinates are whole numbers, so `| 0` keeps their low
 * bits (large ones wrap, which only costs a collision); equal coordinates always land on the same slot.
 */
function slotOf(x: number, y: number, z: number, mask: number): number {
  let h = Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ Math.imul(z | 0, 0xc2b2ae3d)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h & mask
}

/**
 * Welds positions on a grid of `1 / scale` mm: `map[i]` is the welded id of vertex i, ids counted in first-seen order.
 * An open-addressing table of vertex numbers (no string keys), so a mesh of millions of vertices welds in a few
 * megabytes of typed arrays instead of a map of millions of strings.
 */
export function weldVertices(pos: Float32Array, scale: number): { map: Int32Array; count: number } {
  const n = Math.floor(pos.length / 3)
  const map = new Int32Array(n)
  let cap = 16
  while (cap < n * 2) cap *= 2
  const mask = cap - 1
  const table = new Int32Array(cap).fill(-1)
  let count = 0
  for (let i = 0; i < n; i++) {
    const x = Math.round((pos[3 * i] ?? 0) * scale)
    const y = Math.round((pos[3 * i + 1] ?? 0) * scale)
    const z = Math.round((pos[3 * i + 2] ?? 0) * scale)
    let s = slotOf(x, y, z, mask)
    for (;;) {
      const r = table[s] ?? -1
      if (r < 0) {
        table[s] = i
        map[i] = count++
        break
      }
      if (Math.round((pos[3 * r] ?? 0) * scale) === x && Math.round((pos[3 * r + 1] ?? 0) * scale) === y && Math.round((pos[3 * r + 2] ?? 0) * scale) === z) {
        map[i] = map[r] ?? 0
        break
      }
      s = (s + 1) & mask
    }
  }
  return { map, count }
}

/** A Float32Array that grows by doubling; `done()` returns a copy trimmed to what was written. */
class Floats {
  a: Float32Array
  n = 0
  constructor(size: number) {
    this.a = new Float32Array(Math.max(16, size))
  }
  push3(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = x
    this.a[this.n++] = y
    this.a[this.n++] = z
  }
  done(): Float32Array {
    return this.n === this.a.length ? this.a : this.a.slice(0, this.n)
  }
}

/** Creased geometry as plain arrays: positions, normals and the index (creasedGeometry in model.ts makes the mesh). */
export interface CreasedArrays {
  position: Float32Array
  normal: Float32Array
  index: Uint32Array
}

/**
 * Indexed geometry whose normals average only faces within `creaseDeg` of each other. A corner shares its vertex with
 * the other corners of the same source vertex that got the same normal, so a smooth mesh keeps about one vertex per
 * source vertex and a hard edge splits where it should. Triangle t of the result is triangle t of the input.
 */
export function creasedArrays(P: Float32Array, I: ArrayLike<number>, creaseDeg: number): CreasedArrays {
  const nt = Math.floor(I.length / 3)
  const nv = Math.floor(P.length / 3)
  const fn = new Float32Array(nt * 3)
  const fu = new Float32Array(nt * 3)
  const at = (k: number): number => I[k] ?? 0
  const p = (k: number): number => P[k] ?? 0
  for (let t = 0; t < nt; t++) {
    const a = at(3 * t) * 3
    const b = at(3 * t + 1) * 3
    const c = at(3 * t + 2) * 3
    const ux = p(b) - p(a), uy = p(b + 1) - p(a + 1), uz = p(b + 2) - p(a + 2)
    const vx = p(c) - p(a), vy = p(c + 1) - p(a + 1), vz = p(c + 2) - p(a + 2)
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    fu[3 * t] = x; fu[3 * t + 1] = y; fu[3 * t + 2] = z
    fn[3 * t] = x / l; fn[3 * t + 1] = y / l; fn[3 * t + 2] = z / l
  }
  // Welded at 1 micrometer so normals see shared vertices even in unindexed files.
  const { map: wmap, count: nw } = weldVertices(P, 1000)
  const w = (k: number): number => wmap[at(k)] ?? 0
  const cnt = new Int32Array(nw + 1)
  for (let i = 0; i < nt * 3; i++) {
    const c = w(i) + 1
    cnt[c] = (cnt[c] ?? 0) + 1
  }
  for (let i = 0; i < nw; i++) cnt[i + 1] = (cnt[i + 1] ?? 0) + (cnt[i] ?? 0)
  const fill = cnt.slice(0, nw)
  const lst = new Int32Array(nt * 3)
  for (let i = 0; i < nt * 3; i++) {
    const c = w(i)
    const slot = fill[c] ?? 0
    lst[slot] = (i / 3) | 0
    fill[c] = slot + 1
  }
  const f = (k: number): number => fn[k] ?? 0
  const u = (k: number): number => fu[k] ?? 0
  const pos = new Floats(nv * 3 + 64)
  const nrm = new Floats(nv * 3 + 64)
  // The output vertices made for each source vertex, as a linked list: head per source vertex, next per output vertex.
  const head = new Int32Array(nv).fill(-1)
  let next = new Int32Array(Math.max(16, nv + 16))
  const index = new Uint32Array(nt * 3)
  const cosA = Math.cos((creaseDeg * Math.PI) / 180)
  for (let t = 0; t < nt; t++) {
    const tx = f(3 * t), ty = f(3 * t + 1), tz = f(3 * t + 2)
    for (let j = 0; j < 3; j++) {
      const vi = at(3 * t + j)
      const wi = w(3 * t + j)
      let x = 0, y = 0, z = 0
      const end = cnt[wi + 1] ?? 0
      for (let k = cnt[wi] ?? 0; k < end; k++) {
        const g = lst[k] ?? 0
        if (f(3 * g) * tx + f(3 * g + 1) * ty + f(3 * g + 2) * tz >= cosA) {
          x += u(3 * g); y += u(3 * g + 1); z += u(3 * g + 2)
        }
      }
      const l = Math.hypot(x, y, z) || 1
      // Stored as float32, so compare as float32.
      const nx = Math.fround(x / l), ny = Math.fround(y / l), nz = Math.fround(z / l)
      let o = head[vi] ?? -1
      while (o >= 0 && !(nrm.a[3 * o] === nx && nrm.a[3 * o + 1] === ny && nrm.a[3 * o + 2] === nz)) o = next[o] ?? -1
      if (o < 0) {
        o = pos.n / 3
        pos.push3(p(3 * vi), p(3 * vi + 1), p(3 * vi + 2))
        nrm.push3(nx, ny, nz)
        if (o >= next.length) {
          const b = new Int32Array(next.length * 2)
          b.set(next)
          next = b
        }
        next[o] = head[vi] ?? -1
        head[vi] = o
      }
      index[3 * t + j] = o
    }
  }
  return { position: pos.done(), normal: nrm.done(), index }
}

/**
 * The feature edges of a mesh: every edge whose two faces meet at more than `thresholdDeg`, and every edge with no
 * matching opposite edge (open borders). The same edges as three's EdgesGeometry, which keys each edge by a string
 * and runs to gigabytes of strings on a mesh of millions of triangles; here vertices weld to integer ids and the edges
 * of each lowest vertex are paired in a small list.
 */
export function featureEdges(P: Float32Array, I: ArrayLike<number> | null, thresholdDeg: number): Float32Array {
  const nt = Math.floor((I ? I.length : P.length / 3) / 3)
  const vtx = (k: number): number => (I ? (I[k] ?? 0) : k)
  // EdgesGeometry's precision: four decimals.
  const { map: wmap, count: nw } = weldVertices(P, 1e4)
  const wid = (k: number): number => wmap[vtx(k)] ?? 0
  const thresholdDot = Math.cos((Math.PI / 180) * thresholdDeg)
  // Directed edges a -> b of the triangles that are not degenerate, bucketed by the lower welded id.
  const cnt = new Int32Array(nw + 1)
  for (let t = 0; t < nt; t++) {
    const a = wid(3 * t), b = wid(3 * t + 1), c = wid(3 * t + 2)
    if (a === b || b === c || c === a) continue
    cnt[Math.min(a, b) + 1]!++
    cnt[Math.min(b, c) + 1]!++
    cnt[Math.min(c, a) + 1]!++
  }
  for (let i = 0; i < nw; i++) cnt[i + 1] = (cnt[i + 1] ?? 0) + (cnt[i] ?? 0)
  const total = cnt[nw] ?? 0
  const fill = cnt.slice(0, nw)
  // Per edge: its corner (3 * triangle + j, from corner j to corner j + 1) and the higher end's welded id, as -id - 1
  // when the edge runs from the higher end down. The opposite edge's key is then always -key - 1.
  const corner = new Int32Array(total)
  const other = new Int32Array(total)
  for (let t = 0; t < nt; t++) {
    const ids = [wid(3 * t), wid(3 * t + 1), wid(3 * t + 2)] as const
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[2] === ids[0]) continue
    for (let j = 0; j < 3; j++) {
      const a = ids[j]!
      const b = ids[(j + 1) % 3]!
      const lo = Math.min(a, b)
      const slot = fill[lo]!++
      corner[slot] = 3 * t + j
      other[slot] = a < b ? b : -a - 1
    }
  }
  const normal = (t: number, out: number[]): void => {
    const a = vtx(3 * t) * 3, b = vtx(3 * t + 1) * 3, c = vtx(3 * t + 2) * 3
    // Triangle.getNormal: (c - b) x (a - b), normalized.
    const ux = (P[c] ?? 0) - (P[b] ?? 0), uy = (P[c + 1] ?? 0) - (P[b + 1] ?? 0), uz = (P[c + 2] ?? 0) - (P[b + 2] ?? 0)
    const vx = (P[a] ?? 0) - (P[b] ?? 0), vy = (P[a + 1] ?? 0) - (P[b + 1] ?? 0), vz = (P[a + 2] ?? 0) - (P[b + 2] ?? 0)
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.sqrt(x * x + y * y + z * z)
    out[0] = l > 0 ? x / l : 0
    out[1] = l > 0 ? y / l : 0
    out[2] = l > 0 ? z / l : 0
  }
  const out = new Floats(1024)
  const push = (k: number): void => {
    const t = (k / 3) | 0
    const j = k % 3
    const v0 = vtx(3 * t + j) * 3
    const v1 = vtx(3 * t + ((j + 1) % 3)) * 3
    out.push3(P[v0] ?? 0, P[v0 + 1] ?? 0, P[v0 + 2] ?? 0)
    out.push3(P[v1] ?? 0, P[v1 + 1] ?? 0, P[v1 + 2] ?? 0)
  }
  // Within one bucket, each key (other end, direction) is unseen, holds the first edge that claimed it, or is spent:
  // the same states EdgesGeometry's map goes through, in the same triangle order.
  const keys: number[] = []
  const held: number[] = []
  const n0 = [0, 0, 0]
  const n1 = [0, 0, 0]
  for (let lo = 0; lo < nw; lo++) {
    const from = cnt[lo] ?? 0
    const to = cnt[lo + 1] ?? 0
    if (from === to) continue
    keys.length = 0
    held.length = 0
    for (let e = from; e < to; e++) {
      const key = other[e]!
      const rev = -key - 1
      const ri = keys.indexOf(rev)
      if (ri >= 0 && held[ri]! >= 0) {
        normal((corner[e]! / 3) | 0, n0)
        normal((held[ri]! / 3) | 0, n1)
        if (n0[0]! * n1[0]! + n0[1]! * n1[1]! + n0[2]! * n1[2]! <= thresholdDot) push(corner[e]!)
        held[ri] = -1
      } else if (keys.indexOf(key) < 0) {
        keys.push(key)
        held.push(corner[e]!)
      }
    }
    // Edges no opposite edge took are borders, drawn as they came.
    for (let i = 0; i < held.length; i++) if (held[i]! >= 0) push(held[i]!)
  }
  return out.done()
}

/**
 * Vertex normals of an indexed mesh, each the area-weighted average of the faces around that vertex, with no creases:
 * one pass over the triangles and one over the vertices. The quick stand-in shading while the creased normals are
 * still being made; a mesh with a vertex per corner (not welded) comes out flat shaded.
 */
export function smoothNormals(P: Float32Array, I: ArrayLike<number>): Float32Array {
  const n = new Float32Array(P.length)
  const nt = Math.floor(I.length / 3)
  for (let t = 0; t < nt; t++) {
    const a = (I[3 * t] ?? 0) * 3
    const b = (I[3 * t + 1] ?? 0) * 3
    const c = (I[3 * t + 2] ?? 0) * 3
    const ux = (P[b] ?? 0) - (P[a] ?? 0), uy = (P[b + 1] ?? 0) - (P[a + 1] ?? 0), uz = (P[b + 2] ?? 0) - (P[a + 2] ?? 0)
    const vx = (P[c] ?? 0) - (P[a] ?? 0), vy = (P[c + 1] ?? 0) - (P[a + 1] ?? 0), vz = (P[c + 2] ?? 0) - (P[a + 2] ?? 0)
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    n[a] = (n[a] ?? 0) + x; n[a + 1] = (n[a + 1] ?? 0) + y; n[a + 2] = (n[a + 2] ?? 0) + z
    n[b] = (n[b] ?? 0) + x; n[b + 1] = (n[b + 1] ?? 0) + y; n[b + 2] = (n[b + 2] ?? 0) + z
    n[c] = (n[c] ?? 0) + x; n[c + 1] = (n[c + 1] ?? 0) + y; n[c + 2] = (n[c + 2] ?? 0) + z
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i] ?? 0, n[i + 1] ?? 0, n[i + 2] ?? 0)
    if (l > 0) {
      n[i] = (n[i] ?? 0) / l
      n[i + 1] = (n[i + 1] ?? 0) / l
      n[i + 2] = (n[i + 2] ?? 0) / l
    }
  }
  return n
}
