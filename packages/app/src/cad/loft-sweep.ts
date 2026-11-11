// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Loft and Sweep panels decide, with no React: which finished sketch can be a profile or a path and why not,
// the picked list (add, take off, move up and down), an edge chain as a path, the reasons the primary is off, and the
// match from a saved step's profiles back to the timeline sketches they were copied from.
import { pathStart, profileOffPathMm, type FaceFrame, type LoftProfile, type SketchItem, type SketchLoop, type SweepPath, type Vec3 } from '@slicerx/cad-history'
import type { EdgeRef } from './edge-api'
import { edgeLines } from './edges'
import { fromLoops } from './sketch-model'
import type { SolidTool } from './sketch-gates'

export type { SolidTool } from './sketch-gates'
export { sketchesOff } from './sketch-gates'

/** The loops that make shapes: construction loops are left out. */
const solidLoops = (k: Pick<SketchItem, 'loops'>): SketchLoop[] => k.loops.filter((l) => !l.construction)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Finished sketch `k` as a profile on `frame` (where it stands now), or why it cannot be one: a profile is exactly one
 * closed loop. The profile keeps its own copy of the loop.
 */
export function profileOf(k: Pick<SketchItem, 'name' | 'loops'>, frame: FaceFrame, tool: SolidTool): { profile: LoftProfile } | { why: string } {
  const loops = solidLoops(k)
  if (!loops.length) return { why: `${k.name} has nothing drawn in it to use as a profile.` }
  if (loops.length > 1) return { why: `${k.name} has ${plural(loops.length, 'loop', 'loops')}; a ${tool} profile is one closed loop.` }
  const e = fromLoops(loops)?.[0]
  if (e && e.kind === 'chain' && !e.closed) return { why: `${k.name} is an open line; a ${tool} profile is one closed loop.` }
  return { profile: { frame: copy(frame), loops: copy(loops) } }
}

/** Finished sketch `k` as a sweep path on `frame`, or why it cannot be one: a path is exactly one open line. */
export function pathOf(k: Pick<SketchItem, 'name' | 'loops'>, frame: FaceFrame): { path: SweepPath } | { why: string } {
  const loops = solidLoops(k)
  if (!loops.length) return { why: `${k.name} has nothing drawn in it to sweep along.` }
  if (loops.length > 1) return { why: `${k.name} has ${plural(loops.length, 'loop', 'loops')}; a sweep path is one open line.` }
  // a loop the sketch tools cannot draw (segments given by length and angle) is left to the engine to judge
  const e = fromLoops(loops)?.[0]
  const closed = e ? e.kind !== 'chain' || e.closed : !('start' in loops[0]!)
  if (closed) return { why: `${k.name} is closed; a sweep path is one open line with two ends.` }
  return { path: { frame: copy(frame), loops: copy(loops) } }
}

