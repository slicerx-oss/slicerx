// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh edits the app does itself: split into connected pieces, merge objects into one, and the
// basic primitives. Pure, on the contracts' MeshPart buffers (mm, Z up). Booleans (negative
// volumes) need sx-geom and are not here.
import type { MeshPart } from '@slicerx/contracts'
import { apply, identity, multiply, type Mat4, type Vec3 } from './transform'

/** Groups triangles that share a vertex position (welded to 1 um) into connected pieces. */
export function components(part: MeshPart): MeshPart[] {
  const pos = part.positions
  const idx = part.indices
  const vcount = pos.length / 3
  // Weld equal positions so meshes stored as triangle soup still connect.
  const weld = new Int32Array(vcount)
  const seen = new Map<string, number>()
  for (let v = 0; v < vcount; v++) {
    const key = `${Math.round((pos[v * 3] ?? 0) * 1000)},${Math.round((pos[v * 3 + 1] ?? 0) * 1000)},${Math.round((pos[v * 3 + 2] ?? 0) * 1000)}`
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, v)
      weld[v] = v
    } else weld[v] = first
  }
  const parent = new Int32Array(vcount)
  for (let v = 0; v < vcount; v++) parent[v] = v
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = weld[idx[t]!]!
    union(a, weld[idx[t + 1]!]!)
    union(a, weld[idx[t + 2]!]!)
  }
  const groups = new Map<number, number[]>()
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const root = find(weld[idx[t]!]!)
    let g = groups.get(root)
    if (!g) groups.set(root, (g = []))
    g.push(t)
  }
  if (groups.size <= 1) return [part]
  const out: MeshPart[] = []
  let n = 0
  for (const tris of groups.values()) {
    const remap = new Map<number, number>()
    const p: number[] = []
    const ix: number[] = []
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const v = idx[t + k]!
        let nv = remap.get(v)
        if (nv === undefined) {
          nv = remap.size
          remap.set(v, nv)
          p.push(pos[v * 3] ?? 0, pos[v * 3 + 1] ?? 0, pos[v * 3 + 2] ?? 0)
        }
        ix.push(nv)
      }
    }
    out.push({ name: `${part.name} ${++n}`, slot: part.slot, positions: new Float32Array(p), indices: new Uint32Array(ix) })
  }
  // Biggest piece first, so the main body keeps the first name.
  return out.sort((a, b) => b.indices.length - a.indices.length)
}

/** Every connected piece of every part, as parts. */
export function splitToParts(parts: readonly MeshPart[]): MeshPart[] {
  return parts.flatMap((p) => components(p))
}

function boundsOf(parts: readonly MeshPart[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const part of parts) for (let i = 0; i + 2 < part.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = part.positions[i + k] ?? 0
    if (v < min[k]!) min[k] = v
    if (v > max[k]!) max[k] = v
  }
  return { min, max }
}

function shift(part: MeshPart, d: Vec3): MeshPart {
  const p = new Float32Array(part.positions.length)
  for (let i = 0; i + 2 < p.length; i += 3) {
    p[i] = (part.positions[i] ?? 0) + d[0]
    p[i + 1] = (part.positions[i + 1] ?? 0) + d[1]
    p[i + 2] = (part.positions[i + 2] ?? 0) + d[2]
  }
  return { ...part, positions: p }
}

function translation(d: Vec3): Mat4 {
  const m = identity()
  m[12] = d[0]
  m[13] = d[1]
  m[14] = d[2]
  return m
}

export interface SplitObject {
  parts: MeshPart[]
  /** The piece's transform: the source transform, moved so the piece stays where it was. */
  transform: Mat4
}

/**
 * Split to objects: each piece becomes an object, recentered in X and Y like every loaded model,
 * with a transform that leaves it where it was on the plate.
 */
export function splitToObjects(parts: readonly MeshPart[], transform: Mat4): SplitObject[] {
  const pieces = splitToParts(parts)
  if (pieces.length <= 1) return []
  return pieces.map((piece) => {
    const b = boundsOf([piece])
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0]
    return { parts: [shift(piece, [-c[0], -c[1], 0])], transform: multiply(transform, translation(c)) }
  })
}

