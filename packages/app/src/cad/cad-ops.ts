// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the modeling tools do to the plate, on the typed geometry calls in geom/cad.ts: extrude a shape
// from a face or the bed, copy an object in a line, a grid or a circle, and describe a measurement.
// Each change lands in one store update, so undo takes it back in one step. No React in here.
import type { Pattern } from './pattern'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { arrayCopies, arrayMerged, extrudeShape, revolveSketch, type ArraySpec, type ExtrudeReport, type ExtrudeSpec, type FaceFrame, type Feature, type FreeShape, type Measurement, type MeshResult, type Placement, type Polygon, type RevolveRequest, type Shape, type Vec2, type Vec3 } from '../geom/cad'
import { fromGeom, toGeom, type GeomMesh } from '../geom/client'
import { bake } from '../plate/mesh-ops'
import { bodyHistory, historyField, rememberFont, withStep } from './history/record'
import type { StepParams } from './history/model'
import { sourceId } from '../plate/object-settings'
import { bounds, compose, identity, type Mat4 } from '../plate/transform'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { brandAccent } from '../edition'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** The bed as a face: origin at the bed corner, u along X, v along Y, normal up. */
export const BED_FRAME: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** A point given in a face frame, in bed coordinates. */
export function frameToBed(frame: FaceFrame, [x, y]: Vec2): Vec3 {
  return [frame.origin[0] + frame.u[0] * x + frame.v[0] * y, frame.origin[1] + frame.u[1] * x + frame.v[1] * y, frame.origin[2] + frame.u[2] * x + frame.v[2] * y]
}

/** Outlines in a face frame as closed loops in bed coordinates, holes included. */
export function loopsOf(frame: FaceFrame, polygons: readonly Polygon[]): Vec3[][] {
  return polygons.flatMap((p) => [p.outer, ...p.holes]).filter((l) => l.length > 1).map((l) => l.map((pt) => frameToBed(frame, pt)))
}

export function applyMat(m: Mat4, [x, y, z]: Vec3): Vec3 {
  return [(m[0] ?? 1) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0), (m[1] ?? 0) * x + (m[5] ?? 1) * y + (m[9] ?? 0) * z + (m[13] ?? 0), (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 1) * z + (m[14] ?? 0)]
}

/** Every part of an object as one mesh, for calls that take a single mesh. */
export function wholeMesh(e: Pick<PlateEntry, 'parts'>): GeomMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const p of e.parts) {
    const base = positions.length / 3
    for (const v of p.positions) positions.push(v)
    for (const i of p.indices) indices.push(i + base)
  }
  return { positions, indices }
}

let seq = 0
const newId = () => `obj_${Date.now().toString(36)}c${(++seq).toString(36)}`

export interface ExtrudeInput {
  frame: FaceFrame
  shape: Shape | FreeShape
  placement: Placement
  spec: ExtrudeSpec
  /** The body the face belongs to; absent on the bed. */
  target?: { objectId: string; partIndex: number }
  fontBase64?: string
  /** The font's name, kept in the history step (the font itself is not). */
  fontName?: string
  /** Name of a new body. */
  name: string
  /** Copies of the shape on its face, in the same step. */
  pattern?: Pattern
}

/** Extrudes the shape: a join or a cut replaces the picked part, a new body becomes an object where it was drawn. One sentence on what happened. */
export async function applyExtrude(host: Loader, input: ExtrudeInput): Promise<{ message: string; warn: boolean }> {
  const operation = input.spec.operation ?? 'new'
  const target = targetOf(input.target, operation)
  const r = await extrudeShape({
    frame: input.frame,
    shape: input.shape,
    placement: input.placement,
    spec: input.spec,
    ...(target ? { target: { mesh: toGeom(target.part), transform: target.entry.transform } } : {}),
    ...(input.fontBase64 ? { fontBase64: input.fontBase64 } : {}),
    ...(input.pattern ? { pattern: input.pattern } : {}),
  })
  return land(host, r, operation, input.target, input.name, extrudeParams(input))
}

