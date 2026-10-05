// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Turns plate objects into scene meshes: creased normals so flat faces and
// pixel steps stay crisp, thin feature edges, and per-part polygon offset so
// coplanar faces between stacked color parts resolve the same way every frame.
import {
  BufferAttribute,
  BufferGeometry,
  EdgesGeometry,
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

/** Welds positions at 1 micrometer so normals and edges see shared vertices even in unindexed files. */
function weld(pos: Float32Array): { map: Int32Array; count: number } {
  const n = pos.length / 3
  const map = new Int32Array(n)
  const seen = new Map<string, number>()
  let count = 0
  for (let i = 0; i < n; i++) {
    const k = `${Math.round((pos[3 * i] ?? 0) * 1000)},${Math.round((pos[3 * i + 1] ?? 0) * 1000)},${Math.round((pos[3 * i + 2] ?? 0) * 1000)}`
    let id = seen.get(k)
    if (id === undefined) {
      id = count++
      seen.set(k, id)
    }
    map[i] = id
  }
  return { map, count }
}

/** Unindexed geometry whose normals average only faces within CREASE_DEG of each other. */
export function creasedGeometry(P: Float32Array, I: ArrayLike<number>): BufferGeometry {
  const nt = Math.floor(I.length / 3)
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
  const { map: wmap, count: nw } = weld(P)
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
  const pos = new Float32Array(nt * 9)
  const nrm = new Float32Array(nt * 9)
  const cosA = Math.cos((CREASE_DEG * Math.PI) / 180)
  for (let t = 0; t < nt; t++) {
    const tx = f(3 * t), ty = f(3 * t + 1), tz = f(3 * t + 2)
    for (let j = 0; j < 3; j++) {
      const vi = at(3 * t + j)
      const wi = w(3 * t + j)
      const o = 9 * t + 3 * j
      let x = 0, y = 0, z = 0
      const end = cnt[wi + 1] ?? 0
      for (let k = cnt[wi] ?? 0; k < end; k++) {
        const g = lst[k] ?? 0
        if (f(3 * g) * tx + f(3 * g + 1) * ty + f(3 * g + 2) * tz >= cosA) {
          x += u(3 * g); y += u(3 * g + 1); z += u(3 * g + 2)
        }
      }
      const l = Math.hypot(x, y, z) || 1
      pos[o] = p(3 * vi); pos[o + 1] = p(3 * vi + 1); pos[o + 2] = p(3 * vi + 2)
      nrm[o] = x / l; nrm[o + 1] = y / l; nrm[o + 2] = z / l
    }
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(pos, 3))
  out.setAttribute('normal', new BufferAttribute(nrm, 3))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

function edgeGeometry(part: ViewportPart): EdgesGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(part.positions, 3))
  g.setIndex(new BufferAttribute(part.indices, 1))
  const e = new EdgesGeometry(g, EDGE_DEG)
  g.dispose()
  return e
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
