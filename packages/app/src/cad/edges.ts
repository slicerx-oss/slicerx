// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the fillet and chamfer tool does to the plate, with no React: picked edges as a set, the
// step's params, and the op landing in one store update as a step of the object's history.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { Vec3 } from '../geom/cad'
import { fromGeom, toGeom } from '../geom/client'
import { get, markStale, set } from '../state/store'
import { edgeOp, type EdgeRef } from './edge-api'
import type { StepParams } from './history/model'
import { withStep } from './history/record'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

export type Kind = 'fillet' | 'chamfer'

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** How far a point is from an edge, in mm. */
export function edgeDistance(p: Vec3, e: Pick<EdgeRef, 'a' | 'b'>): number {
  const ab = sub(e.b, e.a)
  const l2 = dot(ab, ab)
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, e.a), ab) / l2)) : 0
  const q: Vec3 = [e.a[0] + ab[0] * t, e.a[1] + ab[1] * t, e.a[2] + ab[2] * t]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

/** The same edge, either way round, within 0.001 mm. */
export function sameEdge(x: Pick<EdgeRef, 'a' | 'b'>, y: Pick<EdgeRef, 'a' | 'b'>): boolean {
  const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-3
  return (near(x.a, y.a) && near(x.b, y.b)) || (near(x.a, y.b) && near(x.b, y.a))
}

/** Picks with one more edge (Shift adds, a plain click replaces); a picked edge clicked again with Shift comes off. */
export function addEdge(edges: readonly EdgeRef[], e: EdgeRef, shift: boolean): EdgeRef[] {
  if (!shift) return [e]
  return edges.some((x) => sameEdge(x, e)) ? edges.filter((x) => !sameEdge(x, e)) : [...edges, e]
}

/** The engine's edge op name and size fields for a kind and typed sizes. */
export function edgeParams(kind: Kind, edges: EdgeRef[], size: number, size2: number | null): StepParams {
  return kind === 'fillet' ? { op: 'edge.fillet', edges, radiusMm: size } : { op: 'edge.chamfer', edges, distanceMm: size, ...(size2 !== null ? { distance2Mm: size2 } : {}) }
}

/** Runs the op on the part and lands it in one store update, recorded as a history step. One sentence on what happened. */
export async function applyEdges(host: Loader, objectId: string, partIndex: number, params: StepParams): Promise<{ message: string; warn: boolean }> {
  if (params.op !== 'edge.fillet' && params.op !== 'edge.chamfer') throw new Error('Not an edge step.')
  const e = get().plate.find((p) => p.id === objectId)
  const part = e?.parts[partIndex]
  if (!e || !part) throw new Error('That object is gone.')
  const profile = params.op === 'edge.fillet' ? { kind: 'fillet' as const, radiusMm: params.radiusMm } : { kind: 'chamfer' as const, distanceMm: params.distanceMm, ...(params.distance2Mm !== undefined ? { distance2Mm: params.distance2Mm } : {}) }
  const r = await edgeOp({ mesh: { mesh: toGeom(part), transform: e.transform }, edges: params.edges, profile })
  const parts = e.parts.map((p, i) => (i === partIndex ? fromGeom(r.mesh, p.name, p.slot) : p))
  const handle = await host.loadParts(e.name, parts)
  const { instanceOf: _was, paint: _paint, ...rest } = e
  const history = withStep(e, partIndex, params)
  set({ plate: get().plate.map((p) => (p.id === e.id ? { ...rest, handle, parts, history } : p)) })
  markStale()
  const n = params.edges.length
  return { message: `${params.op === 'edge.fillet' ? 'Rounded' : 'Beveled'} ${n} ${n === 1 ? 'edge' : 'edges'} of ${e.name}.`, warn: !r.watertight }
}