/** The history step an extrude records; the font is remembered for this session by name. */
export function extrudeParams(input: ExtrudeInput): StepParams {
  if (input.fontBase64 && input.fontName) rememberFont(input.fontName, input.fontBase64)
  return { op: 'shape.extrude', frame: input.frame, shape: input.shape, placement: input.placement, spec: input.spec, ...(input.fontBase64 && input.fontName ? { font: input.fontName } : {}), name: input.name, ...(input.pattern ? { pattern: input.pattern } : {}) }
}

/** The history step a revolve records. */
export function revolveParams(input: RevolveInput): StepParams {
  return { op: 'sketch.revolve', ...(input.frame ? { frame: input.frame } : {}), loops: input.loops, axis: input.axis, ...(input.angleDeg !== undefined ? { angleDeg: input.angleDeg } : {}), operation: input.operation ?? 'new', name: input.name }
}

export interface RevolveInput extends Omit<RevolveRequest, 'target'> {
  target?: { objectId: string; partIndex: number }
  name: string
}

/** Revolves sketch loops about an axis; lands like an extrude. */
export async function applyRevolve(host: Loader, input: RevolveInput): Promise<{ message: string; warn: boolean }> {
  const operation = input.operation ?? 'new'
  const target = targetOf(input.target, operation)
  const { target: _t, name, ...req } = input
  const r = await revolveSketch({ ...req, ...(target ? { target: { mesh: toGeom(target.part), transform: target.entry.transform } } : {}) })
  return land(host, r, operation, input.target, name, revolveParams(input))
}

function targetOf(t: { objectId: string; partIndex: number } | undefined, operation: string): { entry: PlateEntry; part: MeshPart } | null {
  const entry = t ? get().plate.find((p) => p.id === t.objectId) : undefined
  const part = entry?.parts[t?.partIndex ?? 0]
  if (operation !== 'new' && (!entry || !part)) throw new Error('Pick a face on an object to join to it or cut into it.')
  return operation !== 'new' && entry && part ? { entry, part } : null
}

