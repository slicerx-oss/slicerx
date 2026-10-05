// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Dimensions that stay on the model: a measurement kept on its object. They read the model and never
// drive it. Each end is an anchor in the object's own mesh coordinates (dimension.anchor), so moves,
// turns and scaling keep it; after a mesh edit dimension.evaluate finds it again, and a push passes
// its moved face so dimensions on that face follow it. No React in here.
import type { DimensionMark } from '@slicerx/viewport'
import { dimensionAnchor, evaluateDimensions, type Dimension, type DimensionKind, type EvaluatedDimension, type Feature, type MeshItem, type MovedFace, type Vec3 } from '../geom/cad'
import type { GeomMesh } from '../geom/client'
import { get, set, type PlateEntry } from '../state/store'
import { applyMat, wholeMesh } from './cad-ops'

/** A measure pick on an object, as the view reported it (bed coordinates). */
export interface ObjectPick {
  objectId: string
  partIndex: number
  triangle: number
  at: Vec3
}

export const KIND_NAMES: Record<DimensionKind, string> = { distance: 'Distance', angle: 'Angle', radius: 'Radius', diameter: 'Diameter', length: 'Length' }

/** The kinds a measurement of one or two features can keep, the likeliest first. */
export function keepableKinds(features: readonly Feature[], hasDistance: boolean, hasAngle: boolean): DimensionKind[] {
  if (features.length === 2) return [...(hasDistance ? (['distance'] as const) : []), ...(hasAngle ? (['angle'] as const) : [])]
  const f = features[0]
  if (!f) return []
  if (f.kind === 'circle' || f.kind === 'cylinder') return ['diameter', 'radius']
  if (f.kind === 'edge') return ['length']
  return []
}

const meshCache = new WeakMap<PlateEntry['parts'], GeomMesh>()

/** An object's parts as one mesh, kept per parts array so repeated evaluations do not copy it again. */
export function objectMesh(e: PlateEntry): GeomMesh {
  let m = meshCache.get(e.parts)
  if (!m) meshCache.set(e.parts, (m = wholeMesh(e)))
  return m
}

/** A pick's triangle counted through all parts of the object, as the whole mesh numbers them. */
export function wholeTriangle(e: PlateEntry, partIndex: number, triangle: number): number {
  let n = 0
  for (let i = 0; i < partIndex && i < e.parts.length; i++) n += e.parts[i]!.indices.length / 3
  return n + triangle
}

let seq = 0
const newId = (taken: Set<string>): string => {
  let id = ''
  do id = `d${Date.now().toString(36)}${(++seq).toString(36)}`
  while (taken.has(id))
  return id
}

/** Every dimension on the plate, with the object it is kept on. */
export function allDimensions(plate: readonly PlateEntry[]): { owner: string; d: Dimension }[] {
  return plate.flatMap((e) => (e.dimensions ?? []).map((d) => ({ owner: e.id, d })))
}

/** Keeps a measurement on the model: anchors for one or two picks, stored on the first pick's object in one store update. */
export async function keepDimension(kind: DimensionKind, picks: readonly ObjectPick[], value?: number): Promise<Dimension> {
  const plate = get().plate
  const anchors = await Promise.all(
    picks.map(async (p) => {
      const e = plate.find((x) => x.id === p.objectId)
      if (!e) throw new Error('That object is gone. Measure again.')
      const r = await dimensionAnchor(e.id, { mesh: objectMesh(e), transform: e.transform }, { triangle: wholeTriangle(e, p.partIndex, p.triangle), at: p.at }, 1.5)
      return r.anchor
    }),
  )
  const [a, b] = anchors
  if (!a || ((kind === 'distance' || kind === 'angle') && !b)) throw new Error('Pick two places on objects for a distance or an angle.')
  const taken = new Set(allDimensions(get().plate).map((x) => x.d.id))
  const d: Dimension = { id: newId(taken), kind, a, ...(kind === 'distance' || kind === 'angle' ? { b: b! } : {}), ...(value !== undefined && Number.isFinite(value) ? { value } : {}) }
  set({ plate: get().plate.map((e) => (e.id === a.object ? { ...e, dimensions: [...(e.dimensions ?? []), d] } : e)) })
  return d
}

export function removeDimension(id: string): void {
  set({ plate: get().plate.map((e) => (e.dimensions?.some((d) => d.id === id) ? { ...e, dimensions: e.dimensions.filter((d) => d.id !== id) } : e)) })
}

