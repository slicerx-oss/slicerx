// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull: move a flat face of a body along its normal. Out adds material, in cuts it, and
// pushing past the far side opens a hole. The drag only stretches a preview prism; the boolean runs
// once, on release or Enter, and the new mesh lands in one store update, so undo takes it back in
// one step. A face with a fillet or chamfer on one of its edges in the history is pushed before that
// step and the round made again on the moved edge (docs/cad-history.md). No React in here.
import { typedNumber } from './value-table'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { pickFace, pushFace, type FaceFrame, type FacePick, type MovedFace, type Pick as HitPick, type Polygon, type Vec3 } from '../geom/cad'
import { fromGeom, toGeom } from '../geom/client'
import { applyMat } from './cad-ops'
import { followPush } from './dimensions'
import { findTriangle, followed, followsOf, onFlatFace, stepName, type StepParams } from './history/model'
import { applyHistory, nowOf, runReplay } from './history/ops'
import { settle, withPushBefore, withStep } from './history/record'
import { get, markStale, set, type PlateEntry } from '../state/store'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

/** A picked face, ready to push. */
export interface PushFace {
  objectId: string
  partIndex: number
  /** The pick on the face, bed coordinates. */
  pick: HitPick
  frame: FaceFrame
  outline: Polygon[]
  /** How far the body reaches behind the pick, along the normal; null when the ray leaves no far side. */
  thicknessMm: number | null
}

const fmt = (v: number) => String(Math.round(v * 100) / 100)

/** A typed distance: a number, comma decimals accepted. Null for anything else. */
export function parseDistance(text: string): number | null {
  if (!text.trim()) return null
  const v = typedNumber(text)
  return Number.isFinite(v) ? v : null
}

/** What a push of `d` mm does, in words. */
export function pushWords(d: number | null, thicknessMm: number | null): string {
  if (d === null || d === 0) return 'Drag the face, or type a distance: positive pulls out, negative pushes in.'
  if (d > 0) return `Adds ${fmt(d)} mm`
  if (thicknessMm !== null && -d >= thicknessMm - 1e-6) return 'Opens a hole'
  return `Cuts ${fmt(-d)} mm`
}

/** Whether a bed point and normal lie on the face. */
export function onFace(face: Pick<PushFace, 'frame'>, point: Vec3, normal: Vec3): boolean {
  const n = face.frame.normal
  const o = face.frame.origin
  const along = (point[0] - o[0]) * n[0] + (point[1] - o[1]) * n[1] + (point[2] - o[2]) * n[2]
  return n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] > 0.9999 && Math.abs(along) < 0.01
}

/**
 * How far the body reaches behind `point`, straight against `normal` (bed coordinates): the nearest
 * triangle the inward ray crosses. One pass over the mesh, run once per picked face.
 */
export function throughThickness(part: Pick<MeshPart, 'positions' | 'indices'>, transform: readonly number[], point: Vec3, normal: Vec3): number | null {
  const d: Vec3 = [-normal[0], -normal[1], -normal[2]]
  const p = part.positions
  const w = (i: number): Vec3 => applyMat(transform as number[], [p[3 * i] ?? 0, p[3 * i + 1] ?? 0, p[3 * i + 2] ?? 0])
  let best = Infinity
  const ix = part.indices
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = w(ix[t]!)
    const b = w(ix[t + 1]!)
    const c = w(ix[t + 2]!)
    // Moller and Trumbore.
    const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const q: Vec3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
    const det = e1[0] * q[0] + e1[1] * q[1] + e1[2] * q[2]
    if (Math.abs(det) < 1e-12) continue
    const s: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]]
    const u = (s[0] * q[0] + s[1] * q[1] + s[2] * q[2]) / det
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const r: Vec3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
    const v = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / det
    if (v < -1e-9 || u + v > 1 + 1e-9) continue
    const dist = (e2[0] * r[0] + e2[1] * r[1] + e2[2] * r[2]) / det
    // The face itself sits at 0.
    if (dist > 1e-4 && dist < best) best = dist
  }
  return Number.isFinite(best) ? best : null
}

/** The flat face under a click on an object, with the body's thickness behind it. */
export async function pickPushFace(objectId: string, partIndex: number, pick: HitPick, signal?: AbortSignal): Promise<PushFace> {
  const e = get().plate.find((p) => p.id === objectId)
  const part = e?.parts[partIndex]
  if (!e || !part) throw new Error('That object is gone. Pick a face again.')
  const f = await pickFace({ mesh: toGeom(part), transform: e.transform }, pick, signal)
  return { objectId, partIndex, pick, frame: f.frame, outline: f.outline, thicknessMm: throughThickness(part, e.transform, pick.at, f.frame.normal) }
}

type PushParams = Extract<StepParams, { op: 'face.push' }>

/**
 * The first fillet or chamfer step of the part whose edge lies on the rim of the picked face as that
 * face was before the step, with the face then. Null when there is none, and the push goes at the end.
 * A round whose edge only ends on the face (a rounded corner of a top) is not one: the face's outline
 * already carries it, and the push keeps it.
 */