/** Puts an extrude or revolve result on the plate in one store update, so undo takes it back in one step. */
async function land(host: Loader, r: MeshResult & { frame: 'target' | 'world'; report: ExtrudeReport }, operation: string, t: { objectId: string; partIndex: number } | undefined, name: string, params: StepParams): Promise<{ message: string; warn: boolean }> {
  const entry = t ? get().plate.find((p) => p.id === t.objectId) : undefined
  const part = entry?.parts[t?.partIndex ?? 0]
  const volume = `${Math.abs(r.report.volumeChangeMm3 / 1000).toFixed(2)} cm³`
  if (r.frame === 'target' && entry && part && t) {
    const parts = entry.parts.map((p, i) => (i === t.partIndex ? fromGeom(r.mesh, p.name, p.slot) : p))
    const handle = await host.loadParts(entry.name, parts)
    const { instanceOf: _was, paint: _paint, ...rest } = entry
    // A shape that misses the body changes nothing and is not a step.
    const history = r.report.touches ? withStep(entry, t.partIndex, params) : entry.history
    set({ plate: get().plate.map((p) => (p.id === entry.id ? { ...rest, handle, parts, ...historyField(history) } : p)) })
    markStale()
    if (!r.report.touches) return { message: 'The shape does not reach the body, so nothing changed. Check the distance and the direction.', warn: true }
    return { message: operation === 'cut' ? `Cut ${volume} out of ${entry.name}.` : `Joined ${volume} to ${entry.name}.`, warn: !r.report.watertight }
  }
  // A new body arrives in bed coordinates. It keeps its place: centered on its own X and Y, moved back by its transform.
  const world = fromGeom(r.mesh, name, part?.slot ?? 1)
  const b = bounds([world], identity())
  const cx = b ? (b.min[0] + b.max[0]) / 2 : 0
  const cy = b ? (b.min[1] + b.max[1]) / 2 : 0
  const local = bake(world, compose({ position: [-cx, -cy, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }))
  const handle = await host.loadParts(name, [local])
  const transform = compose({ position: [cx, cy, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  // The body's history starts with the step that made it, so its sketch or shape stays editable.
  const made: PlateEntry = { id: newId(), name, handle, parts: [local], colors: entry?.colors.length ? entry.colors : [brandAccent()], transform, history: bodyHistory(params, transform) }
  set((s) => ({ plate: [...s.plate, made], selection: made.id, selectedIds: [made.id] }))
  markStale()
  return { message: `Added ${name}, ${volume}.`, warn: false }
}

export type ArrayKind = 'linear' | 'grid' | 'circular'

export interface ArrayFields {
  kind: ArrayKind
  /** Linear and circular: copies, the original included. Grid: columns. */
  count: number
  /** Grid: rows. */
  rows: number
  /** Linear: the step between copies. Grid: x is the column step and y the row step. */
  step: Vec3
  /** Circular: the center on the bed. */
  center: Vec2
  angleDeg: number
  rotateCopies: boolean
}

export const MAX_COPIES = 400

/** The engine's spec for the fields, or a sentence on what is wrong with them. */
export function arraySpec(f: ArrayFields): ArraySpec | string {
  const whole = (n: number) => Number.isInteger(n) && n >= 1
  if (!whole(f.count) || (f.kind === 'grid' && !whole(f.rows))) return 'Counts are whole numbers, 1 or more.'
  const total = f.kind === 'grid' ? f.count * f.rows : f.count
  if (total < 2) return 'Ask for at least 2 copies.'
  if (total > MAX_COPIES) return `That is ${total} copies. The most is ${MAX_COPIES}.`
  if (f.kind === 'circular') {
    if (!Number.isFinite(f.angleDeg) || f.angleDeg === 0 || Math.abs(f.angleDeg) > 360) return 'The angle is between -360 and 360 degrees, and not 0.'
    if (!f.center.every(Number.isFinite)) return 'The center needs an X and a Y.'
    return { kind: 'circular', count: f.count, center: [f.center[0], f.center[1], 0], axis: [0, 0, 1], angleDeg: f.angleDeg, rotateCopies: f.rotateCopies }
  }
  if (!f.step.every(Number.isFinite)) return 'The spacing needs a number.'
  if (f.kind === 'grid') {
    if (f.step[0] === 0 || f.step[1] === 0) return 'Both spacings must be more than 0 mm.'
    return { kind: 'linear', count: f.count, step: [f.step[0], 0, 0], count2: f.rows, step2: [0, f.step[1], 0] }
  }
  if (f.step.every((v) => v === 0)) return 'The spacing must be more than 0 mm in at least one direction.'
  return { kind: 'linear', count: f.count, step: f.step }
}

/** Where each copy would stand: its transform and the outline of its box on the bed. */
export async function previewArray(e: PlateEntry, spec: ArraySpec, signal?: AbortSignal): Promise<{ transforms: Mat4[]; overlapping: boolean; footprints: Vec3[][] }> {
  const r = await arrayCopies({ mesh: wholeMesh(e), transform: e.transform }, spec, signal)
  const b = bounds(e.parts, identity())
  const corners: Vec3[] = b ? [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.min[2]]] : []
  return { transforms: r.transforms, overlapping: r.overlapping, footprints: r.transforms.map((t) => corners.map((c) => applyMat(t, c))) }
}

/** Copies as plate instances (they share the mesh), or every copy merged into the object. Returns the number of copies, the original included. */
export async function applyArray(host: Loader, objectId: string, spec: ArraySpec, merge: boolean): Promise<number> {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e) throw new Error('Select an object first.')
  if (merge) {
    let count = 0
    const parts: MeshPart[] = []
    for (const p of e.parts) {
      const r = await arrayMerged({ mesh: toGeom(p), transform: e.transform }, spec)
      parts.push(fromGeom(r.mesh, p.name, p.slot))
      count = r.count
    }
    const handle = await host.loadParts(e.name, parts)
    const { instanceOf: _was, paint: _paint, ...rest } = e
    // Merging copies is a step only in a history the object already has.
    const history = e.history ? withStep(e, -1, { op: 'array.merged', spec }) : undefined
    set({ plate: get().plate.map((p) => (p.id === e.id ? { ...rest, handle, parts, ...historyField(history) } : p)) })
    markStale()
    return count
  }
  const r = await arrayCopies({ mesh: wholeMesh(e), transform: e.transform }, spec)
  const root = sourceId(e)
  // The first transform is the original, which stays where it is.
  // Kept dimensions stay with the original.
  const { dimensions: _d, ...plain } = e
  const copies: PlateEntry[] = r.transforms.slice(1).map((t) => ({ ...plain, id: `${root}~${Date.now().toString(36)}a${(++seq).toString(36)}`, instanceOf: root, transform: [...t] }))
  set((s) => ({ plate: [...s.plate, ...copies] }))
  markStale()
  return r.count
}

const mm = (v: number) => `${v.toFixed(Math.abs(v) < 10 ? 3 : 2)} mm`

/** A picked feature in a few words, with its own size. */
export function describeFeature(f: Feature): string {
  switch (f.kind) {
    case 'point':
      return 'Point'
    case 'edge':
      return `Edge, ${mm(Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1], f.b[2] - f.a[2]))}`
    case 'circle':
      return f.sweepDeg >= 359.5 ? `Circle, diameter ${mm(f.radius * 2)}` : `Arc, radius ${mm(f.radius)}`
    case 'plane':
      return f.areaMm2 > 0 ? 'Flat face' : 'Bed'
    case 'cylinder':
      return `Cylinder, diameter ${mm(f.radius * 2)}`
    case 'surface':
      return 'Curved surface'
  }
}

/** The points that mark a feature in the view. */
export function featurePoints(f: Feature): Vec3[] {
  switch (f.kind) {
    case 'point':
    case 'surface':
      return [f.at]
    case 'edge':
      return [f.a, f.b]
    case 'circle':
      return [f.center]
    case 'plane':
    case 'cylinder':
      return [f.point]
  }
}

export interface ReadoutRow {
  label: string
  value: string
  /** The bare number, for the clipboard. */
  copy: string
}

/** The measurement as rows, the distance first. Fields the engine left out are skipped. */
export function readout(m: Measurement): ReadoutRow[] {
  const rows: ReadoutRow[] = []
  const len = (label: string, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) rows.push({ label, value: mm(v), copy: v.toFixed(3) })
  }
  len('Distance', m.distanceMm)
  if (m.deltaMm && m.distanceMm !== undefined) {
    len('Along X', Math.abs(m.deltaMm[0]))
    len('Along Y', Math.abs(m.deltaMm[1]))
    len('Along Z', Math.abs(m.deltaMm[2]))
  }
  len('Center to center', m.centerDistanceMm)
  if (m.angleDeg !== undefined && Number.isFinite(m.angleDeg)) rows.push({ label: 'Angle', value: m.parallel ? `${m.angleDeg.toFixed(2)}°, parallel` : `${m.angleDeg.toFixed(2)}°`, copy: m.angleDeg.toFixed(2) })
  len('Radius', m.radiusMm)
  len('Diameter', m.diameterMm)
  len('Length', m.lengthMm)
  if (m.areaMm2 !== undefined && m.areaMm2 > 0) rows.push({ label: 'Area', value: `${m.areaMm2.toFixed(2)} mm²`, copy: m.areaMm2.toFixed(2) })
  return rows
}
