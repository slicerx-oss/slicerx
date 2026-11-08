// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model geometry projected into a finished sketch (docs/cad-history.md, "Projections"): picked edges, a face's
// outline, or a body's outline seen along the sketch normal. The curves are plain loops at the end of the sketch's
// loops, each naming its projection, so everything that reads sketch loops takes them unchanged. A projection keeps
// its source in the references the history already uses, and is found again on the source as it stands at the
// sketch's place in the timeline. A source that is gone leaves the curves where they were and says why.
import type { Item, SketchItem, Timeline } from './design'
import { frameNow, type PlaceOf } from './design-frame'
import { direction, invert, point, type HistoryMesh, type Mat4 } from './model'
import { engineReason, type EngineCall } from './replay'
import type { EdgeRef, FaceFrame, OpenFace, SketchLoop, Vec3 } from './types'

/** What a projection comes from. Points and normals are world mm at `transform`, the body's when it was picked. */
export type ProjectSource =
  | { kind: 'edges'; body: string; part: number; transform: Mat4; edges: EdgeRef[] }
  | { kind: 'face'; body: string; part: number; transform: Mat4; face: OpenFace }
  /** Every part of the body, seen along the sketch normal. */
  | { kind: 'silhouette'; body: string }

export type ProjectMode = 'reference' | 'real'

export interface Projection {
  /** p1, p2 and on, within its sketch. */
  id: string
  source: ProjectSource
  /** Reference curves are construction: drawn, never a profile. Real ones close profiles. */
  mode: ProjectMode
  /** Why the source was not found on the last replay; the curves stay where they were. */
  lost?: string
}

const BED: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** What a lost body says. */
export const BODY_GONE = 'The body this projected is gone; project it again or remove it.'

/** The loops projection `id` put in the sketch. */
export const projectedOf = (loops: readonly SketchLoop[], id: string): SketchLoop[] => loops.filter((l) => l.projected === id)

/** A sketch's own loops, without any projection's. */
export const ownLoops = (loops: readonly SketchLoop[]): SketchLoop[] => loops.filter((l) => l.projected === undefined)

/** Loops as a projection puts them in: named, and construction when it is reference. */
export function tagged(loops: readonly SketchLoop[], id: string, mode: ProjectMode): SketchLoop[] {
  return loops.map((l) => {
    const { construction: _c, projected: _p, ...rest } = l as SketchLoop & { construction?: true; projected?: string }
    return { ...rest, projected: id, ...(mode === 'reference' ? { construction: true } : {}) } as SketchLoop
  })
}

/**
 * Projection ids of a sketch count up from p1 and stay under this, in the editor and in a file alike, so every id
 * handed out is one the count can see. A sketch that has handed out p999999 takes no more projections.
 */
export const MAX_PROJECTION = 1_000_000

/** What a sketch that has handed out every projection id says. */
export const TOO_MANY_PROJECTIONS = 'This sketch has too many projections; project into a new sketch.'

/** The number in a projection id; 0 for one that is not an id, or at or past the cap. */
export const idNumber = (id: unknown): number => {
  const n = typeof id === 'string' ? Number(/^p(\d{1,7})$/.exec(id)?.[1] ?? 0) : 0
  return n < MAX_PROJECTION ? n : 0
}

/**
 * The next projection id of a sketch. Ids only count up: one that was removed, or whose projection a file lost, is
 * never handed out again, since an extrude made with it still names it. An id the sketch already holds is skipped,
 * and a sketch past the cap is refused.
 */
export function nextProjectionId(k: Pick<SketchItem, 'projections' | 'loops' | 'nextProjection'>): string {
  let n = k.nextProjection !== undefined && k.nextProjection < MAX_PROJECTION ? k.nextProjection : 0
  const held = new Set<string>()
  for (const p of k.projections ?? []) {
    held.add(p.id)
    n = Math.max(n, idNumber(p.id))
  }
  for (const l of k.loops) {
    if (l.projected !== undefined) held.add(l.projected)
    n = Math.max(n, idNumber(l.projected))
  }
  while (held.has(`p${n + 1}`)) n++
  if (n + 1 >= MAX_PROJECTION) throw Object.assign(new Error(TOO_MANY_PROJECTIONS), { code: 'invalid_input' })
  return `p${n + 1}`
}

/**
 * The sketch with projection `p` put in or replaced, its curves `loops` (left as they were when null), in its mode.
 * Projected loops follow the sketch's own, in projection order, so constraint indices never move.
 */
export function withProjection(k: SketchItem, p: Projection, loops: readonly SketchLoop[] | null): SketchItem {
  const list = k.projections ?? []
  const projections = list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]
  const curves = (x: Projection) => tagged(x.id === p.id && loops ? loops : projectedOf(k.loops, x.id), x.id, x.mode)
  const n = Math.max(k.nextProjection ?? 0, idNumber(p.id))
  return { ...k, loops: [...ownLoops(k.loops), ...projections.flatMap(curves)], projections, ...(n ? { nextProjection: n } : {}) }
}

/** The sketch without projection `id` and its curves; its id stays counted. */
export function withoutProjection(k: SketchItem, id: string): SketchItem {
  const { projections: _p, ...rest } = k
  const left = (k.projections ?? []).filter((x) => x.id !== id)
  const n = Math.max(k.nextProjection ?? 0, idNumber(id))
  return { ...rest, loops: k.loops.filter((l) => l.projected !== id), ...(left.length ? { projections: left } : {}), ...(n ? { nextProjection: n } : {}) }
}

