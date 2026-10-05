// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh and transform helpers shared by the orientation, support, risk and
// layer skills. Rotations are degrees about X, then Y, then Z, the same
// convention as rotationMatrix and PilotProject.setRotation. Meshes from
// ProjectObject.mesh() are taken as modeled; the plate item's `rotate` is the
// absolute rotation placed on the bed.
import type { MeshPart, Plate } from '@slicerx/contracts'
import { rotationMatrix } from '../../src/memory-project'
import type { PilotProject, ProjectObject } from '../../src/project'

export type Rot = [number, number, number]
export type Vec3 = [number, number, number]
export type FaceDir = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

/** Outward directions of the named faces in model coordinates. Front faces the viewer (minus Y). */
export const FACE_DIRS: Record<FaceDir, Vec3> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
}
export const FACE_NAMES = Object.keys(FACE_DIRS) as FaceDir[]

export interface Orientation {
  name: string
  rotate: Rot
  /** Name used by scoreOrientations for the same rotation, when it has one. */
  orientName?: string
}

/** The six axis orientations, named by the face that ends up on the bed. */
export const AXIS_ORIENTATIONS: Orientation[] = [
  { name: 'bottom down (as modeled)', rotate: [0, 0, 0], orientName: 'as modeled' },
  { name: 'top down', rotate: [180, 0, 0], orientName: 'upside down' },
  { name: 'front down', rotate: [90, 0, 0], orientName: 'on its back' },
  { name: 'back down', rotate: [-90, 0, 0], orientName: 'on its front' },
  { name: 'left down', rotate: [0, -90, 0], orientName: 'on its right side' },
  { name: 'right down', rotate: [0, 90, 0], orientName: 'on its left side' },
]

/** 45 degree tilts from the modeled pose. */
export const TILT_ORIENTATIONS: Orientation[] = [
  { name: 'tilted 45 deg toward the front', rotate: [45, 0, 0] },
  { name: 'tilted 45 deg toward the back', rotate: [-45, 0, 0] },
  { name: 'tilted 45 deg toward the left', rotate: [0, -45, 0] },
  { name: 'tilted 45 deg toward the right', rotate: [0, 45, 0] },
]

/** Row-major 3x3 rotation for an X, Y, Z rotation. */
export function rot3(r: Rot): number[][] {
  const t = rotationMatrix(r)
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => t[j * 4 + i] ?? 0))
}

export function applyRot(m: number[][], v: Vec3): Vec3 {
  const row = (i: number): number => (m[i]?.[0] ?? 0) * v[0] + (m[i]?.[1] ?? 0) * v[1] + (m[i]?.[2] ?? 0) * v[2]
  return [row(0), row(1), row(2)]
}

function mul3(a: number[][], b: number[][]): number[][] {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + (a[i]?.[k] ?? 0) * (b[k]?.[j] ?? 0), 0)))
}

const clean = (d: number): number => {
  const r = Math.round(d * 1e6) / 1e6
  const n = Math.round(r)
  const v = Math.abs(r - n) < 1e-4 ? n : r
  return Object.is(v, -0) ? 0 : v
}

/** X, Y, Z angles (degrees) of a row-major rotation built as Rz * Ry * Rx. */
export function eulerOf(m: number[][]): Rot {
  const m20 = m[2]?.[0] ?? 0
  const ry = Math.asin(Math.max(-1, Math.min(1, -m20)))
  let rx: number
  let rz: number
  if (Math.abs(Math.cos(ry)) > 1e-6) {
    rx = Math.atan2(m[2]?.[1] ?? 0, m[2]?.[2] ?? 1)
    rz = Math.atan2(m[1]?.[0] ?? 0, m[0]?.[0] ?? 1)
  } else {
    rx = 0
    rz = Math.atan2(-(m[0]?.[1] ?? 0), m[1]?.[1] ?? 1)
  }
  const deg = (x: number): number => clean((x * 180) / Math.PI)
  return [deg(rx), deg(ry), deg(rz)]
}

/** The absolute rotation of `extra` applied after `current`. */
export function composeRotation(current: Rot, extra: Rot): Rot {
  return eulerOf(mul3(rot3(extra), rot3(current)))
}