/** The meshes dimension.evaluate needs, by object id. */
export function objectsFor(plate: readonly PlateEntry[], dims: readonly Dimension[]): Record<string, MeshItem> {
  const ids = new Set(dims.flatMap((d) => [d.a.object, ...(d.b ? [d.b.object] : [])]))
  const out: Record<string, MeshItem> = {}
  for (const e of plate) if (ids.has(e.id)) out[e.id] = { mesh: objectMesh(e), transform: e.transform }
  return out
}

/**
 * After a push on `objectId`: the plate with the anchors of every dimension touching that object
 * found again on the new mesh, following the moved face. Run before the push's store update, so
 * the push and its dimensions are one undo step. Dimensions stay as they were if the engine fails.
 */
export async function followPush(plate: PlateEntry[], objectId: string, moved: MovedFace): Promise<PlateEntry[]> {
  const touched = allDimensions(plate).filter((x) => x.d.a.object === objectId || x.d.b?.object === objectId)
  if (!touched.length) return plate
  try {
    const dims = touched.map((x) => x.d)
    const ev = await evaluateDimensions(dims, objectsFor(plate, dims), [{ ...moved, object: objectId }])
    const next = new Map(ev.map((r, i) => [dims[i]!.id, { ...dims[i]!, a: r.a, ...(r.b ? { b: r.b } : {}), ...(r.status === 'ok' && r.value !== undefined ? { value: r.value } : {}) } as Dimension]))
    return plate.map((e) => (e.dimensions?.some((d) => next.has(d.id)) ? { ...e, dimensions: e.dimensions.map((d) => next.get(d.id) ?? d) } : e))
  } catch {
    return plate
  }
}

const fmt = (v: number, unit: 'mm' | 'deg') => (unit === 'deg' ? `${v.toFixed(1)}°` : `${v.toFixed(2)} mm`)

/** The value of an evaluated dimension in words, or "Lost". */
export function dimensionText(d: Pick<Dimension, 'kind'>, r: Pick<EvaluatedDimension, 'status' | 'value' | 'unit'> | undefined): string {
  if (!r) return 'Measuring'
  if (r.status === 'lost' || r.value === undefined) return 'Lost'
  const v = fmt(r.value, r.unit)
  return d.kind === 'radius' ? `R ${v}` : d.kind === 'diameter' ? `Ø ${v}` : v
}

/** Something perpendicular to an axis, for drawing across a circle. */
function across(axis: Vec3): Vec3 {
  const a: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const c: Vec3 = [axis[1] * a[2] - axis[2] * a[1], axis[2] * a[0] - axis[0] * a[2], axis[0] * a[1] - axis[1] * a[0]]
  const l = Math.hypot(c[0], c[1], c[2]) || 1
  return [c[0] / l, c[1] / l, c[2] / l]
}

const featurePoint = (f: Feature): Vec3 => (f.kind === 'point' || f.kind === 'surface' ? f.at : f.kind === 'edge' ? [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2, (f.a[2] + f.b[2]) / 2] : f.kind === 'circle' ? f.center : f.point)

/** How the view draws an evaluated dimension: a leader line in bed coordinates and its label. Null when lost. */
export function markFor(d: Dimension, r: EvaluatedDimension, plate: readonly PlateEntry[]): DimensionMark | null {
  if (r.status !== 'ok' || r.value === undefined) return null
  const label = dimensionText(d, r)
  const m = r.measurement
  if (m?.from && m.to) return { id: d.id, from: m.from, to: m.to, label }
  const toWorld = (object: string, p: Vec3): Vec3 | null => {
    const e = plate.find((x) => x.id === object)
    return e ? applyMat(e.transform, p) : null
  }
  const fa = r.a.feature
  if ((d.kind === 'radius' || d.kind === 'diameter') && (fa.kind === 'circle' || fa.kind === 'cylinder')) {
    const c = fa.kind === 'circle' ? fa.center : fa.point
    const s = across(fa.axis)
    const rim: Vec3 = [c[0] + s[0] * fa.radius, c[1] + s[1] * fa.radius, c[2] + s[2] * fa.radius]
    const back: Vec3 = d.kind === 'diameter' ? [c[0] - s[0] * fa.radius, c[1] - s[1] * fa.radius, c[2] - s[2] * fa.radius] : c
    const from = toWorld(r.a.object, back)
    const to = toWorld(r.a.object, rim)
    return from && to ? { id: d.id, from, to, label } : null
  }
  if (d.kind === 'length' && fa.kind === 'edge') {
    const from = toWorld(r.a.object, fa.a)
    const to = toWorld(r.a.object, fa.b)
    return from && to ? { id: d.id, from, to, label } : null
  }
  const from = toWorld(r.a.object, featurePoint(fa))
  const to = r.b ? toWorld(r.b.object, featurePoint(r.b.feature)) : null
  return from && to ? { id: d.id, from, to, label } : null
}