/** The items with the features on sketch `sketch` no longer naming projections it has dropped (none left in `kept`). */
export function withoutTaken(items: readonly Item[], sketch: string, kept: ReadonlySet<string>): Item[] {
  return items.map((i) => {
    if (i.kind !== 'feature' || i.sketch !== sketch || !i.projected?.some((id) => !kept.has(id))) return i
    const { projected, ...f } = i
    const left = projected.filter((id) => kept.has(id))
    return left.length ? { ...f, projected: left } : f
  })
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** The engine request that projects `source` from the body's parts (in their own frame, standing at `transform`) onto `frame`. */
export function projectRequest(source: ProjectSource, parts: readonly HistoryMesh[], transform: Mat4, frame: FaceFrame | undefined): Record<string, unknown> {
  const items = parts.map((m) => ({ mesh: { positions: Array.from(m.positions), indices: Array.from(m.indices), ...(m.faces ? { faces: { ...m.faces, ids: Array.from(m.faces.ids) } } : {}) }, transform }))
  const base = { parts: items, frame: frame ?? BED }
  if (source.kind === 'silhouette') return { ...base, source: { kind: 'silhouette' } }
  // the saved world points back in the part's own frame, so a body moved since still finds them
  const back = invert(source.transform)
  if (source.kind === 'face') {
    const f = source.face
    return { ...base, source: { kind: 'face', part: source.part, face: { at: point(back, f.at), normal: unit(direction(back, f.normal)), ...(f.key ? { key: f.key } : {}) } } }
  }
  const edges = source.edges.map((e) => ({ a: point(back, e.a), b: point(back, e.b), face: unit(direction(back, e.face)), ...(e.center ? { center: point(back, e.center) } : {}), ...(e.keys ? { keys: e.keys } : {}) }))
  return { ...base, source: { kind: 'edges', part: source.part, edges } }
}

/** The curves `source` gives on the sketch plane, or why it was not found. */
export async function resolveProjection(call: EngineCall, source: ProjectSource, parts: readonly HistoryMesh[], transform: Mat4, frame: FaceFrame | undefined): Promise<{ loops: SketchLoop[] } | { lost: string }> {
  if (!parts.length) return { lost: BODY_GONE }
  try {
    const r = (await call('sketch.project', projectRequest(source, parts, transform, frame))) as { loops: SketchLoop[] }
    return { loops: r.loops }
  } catch (e) {
    return { lost: engineReason(e) }
  }
}

/** The body as it stands at a place in the timeline (before item `at`): its parts in their own frame and its transform; null when it is gone. */
export type PartsAt = (body: string, at: number) => Promise<{ parts: HistoryMesh[]; transform: Mat4 } | null>

/**
 * Every live sketch's projections found again on their sources as they stand at the sketch, in timeline order, from
 * the bodies in `only` when it is given, each onto the sketch's plane where it stands now (frameNow, with `plateOf`;
 * without it, where it is stored). A lost source keeps its curves and says why; one found again loses the note.
 * Returns the timeline and the sketches whose curves or notes changed; unchanged, it is the same timeline.
 */
export async function followProjections(t: Timeline, partsAt: PartsAt, call: EngineCall, only?: ReadonlySet<string>, plateOf?: PlaceOf): Promise<{ timeline: Timeline; changed: string[] }> {
  let items = t.items
  const changed: string[] = []
  const live = Math.min(t.marker, t.items.length)
  for (let i = 0; i < live; i++) {
    const k = items[i]!
    if (k.kind !== 'sketch' || !k.projections?.length) continue
    let next = k
    for (const p of k.projections) {
      if (only && !only.has(p.source.body)) continue
      const at = await partsAt(p.source.body, i)
      const r = at ? await resolveProjection(call, p.source, at.parts, at.transform, plateOf ? frameNow(t, k, plateOf) : k.frame) : { lost: BODY_GONE }
      const { lost: _l, ...plain } = p
      next = 'loops' in r ? withProjection(next, plain, r.loops) : withProjection(next, { ...plain, lost: r.lost }, null)
    }
    if (JSON.stringify([next.loops, next.projections]) === JSON.stringify([k.loops, k.projections])) continue
    const was = k
    items = items.map((x) => (x === was ? next : x))
    changed.push(k.id)
  }
  return { timeline: changed.length ? { ...t, items } : t, changed }
}

/** A sketch's projections as a client reads them back: each with its source, mode, curves and note. */
export function projectionsOut(k: SketchItem): Record<string, unknown>[] {
  return (k.projections ?? []).map((p) => ({
    id: p.id,
    kind: p.source.kind,
    body: p.source.body,
    ...(p.source.kind !== 'silhouette' ? { part: p.source.part } : {}),
    mode: p.mode,
    loops: projectedOf(k.loops, p.id).map((l) => {
      const { projected: _p, ...rest } = l as SketchLoop & { projected?: string }
      return rest
    }),
    ...(p.lost ? { lost: p.lost } : {}),
  }))
}

/** The kinds of curve in some loops, for a summary: "1 circle, 4 lines". */
export function curveWords(loops: readonly SketchLoop[]): string {
  const n = { circle: 0, line: 0, arc: 0, spline: 0 }
  for (const l of loops) {
    if ('type' in l && l.type === 'circle') n.circle++
    else if ('type' in l && l.type === 'spline') n.spline++
    else if ('segments' in l) for (const s of l.segments) n[s.type]++
    else if ('points' in l) n.line += Math.max(0, l.points.length - 1)
  }
  const words = Object.entries(n).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}${c === 1 ? '' : 's'}`)
  return words.join(', ') || 'no curves'
}
