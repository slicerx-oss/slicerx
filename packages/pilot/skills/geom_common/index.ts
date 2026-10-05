// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Helpers for the skills that change or measure geometry through sx-geom:
// mesh conversion, host calls, response parsing, in-place replacement of an
// object's geometry and the numbers skills read from the project config.
import type { MeshPart } from '@slicerx/contracts'
import type { KnowledgeBase } from '../../src/kb/kb'
import type { PilotProject, ProjectObject } from '../../src/project'
import type { ToolContext, ToolOutput } from '../../src/tool'
import { FACE_DIRS, currentRotation, partsBox, plateOf, rot3, transformParts, type FaceDir, type Vec3 } from '../orientation_search/geometry'

export type Rec = Record<string, unknown>
export const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d

export function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  return [v[0] as number, v[1] as number, v[2] as number]
}

/** Mesh in sx-geom's flat JSON form. */
export interface GeomMesh {
  positions: number[]
  indices: number[]
}

/** Merges parts into one flat mesh for sx-geom. */
export function toGeomMesh(parts: MeshPart[]): GeomMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const p of parts) {
    const base = positions.length / 3
    for (const v of p.positions) positions.push(v)
    for (const i of p.indices) indices.push(base + i)
  }
  return { positions, indices }
}

/** A MeshPart from a flat mesh in an sx-geom response, or null when it is not one. */
export function partFromGeom(v: unknown, name: string, slot: number): MeshPart | null {
  const m = rec(v)
  const pos = m['positions']
  const idx = m['indices']
  if (!Array.isArray(pos) || !Array.isArray(idx) || pos.length % 3 !== 0 || idx.length % 3 !== 0 || idx.length === 0) return null
  if (!pos.every((x) => typeof x === 'number') || !idx.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0)) return null
  return { name, slot, positions: Float32Array.from(pos as number[]), indices: Uint32Array.from(idx as number[]) }
}

export const triangleCount = (parts: MeshPart[]): number => parts.reduce((a, p) => a + p.indices.length / 3, 0)

/** Enclosed volume of closed shells, mm3. Overlapping shells count twice. */
export function meshVolume(parts: MeshPart[]): number {
  let v = 0
  for (const p of parts) {
    const P = p.positions
    const I = p.indices
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = (I[t] ?? 0) * 3
      const b = (I[t + 1] ?? 0) * 3
      const c = (I[t + 2] ?? 0) * 3
      const ax = P[a] ?? 0, ay = P[a + 1] ?? 0, az = P[a + 2] ?? 0
      const bx = P[b] ?? 0, by = P[b + 1] ?? 0, bz = P[b + 2] ?? 0
      const cx = P[c] ?? 0, cy = P[c + 1] ?? 0, cz = P[c + 2] ?? 0
      v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    }
  }
  return v
}

// ---------------------------------------------------------------------------
// Host calls

export const NO_GEOMETRY_NOTE = 'Geometry operations (sx-geom) are not available on this host, so mimir cannot read or change the mesh here.'

/** The result for a tool that needs geometry on a host without it. */
export function needsGeometry(what: string): ToolOutput {
  return { ok: false, summary: `${what} needs geometry, which this host does not have`, output: { note: NO_GEOMETRY_NOTE } }
}

export const NO_MESH_NOTE = 'The project gives mimir no mesh data for this object on this host.'

export function isUnknownOp(e: unknown): boolean {
  return /unknown operation/i.test(e instanceof Error ? e.message : String(e))
}

/** Runs one sx-geom operation. Throws when the host has no geometry or the operation fails. */
export async function geomRun(ctx: ToolContext, op: string, req: unknown): Promise<Rec> {
  const g = ctx.host.geom
  if (!g) throw new Error(NO_GEOMETRY_NOTE)
  return rec(await g.run(op, req, ctx.signal))
}