/** The size of a box before a rotation, from its size after (exact for axis rotations). */
export function unrotateBox(box: Vec3, rotate: Rot): Vec3 {
  const m = rot3(rotate)
  const col = (j: number): number => Math.round((Math.abs(m[0]?.[j] ?? 0) * box[0] + Math.abs(m[1]?.[j] ?? 0) * box[1] + Math.abs(m[2]?.[j] ?? 0) * box[2]) * 100) / 100
  return [col(0), col(1), col(2)]
}

/** A copy of the parts with every vertex rotated. */
export function transformParts(parts: MeshPart[], rotate: Rot): MeshPart[] {
  if (rotate.every((d) => d === 0)) return parts
  const m = rot3(rotate)
  return parts.map((p) => {
    const out = new Float32Array(p.positions.length)
    for (let v = 0; v + 2 < p.positions.length; v += 3) {
      const r = applyRot(m, [p.positions[v] ?? 0, p.positions[v + 1] ?? 0, p.positions[v + 2] ?? 0])
      out[v] = r[0]
      out[v + 1] = r[1]
      out[v + 2] = r[2]
    }
    return { ...p, positions: out }
  })
}

/** Does this plate object place the given project object? */
export function placesObject(plateObj: { id: string; mesh: string }, objectId: string): boolean {
  return plateObj.mesh === objectId || plateObj.id === objectId || plateObj.id.startsWith(`${objectId}#`)
}

/**
 * A copy of the plate with an extra rotation applied to the objects (all of
 * them, or those of one project object). The rotation is about each object's
 * origin; translations are kept and the host drops parts onto the bed.
 */
export function rotateItems(plate: Plate, rotate: Rot, objectId?: string): Plate {
  const m = rot3(rotate)
  return {
    bed: { ...plate.bed },
    objects: plate.objects.map((o) => {
      if (objectId && !placesObject(o, objectId)) return { ...o, transform: [...o.transform] }
      const t = o.transform
      const cur = [0, 1, 2].map((i) => [0, 1, 2].map((j) => t[j * 4 + i] ?? (i === j ? 1 : 0)))
      const r = mul3(m, cur)
      const next = [...t]
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) next[j * 4 + i] = Math.round((r[i]?.[j] ?? 0) * 1e9) / 1e9
      return { ...o, transform: next }
    }),
  }
}

/** A copy of the plate with one object's rotation set to an absolute value (translation kept). */
export function setItemRotation(plate: Plate, objectId: string, rotate: Rot): Plate {
  const r = rotationMatrix(rotate)
  return {
    bed: { ...plate.bed },
    objects: plate.objects.map((o) => {
      if (!placesObject(o, objectId)) return { ...o, transform: [...o.transform] }
      const next = [...o.transform]
      for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) next[k] = r[k] ?? 0
      return { ...o, transform: next }
    }),
  }
}

/** The current absolute rotation of an object, from the first plate that holds it. */
export function currentRotation(project: PilotProject, objectId: string): Rot {
  for (const p of project.plates()) for (const it of p.items) if (it.objectId === objectId && it.rotate) return it.rotate
  return [0, 0, 0]
}

/** The plate an object is on, or the first plate. */
export function plateOf(project: PilotProject, objectId?: string): number | undefined {
  const plates = project.plates()
  if (objectId) {
    const hit = plates.find((p) => p.items.some((it) => it.objectId === objectId))
    if (hit) return hit.index
  }
  return plates[0]?.index
}

/** Geometry as placed on the bed: the modeled mesh with the current rotation applied. */
export async function placedParts(project: PilotProject, obj: ProjectObject): Promise<MeshPart[] | null> {
  if (!obj.mesh) return null
  return transformParts(await obj.mesh(), currentRotation(project, obj.id))
}