async function roundedFrom(entry: PlateEntry, face: PushFace): Promise<{ index: number; face: FacePick } | null> {
  const h = entry.history
  if (!h) return null
  const steps = settle(h.steps)
  const plane = (p: Vec3) => {
    const o = face.pick.at
    const n = face.frame.normal
    return Math.abs((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]) < 0.01
  }
  for (let j = 0; j < steps.length; j++) {
    const s = steps[j]!
    if (s.suppressed || s.part !== face.partIndex || (s.params.op !== 'edge.fillet' && s.params.op !== 'edge.chamfer')) continue
    const q = followed(s, steps).params
    if (q.op !== 'edge.fillet' && q.op !== 'edge.chamfer') continue
    const now = nowOf(s, entry.transform)
    const edges = q.edges.map((e) => [now.point(e.a), now.point(e.b)] as const).filter(([a, b]) => plane(a) && plane(b))
    if (!edges.length) continue
    // The face as it was before that step, where the edge was still sharp.
    const r = await runReplay({ history: { ...h, steps }, before: j })
    const part = r.before?.[face.partIndex]
    if (!part) continue
    const tri = findTriangle(part, entry.transform, face.pick.at, face.frame.normal)
    if (tri < 0) continue
    const f = await pickFace({ mesh: { positions: Array.from(part.positions), indices: Array.from(part.indices) }, transform: entry.transform }, { triangle: tri, at: face.pick.at })
    const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    if (edges.some(([a, b]) => [a, b, mid(a, b)].every((p) => onFlatFace(p, f).rim))) return { index: j, face: f }
  }
  return null
}

/** The signed volume of a part in its own frame, mm³. */
function volumeOf(m: Pick<MeshPart, 'positions' | 'indices'>): number {
  const p = m.positions
  const ix = m.indices
  let v = 0
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = 3 * ix[t]!
    const b = 3 * ix[t + 1]!
    const c = 3 * ix[t + 2]!
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return v / 6
}

/** The push placed before the round it touches, and the steps from there run again, in one store update. */
async function pushBeforeRound(host: Loader, entry: PlateEntry, face: PushFace, params: PushParams, at: { index: number; face: FacePick }): Promise<{ message: string; warn: boolean; moved: MovedFace }> {
  const history = withPushBefore(entry, face.partIndex, params, at.index, at.face)
  const id = history.steps[at.index]!.id
  const r = await applyHistory(host, entry.id, history, id)
  const after = get().plate.find((p) => p.id === entry.id)
  const t = entry.transform
  const scale = Math.abs(t[0]! * (t[5]! * t[10]! - t[9]! * t[6]!) - t[4]! * (t[1]! * t[10]! - t[9]! * t[2]!) + t[8]! * (t[1]! * t[6]! - t[5]! * t[2]!))
  const before = entry.parts[face.partIndex]!
  const change = after?.parts[face.partIndex] ? (volumeOf(after.parts[face.partIndex]!) - volumeOf(before)) * scale : 0
  const volume = `${Math.abs(change / 1000).toFixed(2)} cm³`
  const rounds = history.steps.slice(at.index + 1).filter((s) => !s.suppressed && (s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer') && followsOf(s).some((f) => f.step === id))
  const kinds = new Set(rounds.map((s) => s.params.op))
  const what = kinds.size > 1 ? 'fillets and chamfers' : `${kinds.has('edge.chamfer') ? 'chamfer' : 'fillet'}${rounds.length > 1 ? 's' : ''}`
  let message = `${params.distanceMm > 0 ? `Added ${volume} to` : `Cut ${volume} out of`} ${entry.name}. The ${what} along that face ${rounds.length > 1 ? 'were' : 'was'} made again on the moved edge.`
  const k = r.status.findIndex((s) => s.state === 'broken')
  const broken = k >= 0 ? history.steps[k] : undefined
  if (broken) message += ` Step ${k + 1}, ${stepName(broken)}, no longer works: ${r.status[k]!.message ?? 'it failed.'}`
  return { message, warn: Boolean(broken), moved: r.moved[id]! }
}

/** Runs the push: the part is replaced by the result in one store update. One sentence on what happened, and the moved face. */
export async function applyPush(host: Loader, face: PushFace, distanceMm: number): Promise<{ message: string; warn: boolean; moved: MovedFace }> {
  const entry = get().plate.find((p) => p.id === face.objectId)
  const part = entry?.parts[face.partIndex]
  if (!entry || !part) throw new Error('That object is gone. Pick a face again.')
  const params: PushParams = { op: 'face.push', at: face.pick.at, normal: face.frame.normal, distanceMm }
  const rounded = await roundedFrom(entry, face)
  if (rounded) return pushBeforeRound(host, entry, face, params, rounded)
  const r = await pushFace({ mesh: { mesh: toGeom(part), transform: entry.transform }, pick: face.pick, distanceMm })
  const parts = entry.parts.map((p, i) => (i === face.partIndex ? fromGeom(r.mesh, p.name, p.slot) : p))
  const handle = await host.loadParts(entry.name, parts)
  // Paint was per triangle of the old mesh and an instance no longer shares it.
  const { instanceOf: _was, paint: _paint, ...rest } = entry
  // The push is a step of the object's history: the pick and the distance, as given.
  const history = withStep(entry, face.partIndex, params)
  const next: PlateEntry = { ...rest, handle, parts, history }
  // Kept dimensions on the pushed face follow it, in the same undo step as the push.
  const plate = await followPush(get().plate.map((p) => (p.id === entry.id ? next : p)), entry.id, r.moved)
  set({ plate })
  markStale()
  const volume = `${Math.abs(r.report.volumeChangeMm3 / 1000).toFixed(2)} cm³`
  const message = r.operation === 'join' ? `Added ${volume} to ${entry.name}.` : `Cut ${volume} out of ${entry.name}.`
  return { message: r.shells > 1 ? `${message} It is now ${r.shells} separate pieces.` : message, warn: !r.watertight || r.shells > 1, moved: r.moved }
}