/** Inverse of an affine transform (rotation, scale, translation). */
export function invert(m: Mat4): Mat4 {
  const a = (r: number, c: number) => m[c * 4 + r] ?? 0
  const det = a(0, 0) * (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)) - a(0, 1) * (a(1, 0) * a(2, 2) - a(1, 2) * a(2, 0)) + a(0, 2) * (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0))
  if (Math.abs(det) < 1e-12) return identity()
  const inv = (r: number, c: number) => {
    const rows = [0, 1, 2].filter((x) => x !== c)
    const cols = [0, 1, 2].filter((x) => x !== r)
    const minor = a(rows[0]!, cols[0]!) * a(rows[1]!, cols[1]!) - a(rows[0]!, cols[1]!) * a(rows[1]!, cols[0]!)
    return (((r + c) % 2 === 0 ? 1 : -1) * minor) / det
  }
  const out = identity()
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = inv(r, c)
  const t: Vec3 = [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0]
  for (let r = 0; r < 3; r++) out[12 + r] = -((out[r] ?? 0) * t[0] + (out[4 + r] ?? 0) * t[1] + (out[8 + r] ?? 0) * t[2])
  return out
}

/** Bakes a transform into a part's positions. */
export function bake(part: MeshPart, m: Mat4): MeshPart {
  const p = new Float32Array(part.positions.length)
  for (let i = 0; i + 2 < p.length; i += 3) {
    const w = apply(m, [part.positions[i] ?? 0, part.positions[i + 1] ?? 0, part.positions[i + 2] ?? 0])
    p[i] = w[0]
    p[i + 1] = w[1]
    p[i + 2] = w[2]
  }
  // A mirroring transform flips the winding; turn triangles back so normals point out.
  const det = (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[6] ?? 0)) - (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[2] ?? 0)) + (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[5] ?? 0) * (m[2] ?? 0))
  let indices = part.indices
  if (det < 0) {
    indices = new Uint32Array(part.indices)
    for (let t = 0; t + 2 < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!]
  }
  return { ...part, positions: p, indices }
}

/** Merge: the parts of every object in the first object's frame, so the first keeps its transform. */
export function mergeParts(objects: readonly { parts: readonly MeshPart[]; transform: Mat4 }[]): MeshPart[] {
  const first = objects[0]
  if (!first) return []
  const toFirst = invert(first.transform)
  return objects.flatMap((o, i) => (i === 0 ? [...o.parts] : o.parts.map((p) => bake(p, multiply(toFirst, o.transform)))))
}

// ---------------------------------------------------------------------------
// Primitives, centered in X and Y, standing on Z = 0

export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone'

function part(name: string, p: number[], ix: number[]): MeshPart {
  return { name, slot: 1, positions: new Float32Array(p), indices: new Uint32Array(ix) }
}

export function boxMesh(w: number, d: number, h: number): MeshPart {
  const x = w / 2
  const y = d / 2
  const p = [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0, -x, -y, h, x, -y, h, x, y, h, -x, y, h]
  const ix = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return part('Box', p, ix)
}

/** A cylinder, or a cone when the top diameter is 0. */
export function cylinderMesh(diameter: number, h: number, segments = 48, topDiameter = diameter): MeshPart {
  const r0 = diameter / 2
  const r1 = topDiameter / 2
  const p: number[] = [0, 0, 0, 0, 0, h]
  const ix: number[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    p.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, h)
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    const b0 = 2 + i * 2
    const t0 = b0 + 1
    const b1 = 2 + j * 2
    const t1 = b1 + 1
    ix.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0)
  }
  return part(topDiameter === 0 ? 'Cone' : 'Cylinder', p, ix)
}

export function sphereMesh(diameter: number, rings = 24, segments = 48): MeshPart {
  const r = diameter / 2
  const p: number[] = []
  const ix: number[] = []
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * Math.PI
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2
      p.push(Math.sin(t) * Math.cos(a) * r, Math.sin(t) * Math.sin(a) * r, r - Math.cos(t) * r)
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segments; j++) {
    const a = i * segments + j
    const b = i * segments + ((j + 1) % segments)
    const c = a + segments
    const d = b + segments
    ix.push(a, b, c, b, d, c)
  }
  return part('Sphere', p, ix)
}

export function primitive(shape: PrimitiveShape, sizeMm = 20): MeshPart {
  switch (shape) {
    case 'box':
      return boxMesh(sizeMm, sizeMm, sizeMm)
    case 'cylinder':
      return cylinderMesh(sizeMm, sizeMm)
    case 'cone':
      return cylinderMesh(sizeMm, sizeMm, 48, 0)
    case 'sphere':
      return sphereMesh(sizeMm)
  }
}
