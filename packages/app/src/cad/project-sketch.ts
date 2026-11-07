// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model geometry projected into a sketch (cad-history project.ts): edges, a face's outline or a body's outline. A
// projection reads its source as the body stands at the sketch's place in the timeline, and follows it: whenever a
// body replays, the projections from it are found again, and the bodies drawn on a sketch whose curves moved replay
// in turn, in the same undo step as the edit that moved them.
import { followProjections, historyOf, keyOfTriangle, nextProjectionId, point, resolveProjection, withProjection, withoutProjection, type HistoryMesh, type PartsAt, type ProjectMode, type ProjectSource, type SketchItem, type SketchLoop, type Timeline, type Vec3 } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { geom, toGeom } from '../geom/client'
import { pickEdge } from '../geom/cad'
import { get, type PlateEntry } from '../state/store'
import { runReplay } from './history/ops'
import { sketchById, updateSketch, type SketchBody } from './sketches'

type Loader = { loadParts(name: string, parts: PlateEntry['parts']): Promise<MeshHandle> }

const call = (op: string, req: unknown): Promise<unknown> => geom().call(op, req)

/** Where each body stands before item `at` of timeline `t`: its history replayed that far, or its parts when it has none. */
export function partsAt(t: Timeline): PartsAt {
  return async (body, at) => {
    const e = get().plate.find((p) => p.id === body)
    if (!e) return null
    const h = t.bodies.some((b) => b.id === body) ? historyOf({ ...t, marker: Math.min(at, t.marker) }, body) : null
    if (!h) return { parts: e.parts as HistoryMesh[], transform: e.transform }
    if (!h.steps.length) return { parts: h.base, transform: e.transform }
    const r = await runReplay({ history: h })
    return { parts: r.parts, transform: e.transform }
  }
}

/** A finished sketch as updateSketch takes it. */
export function bodyOf(k: SketchItem): SketchBody {
  return { frame: k.frame, loops: k.loops, constraints: k.constraints as SketchBody['constraints'], on: k.on, projections: k.projections ?? [] }
}

let running = false
const waiting = new Set<string>()

/**
 * After bodies replayed: the projections from them found again, and the bodies drawn on a sketch that changed replayed
 * in turn, until nothing moves. A call while one runs adds its bodies to it.
 */
export async function followBodies(host: Loader, bodies: Iterable<string>): Promise<void> {
  for (const b of bodies) waiting.add(b)
  if (running) return
  running = true
  try {
    // each round goes one sketch further down the timeline; a projection never reads a body after its sketch
    for (let round = 0; waiting.size && round < 64; round++) {
      const only = new Set(waiting)
      waiting.clear()
      const t = get().timeline
      if (!t.items.some((i) => i.kind === 'sketch' && i.projections?.some((p) => only.has(p.source.body)))) continue
      const r = await followProjections(t, partsAt(t), call, only)
      for (const id of r.changed) {
        const k = sketchById(r.timeline, id)
        if (!k) continue
        // a sketch that leaves a body with nothing keeps its old curves; the person sees the note on the projection
        await updateSketch(host, id, bodyOf(k), { join: true }).catch(() => undefined)
      }
    }
  } finally {
    running = false
  }
}

/** The curves `source` gives on `frame` from the body as it stands at the timeline's marker, for a sketch not finished yet. */
export async function projectNow(source: ProjectSource, frame: SketchItem['frame']): Promise<SketchLoop[]> {
  const t = get().timeline
  const at = await partsAt(t)(source.body, t.marker)
  if (!at) throw new Error('That body is no longer on the plate.')
  const r = await resolveProjection(call, source, at.parts, at.transform, frame)
  if ('lost' in r) throw new Error(r.lost)
  return r.loops
}