const near = (a: Vec3, b: Vec3, tol = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol

/**
 * A picked edge and the edges that run on from it smoothly, as a path of points in bed coordinates, or why not: a chain
 * that goes all the way round has no ends. With `profileAt`, the path starts at the end nearer it.
 */
export function edgePathOf(chain: readonly Pick<EdgeRef, 'a' | 'b' | 'face' | 'center'>[], profileAt?: Vec3): { path: SweepPath } | { why: string } {
  let pts: Vec3[] = []
  for (const e of chain) {
    const seg = edgeLines(e).flatMap((l, i) => (i === 0 ? [l.from, l.to] : [l.to]))
    if (!seg.length) continue
    // each edge may run either way round: join it at the end it shares with the path so far
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (!first || !last || near(seg[0]!, last)) pts.push(...seg)
    else if (near(seg[seg.length - 1]!, last)) pts.push(...seg.reverse())
    else if (near(seg[seg.length - 1]!, first)) pts = [...seg, ...pts]
    else if (near(seg[0]!, first)) pts = [...seg.reverse(), ...pts]
    else pts.push(...seg)
  }
  const out = pts.filter((p, i) => i === 0 || !near(p, pts[i - 1]!))
  if (out.length < 2) return { why: 'That edge is too short to sweep along. Pick a longer one.' }
  if (near(out[0]!, out[out.length - 1]!)) return { why: 'That edge goes all the way round; a sweep path has two ends. Pick an open edge or a sketch.' }
  if (profileAt) {
    const d = (p: Vec3) => Math.hypot(p[0] - profileAt[0], p[1] - profileAt[1], p[2] - profileAt[2])
    if (d(out[out.length - 1]!) < d(out[0]!)) out.reverse()
  }
  return { path: { points: out.map((p) => [p[0], p[1], p[2]] as Vec3) } }
}

/** The middle of a profile's loop on the bed, for which end of an edge path it sits at. */
export function profileMiddle(p: LoftProfile): Vec3 | undefined {
  const f = p.frame ?? { origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 }
  const uv: [number, number][] = []
  for (const l of p.loops) {
    if ('type' in l && l.type === 'circle') uv.push([l.center[0], l.center[1]])
    else if ('points' in l) uv.push(...l.points.map((q) => [q[0], q[1]] as [number, number]))
    else if ('start' in l) uv.push([l.start[0], l.start[1]], ...l.segments.flatMap((g) => ('to' in g && g.to ? [[g.to[0], g.to[1]] as [number, number]] : [])))
  }
  if (!uv.length) return undefined
  const c = [uv.reduce((s, q) => s + q[0], 0) / uv.length, uv.reduce((s, q) => s + q[1], 0) / uv.length] as const
  return [0, 1, 2].map((k) => f.origin[k]! + f.u[k]! * c[0] + f.v[k]! * c[1]) as Vec3
}

/**
 * Why the profile sits too far from the path's start to sweep, in the panel's words with the real distance, or null.
 * The design tools word the same check for a client (packages/mcp).
 */
export function offPathWords(profile: LoftProfile, path: SweepPath): string | null {
  const start = pathStart(path)
  if (!start) return null
  const off = profileOffPathMm(profile.frame, profile.loops, start)
  return off === null ? null : `The profile sits ${Math.round(off)} mm from where the path starts. Move it onto the path's start.`
}

/** A click on a sketch: a picked one comes off the list, any other goes on the end. */
export function togglePick(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

/** The list with item `i` moved one place up (-1) or down (1); unchanged at either end. */
export function movePick<T>(list: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list]
  const out = [...list]
  ;[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}

/** The list without item `i`. */
export function removePick<T>(list: readonly T[], i: number): T[] {
  return list.filter((_, k) => k !== i)
}

/** Why Loft is off for this many profiles, or null. */
export function loftReason(profiles: number): string | null {
  return profiles < 2 ? 'Pick 2 or more sketches.' : null
}

/** Why Closed ring is off for this many profiles, or null. */
export function ringReason(profiles: number): string | null {
  return profiles < 3 ? 'A closed ring needs 3 or more profiles.' : null
}

/** Why Sweep is off, or null. */
export function sweepReason(profile: boolean, path: boolean): string | null {
  if (!profile) return 'Pick a sketch for the profile.'
  return path ? null : 'Pick a sketch or an edge for the path.'
}

const BED_FRAME: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

function sameFrame(a: FaceFrame | undefined, b: FaceFrame | undefined): boolean {
  const x = a ?? BED_FRAME
  const y = b ?? BED_FRAME
  const close = (p: readonly number[], q: readonly number[]) => p.every((v, i) => Math.abs(v - (q[i] ?? NaN)) < 1e-4)
  return close(x.origin, y.origin) && close(x.u, y.u) && close(x.v, y.v)
}

/**
 * The timeline sketch a saved profile (or path) was copied from: the same loops on the same plane where it stands now.
 * Null when none matches, so the step's own copy stays ("kept in the step").
 */
export function matchSketch(saved: { frame?: FaceFrame | undefined; loops?: readonly SketchLoop[] | undefined }, sketches: readonly SketchItem[], frameOf: (k: SketchItem) => FaceFrame): SketchItem | null {
  if (!saved.loops) return null
  const want = JSON.stringify(saved.loops)
  return sketches.find((k) => JSON.stringify(solidLoops(k)) === want && sameFrame(saved.frame, frameOf(k))) ?? null
}

/** The row's words for a profile kept in the step with no sketch to match: "Profile 2 (kept in the step)". */
export const keptWords = (n: number) => `Profile ${n} (kept in the step)`

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