/** Axis-aligned size of the parts. */
export function partsBox(parts: MeshPart[]): { min: Vec3; max: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let v = 0; v + 2 < p.positions.length; v += 3) {
      for (let k = 0; k < 3; k++) {
        const x = p.positions[v + k] ?? 0
        if (x < (min[k] ?? 0)) min[k] = x
        if (x > (max[k] ?? 0)) max[k] = x
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}

export interface Tri {
  a: Vec3
  b: Vec3
  c: Vec3
  /** Unit normal. */
  n: Vec3
  area: number
}

/** Calls `f` for every non-degenerate triangle. */
export function eachTri(parts: MeshPart[], f: (t: Tri) => void): void {
  for (const p of parts) {
    const P = p.positions
    const I = p.indices
    for (let t = 0; t + 2 < I.length; t += 3) {
      const ia = (I[t] ?? 0) * 3
      const ib = (I[t + 1] ?? 0) * 3
      const ic = (I[t + 2] ?? 0) * 3
      const a: Vec3 = [P[ia] ?? 0, P[ia + 1] ?? 0, P[ia + 2] ?? 0]
      const b: Vec3 = [P[ib] ?? 0, P[ib + 1] ?? 0, P[ib + 2] ?? 0]
      const c: Vec3 = [P[ic] ?? 0, P[ic + 1] ?? 0, P[ic + 2] ?? 0]
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const len = Math.hypot(nx, ny, nz)
      if (len === 0) continue
      f({ a, b, c, n: [nx / len, ny / len, nz / len], area: len / 2 })
    }
  }
}

export interface OverhangStats {
  /** Downward faces steeper than the support angle, not on the bed, cm2. */
  overhangCm2: number
  /** Share of that area that is nearly flat (a ceiling), 0 to 1. */
  flatShare: number
  /** Overhang area with part geometry below it (supports would start on the part), cm2. */
  overPartCm2: number
  /** Faces resting on the bed, cm2. */
  contactCm2: number
  /** Separate overhang regions, counted on a 5 mm grid. */
  regions: number
  /** Highest overhang above the bed, mm. */
  maxHeightMm: number
  heightMm: number
}

/**
 * Overhangs of parts as they sit (Z up, lowest point on the bed). An overhang
 * face points down more steeply than the support angle allows, measured from
 * horizontal, and is not on the bed. "Over part" tests each overhang face's
 * center against a 2 mm grid of upward faces below it.
 */
export function overhangStats(parts: MeshPart[], supportAngleDeg = 45): OverhangStats {
  const box = partsBox(parts)
  const minZ = box.min[2]
  const cosLimit = Math.cos(((90 - supportAngleDeg) * Math.PI) / 180)
  const cell = 2
  const key = (x: number, y: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const upLow = new Map<string, number>()
  const over: { cx: number; cy: number; cz: number; area: number; flat: boolean }[] = []
  let contact = 0
  eachTri(parts, (t) => {
    const down = -t.n[2]
    const top = Math.max(t.a[2], t.b[2], t.c[2])
    const low = top - minZ < 0.2
    if (t.n[2] > 0.1) {
      // Rasterize upward faces coarsely: corners and center.
      for (const [x, y, z] of [t.a, t.b, t.c, [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3] as Vec3]) {
        const k = key(x, y)
        upLow.set(k, Math.min(upLow.get(k) ?? Infinity, z))
      }
    }
    if (down > 0.999 && low) contact += t.area
    else if (down > cosLimit && !low) {
      over.push({ cx: (t.a[0] + t.b[0] + t.c[0]) / 3, cy: (t.a[1] + t.b[1] + t.c[1]) / 3, cz: (t.a[2] + t.b[2] + t.c[2]) / 3, area: t.area, flat: down > 0.97 })
    }
  })
  let total = 0
  let flat = 0
  let overPart = 0
  let maxH = 0
  const regionCells = new Set<string>()
  for (const o of over) {
    total += o.area
    if (o.flat) flat += o.area
    const below = upLow.get(key(o.cx, o.cy))
    if (below !== undefined && below < o.cz - 0.5 && below - minZ > 0.2) overPart += o.area
    maxH = Math.max(maxH, o.cz - minZ)
    regionCells.add(`${Math.floor(o.cx / 5)},${Math.floor(o.cy / 5)},${Math.floor(o.cz / 5)}`)
  }
  // Count connected groups of 5 mm cells.
  let regions = 0
  const seen = new Set<string>()
  for (const c of regionCells) {
    if (seen.has(c)) continue
    regions++
    const stack = [c]
    seen.add(c)
    while (stack.length) {
      const cur = stack.pop() ?? ''
      const [x, y, z] = cur.split(',').map(Number) as [number, number, number]
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const n = `${x + dx},${y + dy},${z + dz}`
        if (regionCells.has(n) && !seen.has(n)) {
          seen.add(n)
          stack.push(n)
        }
      }
    }
  }
  const r1 = (v: number): number => Math.round(v * 10) / 10
  return {
    overhangCm2: r1(total / 100),
    flatShare: total > 0 ? Math.round((flat / total) * 100) / 100 : 0,
    overPartCm2: r1(overPart / 100),
    contactCm2: r1(contact / 100),
    regions,
    maxHeightMm: r1(maxH),
    heightMm: r1(box.size[2]),
  }
}

export interface FaceExposure {
  face: FaceDir
  /** Area of the named face (triangles facing within about 25 degrees of it), cm2. */
  areaCm2: number
  /** Of that, resting on the bed, cm2. */
  onBedCm2: number
  /** Of that, overhanging past the support angle (support would touch it), cm2. */
  supportedCm2: number
  /** Where the face points after the rotation. */
  facing: 'up' | 'down' | 'side'
}

/** Where a named face ends up after a rotation, and how much of it rests on the bed or needs support. */
export function faceExposure(parts: MeshPart[] | null, rotate: Rot, face: FaceDir, supportAngleDeg = 45): FaceExposure {
  const m = rot3(rotate)
  const d = applyRot(m, FACE_DIRS[face])
  const facing = d[2] > 0.7 ? 'up' : d[2] < -0.7 ? 'down' : 'side'
  if (!parts) {
    // Without geometry, treat the face as the flat side of the bounding box.
    return { face, areaCm2: 0, onBedCm2: 0, supportedCm2: 0, facing }
  }
  const dir = FACE_DIRS[face]
  const placed = transformParts(parts, rotate)
  const minZ = partsBox(placed).min[2]
  const cosLimit = Math.cos(((90 - supportAngleDeg) * Math.PI) / 180)
  let area = 0
  let onBed = 0
  let supported = 0
  // Triangle order is preserved by transformParts, so pair model normals with placed ones.
  const model: number[] = []
  eachTri(parts, (t) => void model.push(t.n[0] * dir[0] + t.n[1] * dir[1] + t.n[2] * dir[2]))
  let i = 0
  eachTri(placed, (t) => {
    const dot = model[i++] ?? 0
    if (dot < 0.9) return
    area += t.area
    const down = -t.n[2]
    const low = Math.max(t.a[2], t.b[2], t.c[2]) - minZ < 0.2
    if (down > 0.999 && low) onBed += t.area
    else if (down > cosLimit && !low) supported += t.area
  })
  const r1 = (v: number): number => Math.round(v * 10) / 10
  return { face, areaCm2: r1(area / 100), onBedCm2: r1(onBed / 100), supportedCm2: r1(supported / 100), facing }
}

/** Overhang area and bed contact for any rotation, the same measure scoreOrientations uses for the six axis poses. */
export function scoreRotation(parts: MeshPart[], rotate: Rot, supportAngleDeg = 45): { overhangCm2: number; contactCm2: number; heightMm: number } {
  const s = overhangStats(transformParts(parts, rotate), supportAngleDeg)
  return { overhangCm2: s.overhangCm2, contactCm2: s.contactCm2, heightMm: s.heightMm }
}

/** Edges used by exactly one triangle, after welding vertices closer than 1 micron. Zero for a closed mesh. */
export function openEdges(parts: MeshPart[]): number {
  const ids = new Map<string, number>()
  const vid = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
    let id = ids.get(k)
    if (id === undefined) {
      id = ids.size
      ids.set(k, id)
    }
    return id
  }
  const edges = new Map<string, number>()
  for (const p of parts) {
    const P = p.positions
    const I = p.indices
    for (let t = 0; t + 2 < I.length; t += 3) {
      const v = [0, 1, 2].map((k) => {
        const i = (I[t + k] ?? 0) * 3
        return vid(P[i] ?? 0, P[i + 1] ?? 0, P[i + 2] ?? 0)
      })
      for (let k = 0; k < 3; k++) {
        const a = v[k] ?? 0
        const b = v[(k + 1) % 3] ?? 0
        if (a === b) continue
        const e = a < b ? `${a}_${b}` : `${b}_${a}`
        edges.set(e, (edges.get(e) ?? 0) + 1)
      }
    }
  }
  let open = 0
  for (const n of edges.values()) if (n === 1) open++
  return open
}