/** Projects `source` into finished sketch `id`; the bodies drawn on it replay. Throws why the source gives no curves. */
export async function addProjection(host: Loader, id: string, source: ProjectSource, mode: ProjectMode): Promise<{ sketch: SketchItem; projection: string; replayed: number }> {
  const t = get().timeline
  const k = sketchById(t, id)
  if (!k) throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
  const at = await partsAt(t)(source.body, t.items.indexOf(k))
  if (!at) throw Object.assign(new Error(`design: no body ${source.body} on the plate; design.list lists them`), { code: 'not_found' })
  const r = await resolveProjection(call, source, at.parts, at.transform, k.frame)
  if ('lost' in r) throw Object.assign(new Error(r.lost), { code: 'invalid_input' })
  const pid = nextProjectionId(k)
  const u = await updateSketch(host, id, bodyOf(withProjection(k, { id: pid, source, mode }, r.loops)))
  return { sketch: sketchById(get().timeline, id)!, projection: pid, replayed: u.replayed }
}

/** Switches a projection between reference and real, or takes it out with its curves; the bodies drawn on the sketch replay. */
export async function changeProjection(host: Loader, id: string, projection: string, change: { mode: ProjectMode } | { remove: true }): Promise<{ sketch: SketchItem; replayed: number }> {
  const k = sketchById(get().timeline, id)
  if (!k) throw Object.assign(new Error(`No finished sketch ${id} in the design timeline; slicerx_design_timeline lists them.`), { code: 'not_found' })
  const p = k.projections?.find((x) => x.id === projection)
  if (!p) throw Object.assign(new Error(`projection: ${k.name} has no projection ${projection}`), { code: 'not_found' })
  const next = 'remove' in change ? withoutProjection(k, projection) : withProjection(k, { ...p, mode: change.mode }, null)
  const u = await updateSketch(host, id, bodyOf(next))
  return { sketch: sketchById(get().timeline, id)!, replayed: u.replayed }
}

/** The face under a pick as a projection source: its key, and its point and normal in world mm. */
export function faceSource(e: Pick<PlateEntry, 'id' | 'parts' | 'transform'>, part: number, triangle: number, at: Vec3): ProjectSource {
  const m = e.parts[part]!
  const corner = (k: number): Vec3 => point(e.transform, m.positions, 3 * m.indices[3 * triangle + k]!)
  const [a, b, c] = [corner(0), corner(1), corner(2)]
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n: Vec3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
  const l = Math.hypot(...n) || 1
  const key = keyOfTriangle(m, triangle)
  return { kind: 'face', body: e.id, part, transform: [...e.transform], face: { at, normal: [n[0] / l, n[1] / l, n[2] / l], ...(key ? { key } : {}) } }
}

/** The edge under a pick as a projection source, or that edge added to `to` when it is edges of the same part. */
export async function edgeSource(e: Pick<PlateEntry, 'id' | 'parts' | 'transform'>, part: number, triangle: number, at: Vec3, to?: ProjectSource): Promise<ProjectSource> {
  const r = await pickEdge({ mesh: toGeom(e.parts[part]!), transform: e.transform }, { triangle, at })
  if (to?.kind === 'edges' && to.body === e.id && to.part === part) return { ...to, edges: [...to.edges, r.edge] }
  return { kind: 'edges', body: e.id, part, transform: [...e.transform], edges: [r.edge] }
}

/** The whole body as a projection source. */
export const bodySource = (e: Pick<PlateEntry, 'id'>): ProjectSource => ({ kind: 'silhouette', body: e.id })

/** What a projection is, in a few words: "Face of Box", "3 edges of Box", "Outline of Box". */
export function projectionName(source: ProjectSource): string {
  const name = get().plate.find((p) => p.id === source.body)?.name ?? 'a body that is gone'
  if (source.kind === 'face') return `Face of ${name}`
  if (source.kind === 'silhouette') return `Outline of ${name}`
  return `${source.edges.length === 1 ? 'Edge' : `${source.edges.length} edges`} of ${name}`
}