/** Like geomRun, but null when this sx-geom does not have the operation (such as `build` or `subtract` on an older build). */
export async function geomTry(ctx: ToolContext, op: string, req: unknown): Promise<Rec | null> {
  try {
    return await geomRun(ctx, op, req)
  } catch (e) {
    if (isUnknownOp(e)) return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// Solids for sx-geom `build` and `subtract`

export type GeomSolid =
  | { type: 'box'; min: Vec3; max: Vec3 }
  | { type: 'cylinder'; origin: Vec3; axis: Vec3; diameterMm: number; heightMm: number }
  | { type: 'countersink'; origin: Vec3; axis: Vec3; shaftDiameterMm: number; headDiameterMm: number; angleDeg: number; depthMm: number }

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** How far a solid reaches from `point` along `dir`, from the corners of its bounding box. */
export function reachAlong(min: Vec3, max: Vec3, point: Vec3, dir: Vec3): number {
  const d = unit(dir)
  let far = 0
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) far = Math.max(far, (x - point[0]) * d[0] + (y - point[1]) * d[1] + (z - point[2]) * d[2])
  return far
}

/**
 * A hole cut from a surface point going inward, `depthMm` deep. A plain hole
 * starts 1 mm outside so the cutter reaches past the surface; a countersunk
 * hole has its 90 degree head cone open at the surface.
 */
export function holeSolid(point: Vec3, inward: Vec3, diameterMm: number, depthMm: number, countersink?: { headMm: number }): GeomSolid {
  const axis = unit(inward)
  if (countersink) return { type: 'countersink', origin: point, axis, shaftDiameterMm: diameterMm, headDiameterMm: countersink.headMm, angleDeg: 90, depthMm }
  const origin: Vec3 = [round(point[0] - axis[0], 6), round(point[1] - axis[1], 6), round(point[2] - axis[2], 6)]
  return { type: 'cylinder', origin, axis, diameterMm, heightMm: depthMm + 1 }
}

// ---------------------------------------------------------------------------
// Responses

export interface MeshInfo {
  triangles: number
  volumeMm3: number
  areaMm2: number
  min: Vec3
  max: Vec3
  sizeMm: Vec3
  openEdges: number
  nonManifoldEdges: number
  flippedEdges: number
  watertight: boolean
  components: number
}

export function parseInfo(v: Rec): MeshInfo {
  const b = rec(v['bounds'])
  const min = vec3(b['min']) ?? [0, 0, 0]
  const max = vec3(b['max']) ?? [0, 0, 0]
  const e = rec(v['edges'])
  return {
    triangles: num(v['triangles']),
    volumeMm3: num(v['volumeMm3']),
    areaMm2: num(v['areaMm2']),
    min,
    max,
    sizeMm: [round(max[0] - min[0], 2), round(max[1] - min[1], 2), round(max[2] - min[2], 2)],
    openEdges: num(e['boundaryEdges']),
    nonManifoldEdges: num(e['nonManifoldEdges']),
    flippedEdges: num(e['flippedEdges']),
    watertight: v['watertight'] === true,
    components: num(v['components'], 1),
  }
}

export async function meshInfo(ctx: ToolContext, mesh: GeomMesh): Promise<MeshInfo> {
  return parseInfo(await geomRun(ctx, 'info', { mesh }))
}

export interface OrientMeasure {
  overhangAreaMm2: number
  supportVolumeMm3: number
  supportContactAreaMm2: number
  bedContactAreaMm2: number
  heightMm: number
  footprintMm: [number, number]
  score: number
  /** Row-major rotation. */
  matrix: number[][]
}

export function parseOrient(v: Rec): OrientMeasure {
  const fp = arr(v['footprintMm'])
  const m = arr(v['matrix']).map((row) => arr(row).map((x) => num(x)))
  return {
    overhangAreaMm2: num(v['overhangAreaMm2']),
    supportVolumeMm3: num(v['supportVolumeMm3']),
    supportContactAreaMm2: num(v['supportContactAreaMm2']),
    bedContactAreaMm2: num(v['bedContactAreaMm2']),
    heightMm: num(v['heightMm']),
    footprintMm: [num(fp[0]), num(fp[1])],
    score: num(v['score']),
    matrix: m.length === 3 ? m : [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  }
}

// ---------------------------------------------------------------------------
// Project

/** The object's parts and their merged mesh, or null when the host gives no mesh. */
export async function objectGeometry(obj: ProjectObject): Promise<{ parts: MeshPart[]; mesh: GeomMesh } | null> {
  if (!obj.mesh) return null
  const parts = await obj.mesh()
  if (parts.length === 0) return null
  return { parts, mesh: toGeomMesh(parts) }
}

/** Size as placed: the parts with the object's current rotation applied. */
export function placedBox(project: PilotProject | undefined, objectId: string, parts: MeshPart[]): [number, number, number] {
  const rot = project ? currentRotation(project, objectId) : ([0, 0, 0] as Vec3)
  const s = partsBox(transformParts(parts, rot)).size
  return [round(s[0], 2), round(s[1], 2), round(s[2], 2)]
}

/** A project object for new geometry, sized as modeled. */
export function newObject(id: string, name: string, parts: MeshPart[]): ProjectObject {
  const s = partsBox(parts).size
  return { id, name, bboxMm: [round(s[0], 2), round(s[1], 2), round(s[2], 2)], triangles: triangleCount(parts), mesh: async () => parts }
}

/**
 * Swaps an object's geometry in place: same id and name, new mesh, plates and
 * rotations kept. False when the project cannot replace objects.
 */
export async function replaceGeometry(project: PilotProject | undefined, obj: ProjectObject, parts: MeshPart[]): Promise<boolean> {
  if (!project?.replaceObjects) return false
  const plates = project.plates()
  const next: ProjectObject = { id: obj.id, name: obj.name, bboxMm: placedBox(project, obj.id, parts), triangles: triangleCount(parts), mesh: async () => parts }
  if (obj.metadata) next.metadata = obj.metadata
  await project.replaceObjects([obj.id], [next])
  project.setPlates(plates)
  return true
}

/** Undoes a rotation (degrees about X, then Y, then Z): world to model coordinates. */
export function unrotate(rotate: Vec3, world: Vec3): Vec3 {
  const m = rot3(rotate)
  // Rotations are orthonormal, so the inverse is the transpose.
  const col = (j: number): number => (m[0]?.[j] ?? 0) * world[0] + (m[1]?.[j] ?? 0) * world[1] + (m[2]?.[j] ?? 0) * world[2]
  return [round(col(0), 6), round(col(1), 6), round(col(2), 6)]
}

/** A direction on the bed (world) expressed in the object's model coordinates. */
export function modelDirection(project: PilotProject | undefined, objectId: string, world: Vec3): Vec3 {
  return unrotate(project ? currentRotation(project, objectId) : [0, 0, 0], world)
}

/** Outward normal of a named face as placed, in model coordinates. */
export function faceNormal(project: PilotProject | undefined, objectId: string, face: FaceDir): Vec3 {
  return modelDirection(project, objectId, FACE_DIRS[face])
}

/** Center of a mesh's bounding box face along a model direction: where a ray from outside first meets the box. */
export function boxFacePoint(min: Vec3, max: Vec3, dir: Vec3): Vec3 {
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const h: Vec3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]
  // Distance along dir from the center to the box surface.
  let t = Infinity
  for (let k = 0; k < 3; k++) {
    const d = Math.abs(dir[k] ?? 0)
    if (d > 1e-9) t = Math.min(t, (h[k] ?? 0) / d)
  }
  if (!Number.isFinite(t)) t = 0
  return [round(c[0] + dir[0] * t, 4), round(c[1] + dir[1] * t, 4), round(c[2] + dir[2] * t, 4)]
}

/** The plate an object is on, or 1. */
export function plateOfObject(ctx: ToolContext, objectId?: string): number {
  return (ctx.project ? plateOf(ctx.project, objectId) : undefined) ?? 1
}

/** The resolved config of the object's plate, or empty when there is none. */
export function plateConfig(ctx: ToolContext, objectId?: string): Record<string, unknown> {
  try {
    return ctx.project ? { ...ctx.project.config(plateOfObject(ctx, objectId)) } : {}
  } catch {
    return {}
  }
}

/** Print numbers for an object's plate: layer height, first layer, line width, nozzle and infill. */
export function printNumbers(ctx: ToolContext, objectId?: string): { layerHeight: number; firstLayer: number; lineWidth: number; nozzle: number; infillPct: number; material: string } {
  const project = ctx.project
  const nozzle = project?.machine()?.nozzle ?? ctx.context.machine?.nozzle ?? 0.4
  const material = project?.machine()?.material ?? ctx.context.machine?.material ?? 'pla'
  const cfg = plateConfig(ctx, objectId)
  const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)
  const n = (k: string, d: number): number => {
    const v = Number(first(cfg[k]))
    return Number.isFinite(v) && v > 0 ? v : d
  }
  const infill = Number(String(first(cfg['sparse_infill_density']) ?? '15').replace('%', ''))
  return {
    layerHeight: n('layer_height', 0.2),
    firstLayer: n('initial_layer_print_height', n('layer_height', 0.2)),
    lineWidth: n('line_width', round(nozzle * 1.05, 2)),
    nozzle,
    infillPct: Number.isFinite(infill) ? infill : 15,
    material,
  }
}

/** Filament density in g/cm3 from the filament record, with its sources. */
export function densityOf(kb: KnowledgeBase, material: string): { gPerCm3: number; fromKb: boolean; sources: string[] } {
  const doc = kb.get('filament', material) ?? kb.search(material, { kinds: ['filament'], limit: 1 })[0]?.doc
  const d = rec(rec(doc?.data['properties'])['density_g_cm3'])
  const typical = num(d['typical'], NaN)
  if (doc && Number.isFinite(typical) && typical > 0) {
    const src = arr(d['src']).filter((x): x is string => typeof x === 'string')
    return { gPerCm3: typical, fromKb: true, sources: src.length ? src : doc.sources.slice(0, 2) }
  }
  return { gPerCm3: 1.24, fromKb: false, sources: [] }
}

export const fmtSize = (s: readonly number[]): string => s.map((v) => round(v, 1)).join(' x ') + ' mm'
export const cm3 = (mm3: number): number => round(mm3 / 1000, 1)
export const cm2 = (mm2: number): number => round(mm2 / 100, 1)
