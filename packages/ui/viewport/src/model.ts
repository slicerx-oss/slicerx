// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns plate objects into scene meshes: creased normals so flat faces and
// pixel steps stay crisp, thin feature edges, and per-part polygon offset so
// coplanar faces between stacked color parts resolve the same way every frame.
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineSegments,
  Matrix4,
  Mesh,
  type Material,
} from 'three'
import type { FilamentFinish, ViewportObject, ViewportPart } from './types'

const CREASE_DEG = 40
const EDGE_DEG = 38

export interface PartEntry {
  mesh: Mesh
  edges: LineSegments
  color: string
  finish: FilamentFinish
  index: number
}

export interface ObjectEntry {
  id: string
  name: string
  group: Group
  parts: PartEntry[]
}

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

/**
 * Indexed geometry whose normals average only faces within CREASE_DEG of each other. A corner shares its vertex with
 * the other corners of the same source vertex that got the same normal, so a smooth mesh keeps about one vertex per
 * source vertex and a hard edge splits where it should. Triangle t of the result is triangle t of the input.
 */
export function creasedGeometry(P: Float32Array, I: ArrayLike<number>): BufferGeometry {
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
  const cosA = Math.cos((CREASE_DEG * Math.PI) / 180)
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
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(pos.done(), 3))
  out.setAttribute('normal', new BufferAttribute(nrm.done(), 3))
  out.setIndex(new BufferAttribute(index, 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
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

function edgeGeometry(part: ViewportPart): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(featureEdges(part.positions, part.indices, EDGE_DEG), 3))
  return g
}

/** Later parts win coplanar ties, the same way every frame. */
function partOffset(i: number): Mesh['onBeforeRender'] {
  return (_r, _s, _c, _g, mat) => {
    const m = mat as Material
    if (m.polygonOffset) {
      m.polygonOffsetFactor = -0.12 * i
      m.polygonOffsetUnits = -4 * i
    }
  }
}

export function buildObject(obj: ViewportObject, material: (p: ViewportPart) => Material, edgeMaterial: Material): ObjectEntry {
  const group = new Group()
  group.name = obj.name
  group.userData.objectId = obj.id
  group.matrixAutoUpdate = false
  group.matrix.copy(new Matrix4().fromArray(obj.transform))
  const parts: PartEntry[] = obj.parts.map((p, i) => {
    const mesh = new Mesh(creasedGeometry(p.positions, p.indices), material(p))
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.objectId = obj.id
    mesh.userData.partIndex = i
    // Kept for the lay-on-face tool: triangle t of the creased geometry is triangle t of these.
    mesh.userData.source = { positions: p.positions, indices: p.indices }
    mesh.onBeforeRender = partOffset(i)
    const edges = new LineSegments(edgeGeometry(p), edgeMaterial)
    edges.raycast = () => {}
    mesh.add(edges)
    group.add(mesh)
    return { mesh, edges, color: p.color, finish: p.finish ?? 'basic', index: i }
  })
  return { id: obj.id, name: obj.name, group, parts }
}

export function disposeObject(o: ObjectEntry): void {
  for (const p of o.parts) {
    p.mesh.geometry.dispose()
    p.edges.geometry.dispose()
  }
  o.group.removeFromParent()
}
