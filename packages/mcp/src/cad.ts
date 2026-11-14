// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CAD tools on the sx-geom engine: sketch and extrude, revolve, loft, sweep, push and pull,
// booleans, fillet and chamfer, and the face and edge lookups a client needs to
// target them. Each tool is one engine op (docs/cad-fillet.md and
// docs/build-on-the-engine.md describe the JSON), run like the other geom tools.
// The engine picks faces by triangle index; a client knows points, so the
// lookups here turn a point on a face (and its normal) into that index.
// Given a `design` instead of a model, a modeling tool adds a step to that
// design's editable history (design.ts) rather than writing a loose STL.
import { bakeMesh, curveWords, customHoleProblem, keyOfTriangle, loftParams, loopStart, profileOffPathMm, projectionsOut, stepName, sweepParams, type FaceFrame, type HoleSpec, type ProjectMode, type ProjectSource, type SketchConstraint, type SketchItem, type SketchLoop, type StepParams } from '@slicerx/cad-history'
import { defineTool, flatFaces, partTriangles, soupTriangles, type FaceSummary, type PilotTool, type ToolOutput, type Tri } from '@slicerx/pilot'
import { z } from 'zod'
import type { DesignHost, DesignCommit } from '@slicerx/cad-history'
import { notClosedWords, partClosure, type Closure } from './closure'
import { partBoxes, roundTenth, sunkNote, sunkParts } from './sunk'
import { movedStep } from './step-reshape'
import { seatNew } from './seat'
import { type LoftSection, withThinNote } from './section-width'
import { gapMm, gapSentence, nozzleOr } from './design-check'
import { designStamp, fitFacts, fitLimits, fitVerdict, type FitProfile } from './fit-facts'
import type { PlanRegistry } from './design-check'
import { modelArg, vec3, type GeomCall } from './args'
import { designArg, designSummary, featureArg, withFeature, faceAt, landedNote, item, movedPaint, partAt, partsAt, pieceNameFor, pieceNameNote, replayChange, type Design } from './design-tools'
import { ToolInputError } from './errors'
import type { AppLinkCaller } from './app-route'
import { topologyManifest, topologyFace, TopologyReferenceError } from '@slicerx/cad-history/topology-manifest'
import { StaleBody } from '@slicerx/cad-history/body-revisions'
import { verifyHole } from './hole-verification'
import { verifyPush } from './push-verification'

type V3 = [number, number, number]

export { flatFaces }

const vec2 = z.tuple([z.number(), z.number()])
/** What the app link takes: the UTF-8 bytes of a call's arguments as compact JSON (sx-link app_link.rs, MAX_ARGS). */
const LINK_ARGS = 64 * 1024
/** design.sketch_svg's arguments may come to this many bytes; 512 are kept back for numbers the link may write longer. */
const SVG_ARGS = LINK_ARGS - 512
const kb = (bytes: number) => `${Math.round((bytes / 1024) * 10) / 10} KB`

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 | undefined => {
  const l = len(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : undefined
}

/** The frame sx-geom's FaceFrame::for_normal makes, so a plane given as origin and normal reads the same as a picked face. */
export function frameFor(origin: V3, normal: V3, u?: V3): { origin: V3; normal: V3; u: V3; v: V3 } {
  const w = unit(normal)
  if (!w) throw new ToolInputError('plane: normal must be a non-zero vector')
  let uu = u ? unit(sub(u, w.map((c) => c * dot(u, w)) as V3)) : undefined
  if (!uu) uu = Math.abs(w[2]) > 0.9 ? (unit([1 - w[0] * w[0], -w[0] * w[1], -w[0] * w[2]]) ?? [1, 0, 0]) : (unit(cross([0, 0, 1], w)) ?? [1, 0, 0])
  const z0 = (a: V3): V3 => a.map((c) => c + 0) as V3
  return { origin, normal: z0(w), u: z0(uu), v: z0(cross(w, uu)) }
}

/**
 * Why a sweep profile is refused as drawn away from the path's start, or null. A profile is carried as it sits, and its
 * loops are [u, v] from its frame's origin, so a loop given at bed X and Y on a frame already at the path's start lands
 * far off the path; swept from there every bend reads as too tight, which tells the client nothing about the cause.
 */
export function profileOffPath(frame: FaceFrame | undefined, loops: readonly SketchLoop[], start: V3): string | null {
  const off = profileOffPathMm(frame, loops, start)
  if (off === null) return null
  const mm = (n: number) => String(Math.round(n * 100) / 100)
  return `profile: its loop sits ${mm(off)} mm from where the path starts (${start.map(mm).join(', ')}), and the profile is carried as it sits. Loop points are [u, v] from the profile frame's origin, so with the origin on the path's start a loop around it is centered at [0, 0].`
}

/** The closest point to `q` on a triangle (Ericson 5.1.5). */
function closest(q: V3, [a, b, c]: [V3, V3, V3]): V3 {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(q, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(q, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const s = d1 / (d1 - d3)
    return [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s]
  }
  const cp = sub(q, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const s = d2 / (d2 - d6)
    return [a[0] + ac[0] * s, a[1] + ac[1] * s, a[2] + ac[2] * s]
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const s = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + (c[0] - b[0]) * s, b[1] + (c[1] - b[1]) * s, b[2] + (c[2] - b[2]) * s]
  }
  const den = 1 / (va + vb + vc)
  const v = vb * den
  const w = vc * den
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/** Distance from a point to a triangle. */
function distance(q: V3, t: [V3, V3, V3]): number {
  return len(sub(q, closest(q, t)))
}

/** How far a loop or chain reference's point may sit off its face, once an earlier step ate into the face. */
const SET_REACH_MM = 25

/**
 * The flat face a loop or chain reference names: the triangle facing `normal` nearest `at`, and the point on it nearest
 * `at`. A round an earlier step made along the loop moves the face's edge in from the point; the face is still the one
 * nearest that faces that way. Undefined when there is none within SET_REACH_MM.
 */
export function setFace(tris: readonly Pick<Tri, 'p' | 'n' | 'area'>[], at: V3, normal: V3): { triangle: number; at: V3 } | undefined {
  const want = unit(normal)
  if (!want) return undefined
  let best: { triangle: number; at: V3; gap: number } | undefined
  tris.forEach((t, i) => {
    // flat faces only: the facets of a round lean off the normal by their step
    if (t.area <= 0 || dot(t.n, want) < 0.9999) return
    const p = closest(at, t.p)
    const gap = len(sub(at, p))
    if (gap <= SET_REACH_MM && (!best || gap < best.gap)) best = { triangle: i, at: p, gap }
  })
  return best && { triangle: best.triangle, at: best.at }
}

/** STL coordinates are float32, so a point typed from a reply can be off by a few micrometers. */
const NEAR_MM = 0.02

/**
 * The triangle under a point on a face. With a normal, the triangle facing that
 * way wins, which is how a point on an edge says which of its two faces it means.
 */
export function triangleAt(tris: Tri[], at: V3, normal?: V3): number {
  const want = normal ? unit(normal) : undefined
  if (normal && !want) throw new ToolInputError('normal: must be a non-zero vector')
  const near = tris.map((t, i) => ({ i, t })).filter(({ t }) => t.area > 0 && distance(at, t.p) <= NEAR_MM)
  if (near.length === 0) throw new ToolInputError(`at: no face within ${NEAR_MM} mm of (${at.join(', ')}); slicerx_geom_faces lists a point on every flat face`)
  if (want) {
    const best = near.reduce((a, b) => (dot(b.t.n, want) > dot(a.t.n, want) ? b : a))
    // The normal only says which face at a shared point is meant; a curved wall's facets lean a few degrees off it.
    if (dot(best.t.n, want) < Math.cos((30 * Math.PI) / 180)) throw new ToolInputError('normal: no face at that point faces that way; give the outward normal of the face you mean')
    return best.i
  }
  const first = near[0]
  if (!first) throw new ToolInputError('at: no face there')
  if (near.some(({ t }) => dot(t.n, first.t.n) < 0.9999)) throw new ToolInputError('at: the point is on an edge between faces; give normal, the outward normal of the face you mean')
  return first.i
}

/** Where the line through `at` along unit `dir` crosses the triangles: how far along it, and the face's outward normal. */
function lineHits(tris: readonly Tri[], at: V3, dir: V3): { s: number; n: V3 }[] {
  const out: { s: number; n: V3 }[] = []
  for (const t of tris) {
    if (!(t.area > 0)) continue
    const [a, b, c] = t.p
    const e1 = sub(b, a)
    const e2 = sub(c, a)
    const p = cross(dir, e2)
    const det = dot(e1, p)
    // a face along the line (a hole's own wall, say) is never crossed
    if (Math.abs(det) <= 1e-9 * len(e1) * len(e2)) continue
    const q = sub(at, a)
    const u = dot(q, p) / det
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const r = cross(q, e1)
    const v = dot(dir, r) / det
    if (v < -1e-9 || u + v > 1 + 1e-9) continue
    out.push({ s: dot(e2, r) / det, n: t.n })
  }
  return out
}

/** How far a new through hole's cut runs past the face where the material ends, so it never stops flush with it, mm. */
const HOLE_OVERLAP_MM = 0.05
/** The entry face holds the hole's circle when the face there is this close to the entry's plane, mm. */
const HOLE_FLAT_MM = 0.01

/**
 * Where a new hole goes into a part, from a point on its axis line and the axis (either way round), or from a point on
 * the face it starts at alone (the hole square to that face; `normal` says which face on an edge): its entry, where the
 * line meets the part nearest the point, on a flat face square to the axis that holds the whole circle of `radiusMm`;
 * `into`, the way into the material there; and `wallMm`, how far the material runs that way (through the wall the hole
 * starts in). Anything else is refused with what is there.
 */
function newHolePath(tris: readonly Tri[], at: V3, axis: V3 | undefined, normal: V3 | undefined, radiusMm: number): { entry: V3; into: V3; wallMm: number } {
  const r3 = (c: number) => Math.round(c * 1000) / 1000 || 0
  const mm = (v: V3) => v.map(r3).join(', ')
  const notFlat = (p: V3) => new ToolInputError(`center: the face at (${mm(p)}) is not flat across the hole's ${r3(radiusMm * 2)} mm circle (it runs off the face or onto a round one); a hole starts on a flat face, such as the top of a boss`)
  let a: V3 | undefined
  if (axis) a = unit(axis)
  else {
    try {
      a = tris[triangleAt([...tris], at, normal)]!.n
    } catch (e) {
      // a point between two facets of a round face (a boss's side) is no edge to pick a side of: it is not flat
      const near = tris.filter((t) => t.area > 0 && distance(at, t.p) <= NEAR_MM)
      if (near.length > 1 && near.every((t) => dot(t.n, near[0]!.n) > Math.cos(Math.PI / 6))) throw notFlat(at)
      throw e
    }
  }
  if (!a) throw new ToolInputError('axis: must be a non-zero vector')
  const hits = lineHits(tris, at, a)
  if (!hits.length) throw new ToolInputError(`center: the hole's axis line through (${mm(at)}) meets no face of the part; give its center on the face it starts at`)
  const first = hits.reduce((x, y) => (Math.abs(y.s) < Math.abs(x.s) ? y : x))
  const entry = at.map((c, k) => c + a[k]! * first.s) as V3
  const off = (Math.acos(Math.min(1, Math.abs(dot(first.n, a)))) * 180) / Math.PI
  if (off > 1) throw new ToolInputError(`axis: the face the hole starts on at (${mm(entry)}) is ${Math.round(off)} degrees off square to the axis; a hole goes square into a flat face`)
  const into = (dot(first.n, a) < 0 ? a : a.map((c) => -c)) as V3
  const way = dot(a, into)
  const exit = hits.map((h) => ({ d: (h.s - first.s) * way, n: h.n })).filter((h) => h.d > 1e-6).sort((x, y) => x.d - y.d)[0]
  if (!exit || dot(exit.n, into) <= 0) throw new ToolInputError(`center: the part is not closed along the hole's axis from (${mm(entry)})`)
  // the whole circle on the entry face: a hole that runs off it, or onto a round face, is refused
  const u = unit(cross(into, Math.abs(into[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]))!
  const v = cross(into, u)
  for (let k = 0; k < 8; k++) {
    const t = (k * Math.PI) / 4
    const q = entry.map((c, j) => c + radiusMm * (Math.cos(t) * u[j]! + Math.sin(t) * v[j]!)) as V3
    const near = lineHits(tris, q, into).reduce<{ s: number; n: V3 } | null>((x, y) => (!x || Math.abs(y.s) < Math.abs(x.s) ? y : x), null)
    if (!near || Math.abs(near.s) > HOLE_FLAT_MM || dot(near.n, first.n) < 0.9999) throw notFlat(entry)
  }
  return { entry, into, wallMm: exit.d }
}

const faceRef = z
  .object({
    at: vec3.optional().describe('A point on the face, mm (the "at" of slicerx_geom_faces, or any point on it)'),
    normal: vec3.optional().describe('Outward normal of the face; needed when "at" lies on an edge'),
    triangle: z.number().int().min(0).optional().describe('Triangle index from slicerx_geom_faces, instead of a point'),
    part: z.number().int().min(0).optional().describe('With a design and "triangle": the part the triangle is on (slicerx_geom_faces gives it)'),
    topology: z.object({ bodyId: z.string().min(1), revision: z.string().min(1), part: z.number().int().min(0), faceKey: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional().describe('A scoped reference from geom.faces format=topology. Do not reuse it after the body changes.'),
  })
  .describe('The face: {"at":[x,y,z],"normal":[x,y,z]} or {"triangle":n}')

const modelOrDesign = modelArg.optional().describe('Absolute path to an STL file, an http(s) URL, or a built-in model such as sample:x-mark; or give "design" instead')
const partArg = z.number().int().min(0).optional().describe('With a design: the part to work on, from 0 (default 0)')

/**
 * `v` parsed by `schema`, or a ToolInputError naming the first bad field by its path under `field` (into the closest
 * branch of a union), such as "profile.loops.0.segments.1.to: Invalid input: expected array, received undefined".
 */
function parsedAt<T extends z.ZodType>(schema: T, v: unknown, field: string): z.infer<T> {
  const r = schema.safeParse(v)
  if (r.success) return r.data
  type Issue = { path: PropertyKey[]; message: string; code?: string; errors?: Issue[][] }
  const first = (issues: readonly Issue[], base: PropertyKey[]): { path: PropertyKey[]; message: string } => {
    const e = issues[0]!
    const path = [...base, ...e.path]
    const branches = e.code === 'invalid_union' && e.errors ? e.errors.filter((b) => b.length) : []
    if (branches.length) return first([...branches].sort((a, b) => a.length - b.length)[0]!, path)
    return { path, message: e.message }
  }
  const at = first(r.error.issues as unknown as Issue[], [field])
  throw new ToolInputError(`${at.path.map(String).join('.')}: ${at.message}`)
}

const frameSchema = z
  .object({ origin: vec3, normal: vec3, u: vec3.optional(), v: vec3.optional() })
  .describe('Sketch plane: the "frame" of slicerx_geom_face_pick, or {"origin":[x,y,z],"normal":[x,y,z]} for any plane. Shape and sketch coordinates are [u, v] in it. Absent: the bed (origin 0,0,0, normal +Z, u along +X)')

const segment = z
  .object({
    type: z.enum(['line', 'arc', 'spline']),
    to: vec2.optional(),
    points: z.array(vec2).max(512).optional(),
    lengthMm: z.number().optional(),
    angleDeg: z.number().optional(),
    turnDeg: z.number().optional(),
    center: vec2.optional(),
    sweepDeg: z.number().optional(),
    through: vec2.optional(),
    radiusMm: z.number().optional(),
    clockwise: z.boolean().optional(),
    large: z.boolean().optional(),
  })
  .describe('{"type":"line","to":[u,v]}, {"type":"line","lengthMm":l,"angleDeg":a}, {"type":"line","lengthMm":l,"turnDeg":t}, {"type":"arc","center":[u,v],"sweepDeg":s}, {"type":"arc","to":[u,v],"through":[u,v]}, {"type":"arc","to":[u,v],"radiusMm":r,"clockwise"?:b,"large"?:b}, {"type":"arc","radiusMm":r,"sweepDeg":s} (tangent), or {"type":"spline","points":[[u,v],...],"to":[u,v]} (smooth, within 0.005 mm)')

const circleLoop = z.object({ type: z.literal('circle'), center: vec2, diameterMm: z.number().positive() })
const ellipseLoop = z.object({ type: z.literal('ellipse'), center: vec2, widthMm: z.number().positive(), heightMm: z.number().positive(), angleDeg: z.number().min(-360).max(360).optional() })
const chainLoop = z.object({ start: vec2, segments: z.array(segment).min(1).max(512) })
const splineLoop = z.object({ type: z.literal('spline'), points: z.array(vec2).max(4096) })
const pointsLoop = z.object({ points: z.array(vec2).min(3).max(4096) })
const loop = z
  .union([
    circleLoop,
    ellipseLoop,
    chainLoop,
    splineLoop,
    pointsLoop,
  ])
  .describe('A closed loop: {"points":[[u,v],...]}, {"type":"spline","points":[[u,v],...]}, {"type":"circle","center":[u,v],"diameterMm":d}, {"type":"ellipse","center":[u,v],"widthMm":w,"heightMm":h,"angleDeg":a} (the width turned a degrees from u), or {"start":[u,v],"segments":[...]}. A loop inside another is a hole')

const loops = z.array(loop).min(1).max(256)

type Loops = z.infer<typeof loops>
type Frame = z.infer<typeof frameSchema>

// The sketch tools other than slicerx_geom_revolve parse their loops and frame with the same schemas but advertise
// only a one-line shape: spelling the schemas out in each tool would cost a small local model's context several
// times over. Each loop is read by the form its keys name, so an error names the field (loops.2.segments.0.to).
const LOOP_FORMS = 'a loop is {points}, {type: "circle", center, diameterMm}, {type: "ellipse", center, widthMm, heightMm, angleDeg}, {type: "spline", points} or {start, segments}'
function formOf(v: unknown): z.ZodType | null {
  if (!v || typeof v !== 'object') return null
  const type = (v as { type?: unknown }).type
  if (type === 'circle') return circleLoop
  if (type === 'ellipse') return ellipseLoop
  if (type === 'spline') return splineLoop
  if (type !== undefined) return null
  if ('start' in v) return chainLoop
  return 'points' in v ? pointsLoop : null
}
const loopsRef = z
  .array(z.unknown())
  .min(1)
  .max(256)
  .transform((v, ctx): Loops => {
    const out: Loops = []
    v.forEach((l, k) => {
      const form = formOf(l)
      if (!form) return void ctx.addIssue({ code: 'custom', message: LOOP_FORMS, path: [k] })
      const r = form.safeParse(l)
      if (!r.success) return void r.error.issues.forEach((e) => ctx.addIssue({ code: 'custom', message: e.message, path: [k, ...e.path] }))
      const segs = (r.data as { segments?: { type: string; to?: unknown; points?: unknown[] }[] }).segments ?? []
      segs.forEach((g, j) => {
        if (g.type === 'spline' && !g.to) ctx.addIssue({ code: 'custom', message: 'a spline needs its end as to', path: [k, 'segments', j, 'to'] })
        if (g.type === 'spline' && !g.points?.length) ctx.addIssue({ code: 'custom', message: 'a spline needs 1 or more points before to', path: [k, 'segments', j, 'points'] })
      })
      out.push(r.data as Loops[number])
    })
    return out
  })
  .describe('Closed loops, as {points: [[u,v],...]}, {type: "circle", center, diameterMm}, {type: "ellipse", center, widthMm, heightMm, angleDeg}, {type: "spline", points} or {start, segments: [{type: line | arc | spline, to, ...}]}; one inside another is a hole')
const frameRef = z
  .unknown()
  .transform((v, ctx): Frame => {
    const r = frameSchema.safeParse(v)
    if (!r.success) {
      r.error.issues.forEach((e) => ctx.addIssue({ code: 'custom', message: e.message, path: e.path }))
      return z.NEVER
    }
    return r.data
  })
  .describe('Plane {origin, normal}, or a face_pick frame; none is the bed')

const sketchEntity = z.discriminatedUnion('type', [
  z.object({ type: z.literal('line'), a: z.number().int().min(0), b: z.number().int().min(0) }),
  z.object({ type: z.literal('circle'), center: z.number().int().min(0), radius: z.number().positive().describe('Where the solve starts, mm') }),
  z.object({ type: z.literal('arc'), center: z.number().int().min(0), start: z.number().int().min(0), end: z.number().int().min(0) }).describe('Counterclockwise from start to end'),
])
const SKETCH_CONSTRAINTS = [
  'coincident', 'fix', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'collinear', 'equal', 'tangent', 'midpoint', 'concentric',
  'onLine', 'onCircle', 'symmetric', 'distance', 'horizontalDistance', 'verticalDistance', 'length', 'radius', 'diameter', 'angle', 'lineDistance',
] as const
const sketchConstraint = z
  .object({ type: z.enum(SKETCH_CONSTRAINTS) })
  .catchall(z.number())
  .describe('Fields by type: a, b (points, or lines and circles by entity index), point, line, circle, value (mm, or degrees for angle)')

// a finished sketch's constraints name its loops: points by loop, place and segment, lines and circles by loop and segment
const loopPoint = z
  .object({ e: z.number().int().min(-1), at: z.enum(['start', 'to', 'center', 'arcCenter', 'point']), seg: z.number().int().min(0).optional(), i: z.number().int().min(0).optional() })
  .superRefine((p, ctx) => {
    if (p.at === 'point' && p.i === undefined) ctx.addIssue({ code: 'custom', message: 'a spline point needs i', path: ['i'] })
  })
const loopCurve = z.object({ e: z.number().int().min(-1), seg: z.number().int().min(0) })
const loopConstraint = z
  .object({ type: z.enum(SKETCH_CONSTRAINTS), driven: z.literal(true).optional(), expr: z.string().max(200).optional() })
  .catchall(z.union([z.number(), loopPoint, loopCurve]))
  .describe(
    'Fields by type as for slicerx_geom_sketch_solve, naming the loops: a point is {e: loop, at: start | to | center | arcCenter | point, seg} (to and arcCenter take the segment; point is spline point i, no seg on a spline loop; e -1 at start is the sketch origin), a line, arc or circle is {e: loop, seg} (a circle is seg 0; e -1 seg 0 is the X axis of the sketch, so an angle from it sets the direction of a line). Dimensions (length, distance, horizontalDistance, verticalDistance, lineDistance, radius, diameter, angle) take value, mm or degrees, and offset, mm, where the dimension line sits',
  )

const shape = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('rectangle'), widthMm: z.number().positive(), heightMm: z.number().positive(), cornerRadiusMm: z.number().min(0).optional() }),
    z.object({ type: z.literal('circle'), diameterMm: z.number().positive() }),
    z.object({ type: z.literal('slot'), lengthMm: z.number().positive(), widthMm: z.number().positive() }),
    z.object({ type: z.literal('ellipse'), widthMm: z.number().positive(), heightMm: z.number().positive() }).describe('widthMm along placement x before rotationDeg turns it'),
    z.object({ type: z.literal('polygon'), sides: z.number().int().min(3).max(256), diameterMm: z.number().positive(), fit: z.enum(['inscribed', 'circumscribed']).optional() }),
    z.object({ type: z.literal('text'), text: z.string().min(1).max(200), sizeMm: z.number().positive(), letterSpacingMm: z.number().optional(), lineSpacing: z.number().positive().optional(), align: z.enum(['left', 'center', 'right']).optional() }),
    z.object({ type: z.literal('sketch'), loops: loopsRef }),
    z.object({ type: z.literal('svg'), svg: z.string().min(1).max(2_000_000), widthMm: z.number().positive(), toleranceMm: z.number().positive().optional() }),
  ])
  .describe('What to extrude, in the plane: rectangle, circle, slot, ellipse, polygon or text centered on placement.center, a free sketch of closed loops (as typed), or SVG artwork scaled to widthMm')

const operation = z.enum(['new', 'join', 'cut']).default('new').describe('new: a separate body; join: add to target; cut: remove from target')
/** The filament a new body prints in, as geom.build takes it. */
const slotArg = z.number().int().min(1).max(32).optional().describe('Filament of a new part on a design, from 1')

/** A filament slot names a new body on a design: a join or a cut changes a part that keeps its own filament. */
function slotOk(i: { slot?: number | undefined; design?: string | undefined; operation: string }): void {
  if (i.slot === undefined) return
  if (!i.design) throw new ToolInputError('slot: a filament is for a new part of a design; give the design, or leave slot out')
  if (i.operation !== 'new') throw new ToolInputError(`slot: a ${i.operation} changes a part that keeps its own filament; leave slot out, or use operation new for a part of its own`)
}
const edgeRef = z
  .object({ a: vec3, b: vec3, face: vec3, center: vec3.optional(), keys: z.tuple([z.number(), z.number()]).optional() })
  .describe('An edge as slicerx_geom_edge_pick returns it: end points a and b, the normal of its first face, and on a design the keys of its two faces; pass it as is')
const edgeSet = z
  .object({ set: z.enum(['loop', 'chain']), at: vec3, normal: vec3 })
  .describe('A whole loop or chain as slicerx_geom_edge_pick returns it (loopRef, chainRef): picked again from this point on the face when the step is made, so it still finds the loop after an earlier step changed it')
const edgeItem = z.union([edgeSet, edgeRef])
// What a local model is shown, whose whole context is small: the same fields, enums and required ones, without the
// texts (each costs its context on every turn). The tool's own input still takes and checks the call.
const localEdges = z
  .array(z.union([z.object({ set: z.enum(['loop', 'chain']), at: vec3, normal: vec3 }), z.object({ a: vec3, b: vec3, face: vec3, center: vec3.optional(), keys: z.tuple([z.number(), z.number()]).optional() })]))
  .min(1)
  .max(256)
const localModel = z.string().min(1).optional()
const localDesign = z.string().min(1).optional()

/** Refuses a spline segment with no points and a closed spline of fewer than 3; the schema leaves the counts out to stay short. */
function splinesOk(loops: readonly object[]): void {
  loops.forEach((l, n) => {
    if ('type' in l && l.type === 'spline' && 'points' in l && Array.isArray(l.points) && l.points.length < 3) throw new ToolInputError(`loops[${n}]: a closed spline needs 3 or more points`)
    const segs = 'segments' in l && Array.isArray(l.segments) ? (l.segments as { type?: string; points?: unknown[]; to?: unknown }[]) : []
    segs.forEach((g, k) => {
      if (g.type === 'spline' && !g.points?.length) throw new ToolInputError(`loops[${n}].segments[${k}]: a spline needs 1 or more points before to`)
      if (g.type === 'spline' && !('to' in g && g.to)) throw new ToolInputError(`loops[${n}].segments[${k}]: a spline needs its end as to`)
    })
  })
}

/** ", 2 splines" for a sketch with splines in it, else nothing. */
function splines(loops: readonly object[]): string {
  const n = loops.reduce((t: number, l) => t + ('type' in l && l.type === 'spline' ? 1 : 'segments' in l && Array.isArray(l.segments) ? l.segments.filter((g: { type?: string }) => g.type === 'spline').length : 0), 0)
  return n ? `, ${n} spline${n === 1 ? '' : 's'}` : ''
}

/** Drops per-triangle lists from a reply; a client never needs them and they are long. */
function lean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(lean)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === 'triangles' && Array.isArray(x))).map(([k, x]) => [k, lean(x)]))
  return v
}

/** Tool input as the plain JSON a step keeps: absent fields left out rather than undefined. */
const plain = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T

/** Exactly one of a model and a design. */
function oneOf(i: { model?: string | undefined; design?: string | undefined }): void {
  if (!i.model === !i.design) throw new ToolInputError(i.model ? 'give "model" or "design", not both' : 'give "model" (an STL) or "design" (a design id)')
}

/** What a modeling tool returns for a design: the step it added and the design as it is now. */
function stepOut(d: Design, verb: string): { summary: string; output: Record<string, unknown> } {
  const s = d.history.steps[d.history.steps.length - 1]
  return { summary: `${verb}: step ${d.history.steps.length}${s ? `, ${stepName(s)}` : ''}${d.landed ? `. ${landedNote(d.landed, d.name)}` : ''}`, output: designSummary(d) }
}

/**
 * What the CAD tools do with model files, which only the server has: the engine on STL files, a model's path, and an
 * STL's triangle soup. In the app every call answers that files are for the server; designs work the same in both.
 */
export interface CadFiles {
  /** True when the engine runs on files here (the sx-geom program). */
  engine: boolean
  call: GeomCall
  path(model: string): Promise<string>
  stl(stlPath: string): Float32Array
  /** A PNG or JPEG's bytes, from inside the directories this server may read. */
  image?(path: string): Uint8Array
}

/** The design.sketch the client sees (routed to the app once the tools are), so a trace lands where design.sketch puts it. */
export interface SketchVia {
  run?: (args: Record<string, unknown>, ctx: unknown) => Promise<ToolOutput>
  /** The bed's middle on the plate the app shows, when its link answers. */
  bedMiddle?: () => Promise<[number, number] | undefined>
  /**
   * The design a routed sketch is drawn for, as the app's design.sketch takes it, and how far the app moved it onto the
   * bed (its placedMm): the one named, by id or name, or with none named the only design once one was moved onto the
   * bed. Undefined when there is none to draw for, or the link does not answer.
   */
  drawnFor?: (design: string | undefined) => Promise<{ design: string; placed?: [number, number] } | undefined>
}

/**
 * Points design.trace_image at the design.sketch a client sees: it traces here, where a large image is no burden, then
 * adds its loops through `tools`' design.sketch as the client would, so they land in the app while its link answers.
 * Its default center is then the middle of the app's bed, read from the plate list; a link that does not answer leaves
 * it to this server's bed.
 */
export function wireSketchVia(via: SketchVia, tools: readonly PilotTool<never>[], appLink?: AppLinkCaller): void {
  const sketchTool = tools.find((t) => t.name === 'design.sketch')
  if (sketchTool) via.run = (args, ctx) => sketchTool.run(sketchTool.input.parse(args) as never, ctx as never)
  if (!appLink) return
  via.bedMiddle = async () => {
    const bed = await appLink.call<{ bed?: { widthMm?: number; depthMm?: number; centerMm?: [number, number] } }>('plate.list').then((r) => r.bed, () => undefined)
    if (bed?.centerMm) return bed.centerMm
    return bed?.widthMm && bed.depthMm ? [bed.widthMm / 2, bed.depthMm / 2] : undefined
  }
  via.drawnFor = async (design) => {
    const r = await appLink.call<{ output?: { designs?: { design?: string; name?: string; placedMm?: [number, number] }[] } }>('design.list').catch(() => undefined)
    const all = r?.output?.designs ?? []
    const d = design !== undefined ? (all.find((x) => x.design === design) ?? all.find((x) => x.name === design)) : all.some((x) => x.placedMm) && all.length === 1 ? all[0] : undefined
    return d?.design ? { design: d.design, ...(d.placedMm ? { placed: d.placedMm } : {}) } : undefined
  }
}

/** An engine refusal of a trace in this tool's words: the Trace image dialog's settings by their option names, and the
 * working size, which the dialog does not have. */
export function traceRefusal(e: unknown): unknown {
  if (!(e instanceof Error)) return e
  e.message = e.message
    .replace(/Remove specks under/g, 'speck_mm2')
    .replace(/\bSmoothing\b/g, 'smoothing_mm')
    .replace(/the tolerance/g, 'color_tolerance')
    .replace(/what to trace or the threshold/g, 'mode or threshold')
    .replace(/use a simpler image/g, 'lower max_side_px or use a simpler image')
  // a file too large to read is refused before it is shrunk, so the working size cannot help
  if (/is too large to read/.test(e.message)) e.message += '. max_side_px shrinks the image only after it is read, so it does not help here'
  return e
}

/** The first traced loop longer than design.sketch takes (512 pieces, 4096 points for a loop of points or a spline
 * loop, 512 through points in a spline piece), said in words, or undefined when every loop fits. */
export function traceLoopTooLong(loops: readonly object[]): string | undefined {
  for (const [k, l] of loops.entries()) {
    const n = k + 1
    const segments = 'segments' in l && Array.isArray(l.segments) ? l.segments : []
    if (segments.length > 512) return `loop ${n} has ${segments.length} pieces and a sketch loop takes 512`
    const points = 'points' in l && Array.isArray(l.points) ? l.points.length : 0
    if (points > 4096) return `loop ${n} has ${points} points and a sketch loop takes 4096`
    const through = segments.reduce((m, s) => Math.max(m, Array.isArray((s as { points?: unknown[] }).points) ? (s as { points: unknown[] }).points.length : 0), 0)
    if (through > 512) return `loop ${n} has a spline through ${through} points and a sketch spline takes 512`
  }
  return undefined
}

/** An image past this many bytes is refused before it is read. */
export const IMAGE_BYTES = 30 * 1024 * 1024

/** The refusal of an image of `bytes` over IMAGE_BYTES. */
export function imageTooLarge(bytes: number): ToolInputError {
  return new ToolInputError(`image: the file is ${kb(bytes)}, over the 30 MB a trace takes. Export it smaller first.`)
}

export function cadTools(deps: { files: CadFiles; designs?: DesignHost | undefined; /** The printer's nozzle, mm, for the smallest hole; 0.4 without one. */ nozzleMm?: (() => number | undefined) | undefined; /** The layer height and material the part prints with, for geom.fit_check; half the nozzle and PLA without them. */ fitProfile?: (() => FitProfile) | undefined; /** Where geom.fit_check records each run, so design.check of a print-in-place plan knows the gaps were looked at; a new body's piece name comes from its plans too (pieceNameFor). */ plans?: Pick<PlanRegistry, 'fitChecked' | 'tiedTo' | 'get'> | undefined; sketchVia?: SketchVia }): PilotTool<never>[] {
  const call = deps.files.call
  const path = (model: string): Promise<string> => deps.files.path(model)
  const triangles = (stlPath: string): Tri[] => soupTriangles(deps.files.stl(stlPath))
  const designOf = (id: string): Design => {
    if (!deps.designs) throw new ToolInputError('Designs need the sx-geom engine, which this server did not find.', 'not_supported')
    return deps.designs.get(id)
  }
  const designs = (): DesignHost => deps.designs!
  /** A new body's name when it builds a print-in-place piece of the design's plan (pieceNameFor); undefined keeps the one given. */
  const newPiece = (d: Design, i: { operation: string; feature?: string | undefined; name?: string | undefined }): string | undefined => (i.operation === 'new' ? pieceNameFor(deps.plans, d, i.feature, i.name) : undefined)
  /**
   * A new body a hair from another part (under the gap a printer keeps open) is seated on it as the same step; the
   * answer gains what was seated or left (seat.ts). `n` is the part count before the step.
   */
  const seated = async <T extends { summary: string }>(d: Design, operation: string, n: number, out: T): Promise<T> => {
    if (operation !== 'new') return out
    const said = await seatNew(designs(), d, Array.from({ length: Math.max(0, d.parts.length - n) }, (_, k) => n + k), { nozzleMm: deps.nozzleMm?.(), layerHeightMm: deps.fitProfile?.().layerHeightMm, plans: deps.plans })
    return said ? { ...out, summary: `${out.summary.replace(/[.\s]+$/, '')}. ${said}` } : out
  }
  /** A step's answer that says so when its new body took the plan's piece name. */
  const pieceNamed = (out: { summary: string; output: Record<string, unknown> }, piece: string | undefined, given: string | undefined) => (piece ? { ...out, summary: `${out.summary}${pieceNameNote(piece, given)}` } : out)
  const readImage = (p: string): Uint8Array => {
    if (!deps.files.image) throw new ToolInputError('image: this server reads no files; pass the image as base64', 'not_supported')
    return deps.files.image(p)
  }
  // A join or cut on a design names its part with "part". A target given as well that names one of its parts stands
  // for that part (a part name wins over the design's own name), and one that is the design itself (by id or name)
  // leaves part as given. A target naming another part than part, a name two parts share, or any other target is
  // refused with the parts there are.
  const targetPart = (d: Design, target: string | undefined, part: number | undefined): number | undefined => {
    if (target === undefined) return part
    const key = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase()
    const parts = d.parts.map((p, n) => `${n} (${p.name})`).join(', ')
    const give = `leave target out${parts ? ` and give part, one of ${parts}` : ''}`
    const named = d.parts.flatMap((p, n) => (key(p.name) === key(target) ? [n] : []))
    if (named.length > 1) throw new ToolInputError(`target: ${named.length} parts are named ${target} (${named.join(', ')}); ${give}`)
    const k = named[0]
    if (k !== undefined) {
      if (part !== undefined && part !== k) throw new ToolInputError(`target: ${target} is part ${k} (${d.parts[k]!.name}), but part is ${part}${d.parts[part] ? ` (${d.parts[part]!.name})` : ''}; give one of them`)
      return k
    }
    if (key(target) === key(d.id) || key(target) === key(d.name)) return part
    throw new ToolInputError(`target: with a design, join and cut work on its "part"; ${give}`)
  }
  // The design's id for a refusal's bodyId, so a design given by its name reports the body it means.
  const bodyIdOf = (given: string): string => {
    try {
      return designOf(given).id
    } catch {
      return given
    }
  }
  const manifestOf = (d: Design, revision?: string) => {
    const host = designs()
    if (!host.revision) throw new ToolInputError('This host cannot bind topology to a body revision.', 'not_supported')
    return topologyManifest(d.id, revision ?? host.revision(d.id), d.parts, d.transform, 'exact' in d.history && d.history.exact === true, !!host.addWithReceipt)
  }
  const compactManifest = (manifest: ReturnType<typeof manifestOf>) => ({ ...manifest, faceCount: manifest.faces.length, truncated: manifest.faces.length > 40, faces: manifest.faces.slice(0, 40) })
  const checkedManifest = (id: string, revision: string) => {
    let current: ReturnType<typeof manifestOf>
    try { current = manifestOf(designOf(id)) } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'not_found') throw new ToolInputError('The body was removed. Inspect the current project again.', 'stale_body', { bodyId: id, currentRevision: null })
      throw e
    }
    if (current.revision !== revision) throw new ToolInputError('The body changed during the operation. Inspect it again.', 'stale_body', { bodyId: id, currentRevision: current.revision })
    return current
  }
  const target = async (model: string | undefined, op: string): Promise<Record<string, unknown>> => {
    if (op === 'new') return {}
    if (!model) throw new ToolInputError(`target: ${op} needs a target model`)
    return { target: { stlPath: await path(model) } }
  }
  const pick = async (stlPath: string, face: z.infer<typeof faceRef>): Promise<{ triangle: number; at: V3 }> => {
    if (face.topology) throw new ToolInputError('Topology references require a live design.', 'not_supported')
    const tris = triangles(stlPath)
    if (face.triangle !== undefined) {
      const t = tris[face.triangle]
      if (!t) throw new ToolInputError(`triangle: out of range (the model has ${tris.length})`)
      return { triangle: face.triangle, at: face.at ?? ([0, 1, 2].map((k) => ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) / 3) as V3) }
    }
    if (!face.at) throw new ToolInputError('face: give "at" (a point on the face) or "triangle"')
    return { triangle: triangleAt(tris, face.at, face.normal), at: face.at }
  }
  /** A face of a design: its part, triangle, a point on it, its outward normal and its key. */
  const pickIn = (d: Design, face: z.infer<typeof faceRef>): { part: number; triangle: number; at: V3; normal: V3; key: number | undefined } => {
    if (face.topology) {
      if (face.at || face.normal || face.triangle !== undefined || face.part !== undefined) throw new ToolInputError('Give a topology reference alone, without a second face selection.')
      const manifest = manifestOf(d)
      let selected: ReturnType<typeof topologyFace>
      try { selected = topologyFace(manifest, face.topology) } catch (e) {
        if (e instanceof TopologyReferenceError) throw new ToolInputError(e.message, e.code, { topology: compactManifest(manifest) })
        throw e
      }
      const part = d.parts[selected.part]!
      const triangle = Array.from(part.faces?.ids ?? []).findIndex(id => id === selected.face)
      const t = partTriangles(bakeMesh(part, d.transform))[triangle]
      if (!t) throw new ToolInputError('That face has no usable display triangles.', 'missing_face')
      const at = [0, 1, 2].map(k => ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) / 3) as V3
      return { part: selected.part, triangle, at, normal: t.n, key: selected.faceKey! }
    }
    if (face.triangle !== undefined) {
      const part = face.part ?? 0
      const p = d.parts[part]
      if (!p) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
      const t = partTriangles(bakeMesh(p, d.transform))[face.triangle]
      if (!t) throw new ToolInputError(`triangle: out of range (part ${part} has ${p.indices.length / 3})`)
      const at = face.at ?? ([0, 1, 2].map((k) => ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) / 3) as V3)
      const key = keyOfTriangle(p, face.triangle)
      return { part, triangle: face.triangle, at, normal: t.n, key: key || undefined }
    }
    if (!face.at) throw new ToolInputError('face: give "at" (a point on the face) or "triangle"')
    return { ...faceAt(d, face.at, face.normal), at: face.at }
  }
  const plane = (f: z.infer<typeof frameSchema> | undefined): Record<string, unknown> => (f ? { frame: frameFor(f.origin, f.normal, f.u) } : {})
  const frameOf = (f: z.infer<typeof frameSchema> | undefined): FaceFrame | undefined => (f ? frameFor(f.origin, f.normal, f.u) : undefined)
  // a finished sketch of the design timeline, in the frame of the design it is used on: only the app keeps them
  const finished = (id: string, design: string) => {
    const host = deps.designs
    if (!host?.sketch) throw new ToolInputError(`sketch: finished sketches live in the design timeline of the project open in the app; turn on the app link there, then try again`)
    return host.sketch(id, design)
  }
  const engine = (op: string, request: unknown): Promise<Record<string, unknown>> => designs().call(op, request) as Promise<Record<string, unknown>>
  // the design a new sketch is drawn for: the one the call names; with none named, once a design was moved onto the bed
  // its frame is no longer the plate's, so the only design there is, or a refusal while there are others. With no
  // design moved, every design's frame is the plate's and the sketch is drawn for none.
  const sketchFor = (design: string | undefined): string | undefined => {
    if (design !== undefined) return designOf(design).id
    const all = deps.designs?.list() ?? []
    const moved = all.filter((d) => d.placed)
    if (!moved.length) return undefined
    if (all.length === 1) return all[0]!.id
    throw new ToolInputError(`design: name the design this sketch is drawn for. ${moved.map((d) => d.name).join(', ')} moved onto the bed, so ${moved.length === 1 ? 'its coordinates are' : 'their coordinates are'} not the plate's; slicerx_design_list lists the designs`)
  }

  // the check issues of a spline the engine cannot draw (repeated points, too sharp a bend, too many points)
  // a sketch past the point budget is named on the loop that tips it, which need not be a spline
  const undrawable = (issues: unknown, l: Loops) => (Array.isArray(issues) ? (issues as { loop: number; kind: string; message: string }[]) : []).filter((x) => x.kind === 'tooDense' || (['zeroLength', 'tooSmall'].includes(x.kind) && /spline/i.test(JSON.stringify(l[x.loop] ?? {}))))

  // a spline the engine cannot draw never reaches the timeline
  const splinesDraw = async (l: Loops): Promise<void> => {
    if (!splines(l)) return
    const out = await engine('sketch.check', { loops: l })
    const bad = undrawable(out['issues'], l)
    if (bad.length) throw new ToolInputError(`loops: ${bad.map((x) => x.message).join(' ')}`)
  }

  const faces = defineTool({
    name: 'geom.faces',
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    description:
      'List the flat faces of a model or a design, largest first: a point "at" on each face, its outward normal, which axis it faces (+z (top), -x and so on), its area and center; for a design also its part, its face key and the step that made it. Use a face\'s "at" and "normal" with slicerx_geom_face_pick, slicerx_geom_edge_pick or slicerx_geom_push_pull. Curved surfaces show up as many small faces.',
    localDescription:
      'List the flat faces of a model or design, largest first: for each a point "at", its outward normal, the axis it faces (+z (top), -x and so on), area and center; for a design also its part, face key and the step that made it. Use its "at" and "normal" with geom.face_pick, geom.edge_pick or geom.push_pull. Curved surfaces show as many small faces.',
    input: z.object({ model: modelOrDesign, design: designArg.optional(), part: partArg, limit: z.number().int().min(1).max(500).default(40), format: z.enum(['flat', 'topology']).default('flat').describe('With a design, topology returns compact revision-bound surface metadata in body-local coordinates, with world placement separately.') }),
    async run(i) {
      oneOf(i)
      if (i.format === 'topology') {
        if (!i.design) throw new ToolInputError('Topology references require a live design, not a model path.', 'not_supported')
        const manifest = manifestOf(designOf(i.design))
        const selected = manifest.faces.filter(face => i.part === undefined || face.part === i.part)
        return { summary: `${selected.length} topology faces at body revision ${manifest.revision}`, output: { topology: { ...manifest, faceCount: selected.length, truncated: selected.length > i.limit, faces: selected.slice(0, i.limit) } } }
      }
      let all: (FaceSummary & { part?: number; key?: number; madeBy?: string })[]
      if (i.design) {
        const d = designOf(i.design)
        const names = new Map(d.history.steps.map((s) => [s.id, stepName(s)]))
        all = d.parts
          .flatMap((p, part) =>
            i.part !== undefined && i.part !== part
              ? []
              : flatFaces(partTriangles(bakeMesh(p, d.transform))).map((f) => {
                  const key = keyOfTriangle(p, f.triangle)
                  const made = key ? d.madeBy[key] : undefined
                  return { ...f, part, ...(key ? { key } : {}), madeBy: made ? (names.get(made) ?? made) : 'base' }
                }),
          )
          .sort((a, b) => b.areaMm2 - a.areaMm2)
      } else all = flatFaces(triangles(await path(i.model!)))
      return { summary: `${all.length} flat face${all.length === 1 ? '' : 's'}${all.length > i.limit ? `, the largest ${i.limit} listed` : ''}`, output: { count: all.length, faces: all.slice(0, i.limit) } }
    },
  })

  const facePick = defineTool({
    name: 'geom.face_pick',
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    description:
      'Pick a flat face of a model or a design: returns its sketch frame (origin, normal, u, v in mm), its outline in that frame, area and bounds. Pass the frame to slicerx_geom_extrude or slicerx_geom_revolve to sketch on the face; outline points are [u, v] in it.',
    input: z.object({ model: modelOrDesign, design: designArg.optional(), face: faceRef }),
    async run(i) {
      oneOf(i)
      let out: Record<string, unknown>
      if (i.design) {
        const d = designOf(i.design)
        const f = pickIn(d, i.face)
        out = { ...(await engine('face.pick', { mesh: item(d, f.part), triangle: f.triangle, at: f.at })), part: f.part, ...(f.key ? { key: f.key } : {}) }
        if (i.face.topology) {
          const current = manifestOf(designOf(d.id))
          if (current.revision !== i.face.topology.revision) throw new ToolInputError('The body changed during inspection. Inspect it again.', 'stale_body', { bodyId: d.id, currentRevision: current.revision })
          out = { ...out, topology: compactManifest(current), measurementSource: 'tessellation' }
        }
      } else {
        const stlPath = await path(i.model!)
        out = await call('face.pick', { mesh: { stlPath }, ...(await pick(stlPath, i.face)) })
      }
      return { summary: `Picked a face of ${Math.round(Number(out['areaMm2'] ?? 0) * 100) / 100} mm2`, output: lean(out) }
    },
  })

  const edgePick = defineTool({
    name: 'geom.edge_pick',
    version: '2.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Pick an edge for a fillet or chamfer on a model or a design: give a point on a flat face near the edge (or on the edge) and that face\'s normal. Returns loopRef and chainRef first: the loop of edges around that face and the tangent chain of the picked edge, each as one entry that slicerx_geom_fillet and slicerx_geom_chamfer take as is (loopEdges, chainEdges: how many edges each names). Then the edge itself (pass it as is too), its length, whether it is convex, whether it can be filleted and why not, and the largest radius and bevel that fit this edge (maxRadiusMm, maxDistanceMm), every edge of its chain (chainMaxRadiusMm, chainMaxDistanceMm) and every edge of its loop the ops take (loopMaxRadiusMm, loopMaxDistanceMm). With list_edges it also lists each edge of the chain and the loop.',
    localDescription:
      'Pick an edge for a fillet or chamfer on a model or design: a point on a flat face near (or on) the edge and that face\'s normal. Returns loopRef and chainRef (the loop of that face and the edge\'s tangent chain, one entry each for geom.fillet or geom.chamfer), the edge (pass it as is), its length, whether it is convex, whether it can be filleted (and why not), the largest radius and bevel for this edge, its chain and its loop (chainMaxRadiusMm, loopMaxRadiusMm).',
    input: z.object({
      model: modelOrDesign,
      design: designArg.optional(),
      face: faceRef.describe('The face the edge bounds: {"at":[x,y,z] near the edge,"normal":[x,y,z]} or {"triangle":n}'),
      list_edges: z.boolean().optional().describe('Also return every edge of the chain and the loop (chain, loop); loopRef and chainRef name them in one entry'),
    }),
    // a local model passes loopRef or chainRef and needs no per-edge lists
    localInput: z.object({ model: localModel, design: localDesign, face: faceRef.describe('The face the edge bounds: {"at":[x,y,z] near the edge,"normal":[x,y,z]} or {"triangle":n}') }),
    async run(i) {
      oneOf(i)
      if (i.face.topology) throw new ToolInputError('A face reference does not uniquely select an edge. Edge topology references are not supported yet.', 'not_supported')
      let out: Record<string, unknown>
      let face: { at: V3; normal: V3 }
      if (i.design) {
        const d = designOf(i.design)
        const f = pickIn(d, i.face)
        face = { at: f.at, normal: f.normal }
        out = { ...(await engine('edge.pick', { mesh: item(d, f.part), triangle: f.triangle, at: f.at })), part: f.part }
      } else {
        const stlPath = await path(i.model!)
        const p = await pick(stlPath, i.face)
        face = { at: p.at, normal: triangles(stlPath)[p.triangle]!.n }
        out = await call('edge.pick', { mesh: { stlPath }, ...p })
      }
      // the whole loop and chain as one entry each, which the fillet and chamfer take as they are
      const { chain, loop, ...rest } = out as { chain: unknown[]; loop: { supported: boolean }[] } & Record<string, unknown>
      // -0 from a triangle normal reads as 0
      const ref = { at: face.at, normal: face.normal.map((v) => v + 0) }
      const sets = { loopRef: { set: 'loop', ...ref }, chainRef: { set: 'chain', ...ref }, loopEdges: loop.filter((l) => l.supported).length, chainEdges: chain.length }
      const output = { ...sets, ...rest, ...(i.list_edges ? { chain, loop } : {}) }
      return { summary: out['supported'] ? `Picked an edge of ${String(out['lengthMm'])} mm, fillet up to ${String(out['maxRadiusMm'])} mm` : `Picked an edge that cannot be filleted: ${String(out['reason'] ?? '')}`, output: lean(output) }
    },
  })

  const sketchCheck = defineTool({
    name: 'geom.sketch_check',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    description: 'Check sketch loops before extruding or revolving: whether they close and do not cross, which are holes, the filled area, and each problem with its loop and segment.',
    input: z.object({ loops: loopsRef }),
    async run(i) {
      const out = deps.designs && !deps.files.engine ? await engine('sketch.check', { loops: i.loops }) : await call('sketch.check', { loops: i.loops })
      return { ok: out['ok'] === true, summary: out['ok'] === true ? `The sketch is closed, ${String(out['areaMm2'])} mm2` : `The sketch has ${Array.isArray(out['issues']) ? out['issues'].length : 0} problem(s)`, output: out }
    },
  })

  const sketchSolve = defineTool({
    name: 'geom.sketch_solve',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Solve a constrained 2D sketch, as the sketch tool does: points, lines, circles and arcs held by constraints (coincident, horizontal, parallel, tangent, distance, angle and the rest). Returns where every point lands, each circle and arc radius, the degrees of freedom left (0 is fully defined), which points can still move, and the constraints that conflict or repeat. Lines, circles and arcs refer to points by index; constraints refer to points and entities by index. Values are mm, angles degrees.',
    input: z.object({
      points: z.array(vec2).min(1).max(4096).describe('Where each point starts, mm'),
      entities: z.array(sketchEntity).max(4096).default([]),
      constraints: z.array(sketchConstraint).max(8192).default([]),
      drag: z.object({ point: z.number().int().min(0), to: vec2 }).optional().describe('Pull one point toward a spot; the rest give way only as the constraints make them'),
    }),
    async run(i) {
      const out = await call('sketch.solve', i)
      const status = String(out['status'])
      const dof = Number(out['dof'])
      const head = status === 'conflict' || status === 'failed' ? `The sketch did not solve (${status}), constraints ${JSON.stringify(out['conflicting'])}` : dof === 0 ? 'Solved, fully defined' : `Solved, ${dof} degree${dof === 1 ? '' : 's'} of freedom left`
      return { ok: status === 'ok' || status === 'redundant', summary: status === 'redundant' ? `${head}; constraints ${JSON.stringify(out['redundant'])} repeat others` : head, output: out }
    },
  })

  const sketchEdit = defineTool({
    name: 'geom.sketch_edit',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    description:
      'Edit sketch loops and get them back (loops and segments from 0, `from` naming each result\'s source loops): intersect lists crossings, trim takes off the piece around a point, extend runs an open end on to the next curve, mirror and pattern add copies; intersect, trim and extend refuse splines and ellipses.',
    input: z.object({
      loops: loopsRef,
      op: z.enum(['intersect', 'trim', 'extend', 'mirror', 'pattern']),
      loop: z.number().int().min(0).optional().describe('trim and extend: the loop'),
      segment: z.number().int().min(0).optional().describe('trim: the segment'),
      at: vec2.optional().describe('trim: a point on the piece to take off, mm'),
      end: z.enum(['start', 'end']).optional().describe('extend: which end'),
      pick: z.array(z.number().int().min(0)).min(1).max(256).optional().describe('mirror and pattern: the loops to copy'),
      axis: z.object({ point: vec2, direction: vec2 }).optional().describe('mirror: the line to mirror across'),
      kind: z.enum(['line', 'circle']).optional().describe('pattern: along a step, or round a center'),
      count: z.number().int().min(2).max(1000).optional().describe('pattern: how many in all, the original counted'),
      step: vec2.optional().describe('pattern along: mm from one copy to the next'),
      center: vec2.optional().describe('pattern round: the center'),
      angle_deg: z.number().min(-360).max(360).optional().describe('pattern round: the angle the copies spread through; 360 spreads them evenly'),
    }),
    async run(i) {
      const need = (what: string, v: unknown) => {
        if (v === undefined) throw new Error(`${i.op} needs ${what}`)
      }
      let req: Record<string, unknown> = { loops: i.loops }
      if (i.op === 'trim') {
        need('loop', i.loop)
        need('segment', i.segment)
        need('at', i.at)
        req = { ...req, loop: i.loop, segment: i.segment, at: i.at }
      } else if (i.op === 'extend') {
        need('loop', i.loop)
        need('end', i.end)
        req = { ...req, loop: i.loop, end: i.end }
      } else if (i.op === 'mirror') {
        need('pick', i.pick)
        need('axis', i.axis)
        req = { ...req, pick: i.pick, axis: i.axis }
      } else if (i.op === 'pattern') {
        need('pick', i.pick)
        need('count', i.count)
        const round = i.kind === 'circle'
        if (round) need('center', i.center)
        else need('step', i.step)
        req = { ...req, pick: i.pick, kind: round ? 'circle' : 'line', count: i.count, ...(round ? { center: i.center, angleDeg: i.angle_deg ?? 360 } : { step: i.step }) }
      }
      const out = await call(`sketch.${i.op}`, req)
      const n = Array.isArray(out['loops']) ? out['loops'].length : 0
      const summary = i.op === 'intersect' ? `${Array.isArray(out['hits']) ? out['hits'].length / 2 : 0} crossing(s)` : `${n} loop${n === 1 ? '' : 's'} after the ${i.op}`
      return { summary, output: out }
    },
  })

  const extrude = defineTool({
    name: 'geom.extrude',
    version: '1.12.2',
    source: 'command',
    permission: 'slice',
    description:
      'Extrude a shape on the bed, a plane or a picked face as a new body, joined to a target or cut from it: with "design" a step (join and cut work on "part"), with a model an STL with volume, bounds and watertightness.',
    input: z.object({
      shape: shape.optional(),
      sketch: z.string().min(1).max(80).optional().describe('With a design: a finished sketch id instead of shape and frame'),
      frame: frameRef.optional(),
      placement: z.object({ center: vec2.optional(), rotationDeg: z.number().optional() }).optional().describe('Where the shape sits in the plane: center [u, v] and rotation, degrees'),
      distance_mm: z.number().positive().max(10_000),
      extent: z.enum(['oneSide', 'symmetric', 'twoSides']).default('oneSide').describe('oneSide: distance_mm out from the plane; symmetric: distance_mm to each side; twoSides: distance_mm and distance2_mm'),
      distance2_mm: z.number().positive().max(10_000).optional().describe('Second distance for extent twoSides'),
      flip: z.boolean().optional().describe('Reverse the direction. By default new and join go out along the plane normal and cut goes into the face'),
      taper_deg: z.number().min(-45).max(45).optional().describe('Draft angle; positive narrows away from the plane'),
      operation,
      target: modelArg.optional().describe('The model to join to or cut from'),
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      name: z.string().min(1).max(120).optional().describe('With a design: the name of the new part a new body makes'),
      slot: slotArg,
    }),
    async run(i) {
      slotOk(i)
      const spec = { distanceMm: i.distance_mm, extent: i.extent, operation: i.operation, ...(i.distance2_mm !== undefined ? { distance2Mm: i.distance2_mm } : {}), ...(i.flip !== undefined ? { flip: i.flip } : {}), ...(i.taper_deg !== undefined ? { taperDeg: i.taper_deg } : {}) }
      const verb = i.operation === 'cut' ? 'Cut' : i.operation === 'join' ? 'Joined' : 'Extruded'
      if (i.sketch !== undefined && (i.shape || i.frame)) throw new ToolInputError('sketch: the sketch gives the shape and plane; leave shape and frame out')
      const f = i.frame
      if (i.shape?.type === 'sketch') splinesOk(i.shape.loops)
      if (i.design) {
        const d = designOf(i.design)
        const part = targetPart(d, i.target, i.part)
        const k = i.sketch !== undefined ? finished(i.sketch, d.id) : null
        const frame = k ? k.frame : frameOf(f)
        const drawn = k ? { type: 'sketch' as const, loops: k.loops, ...(k.constraints ? { constraints: k.constraints } : {}) } : i.shape
        if (!drawn) throw new ToolInputError('shape: give a shape, or a finished sketch id as sketch')
        const piece = newPiece(d, i)
        const params: StepParams = plain({ op: 'shape.extrude', frame, shape: drawn, placement: i.placement, spec, name: piece ?? i.name, slot: i.slot })
        const on = i.operation === 'join' ? (part ?? 0) : -1
        const before = on >= 0 ? partBoxes(d) : []
        const n = d.parts.length
        await designs().add(d, i.operation === 'new' ? d.parts.length : (part ?? 0), params, undefined, withFeature(i.feature, k ? { sketch: k.id } : undefined))
        // parts that stood on the body this raised are lifted onto its new top, at the steps that made them, with
        // their paint; the answer says so
        const sunk = on >= 0 ? sunkParts(d, on, before) : []
        const liftable = sunk.filter((s) => s.step >= 0)
        if (liftable.length) {
          const steps = d.history.steps.map((x, j) => {
            const lift = liftable.find((s) => s.step === j)
            if (lift) {
              const moved = movedStep(x, [0, 0, lift.depthMm], d.transform)
              return typeof moved === 'string' ? x : { ...x, params: moved }
            }
            const later = liftable.find((s) => j > s.step && x.part === s.part && x.params.op === 'paint')
            return later && x.params.op === 'paint' ? { ...x, params: movedPaint(x.params, [0, 0, later.depthMm], d.transform) } : x
          })
          await replayChange(designs(), d, { ...d.history, steps })
        }
        const out = await seated(d, i.operation, n, pieceNamed(stepOut(d, verb), piece, i.name))
        const lifted = liftable.map((s) => `${d.parts[s.part]!.name} ${roundTenth(s.depthMm)} mm`).join(', ')
        const said = [lifted ? `Lifted ${lifted} onto the new top of ${d.parts[on]!.name}, at the steps that made them` : '', on >= 0 ? sunkNote(d, on, sunk) : ''].filter(Boolean).join('. ')
        return said ? { ...out, summary: `${out.summary.replace(/[.\s]+$/, '')}. ${said}` } : out
      }
      if (i.sketch !== undefined) throw new ToolInputError('sketch: a finished sketch extrudes on a design; give its id as design')
      if (!i.shape) throw new ToolInputError('shape: give the shape to extrude')
      const out = await call('shape.extrude', { shape: i.shape, ...plane(f), ...(i.placement ? { placement: i.placement } : {}), spec, ...(await target(i.target, i.operation)) })
      return { summary: `${verb} a ${i.shape.type} ${i.distance_mm} mm`, output: out }
    },
  })

  const revolve = defineTool({
    name: 'geom.revolve',
    version: '1.10.0',
    source: 'command',
    permission: 'slice',
    description: 'Revolve closed sketch loops around an axis in their plane, up to 360 degrees and on one side of the axis, as a new body, joined to a target or cut from it: with "design" a step, else an STL.',
    input: z.object({
      loops: loops.optional(),
      sketch: z.string().min(1).max(80).optional().describe('With a design: a finished sketch id instead of loops and frame'),
      frame: frameSchema.optional(),
      axis: z.object({ point: vec2, direction: vec2 }).describe('The axis in the sketch plane, [u, v]'),
      angle_deg: z.number().positive().max(360).default(360),
      operation,
      target: modelArg.optional(),
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      name: z.string().min(1).max(120).optional().describe('With a design: the name of the new part a new body makes'),
      slot: slotArg,
    }),
    async run(i) {
      slotOk(i)
      if (i.sketch !== undefined && (i.loops || i.frame)) throw new ToolInputError('sketch: the sketch gives the loops and plane; leave loops and frame out')
      if (i.loops) splinesOk(i.loops)
      if (i.design) {
        const d = designOf(i.design)
        const part = targetPart(d, i.target, i.part)
        const k = i.sketch !== undefined ? finished(i.sketch, d.id) : null
        const frame = k ? k.frame : frameOf(i.frame)
        const drawn = k ? k.loops : i.loops
        if (!drawn) throw new ToolInputError('loops: give the loops, or a finished sketch id as sketch')
        const piece = newPiece(d, i)
        const params: StepParams = plain({ op: 'sketch.revolve', frame, loops: drawn, ...(k?.constraints ? { constraints: k.constraints } : {}), axis: i.axis, angleDeg: i.angle_deg, operation: i.operation, name: piece ?? i.name, slot: i.slot })
        const n = d.parts.length
        await designs().add(d, i.operation === 'new' ? d.parts.length : (part ?? 0), params, undefined, withFeature(i.feature, k ? { sketch: k.id } : undefined))
        return seated(d, i.operation, n, pieceNamed(stepOut(d, 'Revolved'), piece, i.name))
      }
      if (i.sketch !== undefined) throw new ToolInputError('sketch: a finished sketch revolves on a design; give its id as design')
      if (!i.loops) throw new ToolInputError('loops: give the loops to revolve')
      const out = await call('sketch.revolve', { loops: i.loops, ...plane(i.frame), axis: i.axis, angleDeg: i.angle_deg, operation: i.operation, ...(await target(i.target, i.operation)) })
      return { summary: `Revolved the sketch ${i.angle_deg} degrees`, output: out }
    },
  })

  // A profile is checked against the same frame and loops as slicerx_geom_revolve, but its schema only points there:
  // spelling them out again would cost a small local model's context the size of a second revolve.
  const chain = z.union([z.object({ start: vec2, segments: z.array(segment).min(1).max(512) }), z.object({ points: z.array(vec2).min(2).max(4096) })])
  // an open profile is one chain with two ends, as a sweep path is
  const marks = z.array(vec2).max(64).optional()
  const closedProfile = z.object({ frame: frameSchema.optional(), loops, open: z.literal(false).optional(), landmarks: marks })
  const openProfile = z.object({ frame: frameSchema.optional(), loops: z.array(chain).length(1), open: z.literal(true), landmarks: marks })
  const profileShape = z.union([openProfile, closedProfile])
  const shapeOf = (p: { open?: unknown }) => (p.open === true ? openProfile : closedProfile)
  // checked in the tool (parsedAt), so each build turn carries only the short schema below
  const thickenShape = z.object({ thicknessMm: z.number().positive().max(1000), side: z.enum(['outward', 'inward', 'center']).optional() })
  const thicken = z.unknown().describe('{thicknessMm, side: outward|inward|center}: sides as a shell; open profiles need it')
  const profileOut = (f: z.infer<typeof profileShape>, frame: unknown) => ({ ...(frame as object), loops: f.loops, ...(f.open ? { open: true } : {}), ...(f.landmarks?.length ? { landmarks: f.landmarks } : {}) })
  const loftProfile = z
    .object({ frame: z.unknown().optional(), loops: z.array(z.unknown()).min(1).max(256), open: z.boolean().optional(), landmarks: z.array(z.unknown()).optional() })
    .superRefine((p, ctx) => {
      const r = shapeOf(p).safeParse(p)
      if (!r.success) for (const e of r.error.issues) ctx.addIssue({ code: 'custom', message: e.message, path: e.path })
    })
    .describe('One loop and its frame, as revolve takes them; open: an open chain; landmarks: [x,y] matched in order')
  const loft = defineTool({
    name: 'geom.loft',
    version: '1.12.0',
    source: 'command',
    permission: 'slice',
    description:
      'Loft a solid through 2 to 64 profiles in order, each on its own plane, as a new body, joined to or cut from a target; neighbors must not touch or cross each other\'s plane. thicken makes it hollow with open ends (a tapered stem, a vase).',
    input: z.object({
      profiles: z.array(loftProfile).min(2).max(64).optional().describe('In loft order; no frame is the bed'),
      smooth: z.boolean().optional().describe('Curved sides through the sections; a section may have arcs and splines, and its straight segments stay straight'),
      closed: z.boolean().optional().describe('Last joins first'),
      thicken: thicken.optional(),
      exact: z.boolean().optional().describe('Without a design: also return the exact solid. A design decides its own'),
      sketches: z.array(z.string().min(1).max(80)).min(2).max(64).optional().describe('With a design: finished sketch ids in loft order, not profiles'),
      operation,
      target: modelArg.optional().describe('Model to join to or cut from'),
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      name: z.string().min(1).max(120).optional().describe('With a design: the name of the new part a new body makes'),
      slot: slotArg,
    }),
    async run(i) {
      slotOk(i)
      if (!i.profiles === !i.sketches) throw new ToolInputError(i.profiles ? 'sketches: give profiles or sketches, not both' : 'profiles: give 2 or more profiles, or finished sketch ids as sketches')
      const verb = i.operation === 'cut' ? 'Cut' : i.operation === 'join' ? 'Joined' : 'Lofted'
      const th = i.thicken === undefined ? undefined : parsedAt(thickenShape, i.thicken, 'thicken')
      const loftOpts = { ...(i.smooth ? { smooth: true } : {}), ...(i.closed ? { closed: true } : {}), ...(th ? { thicken: th } : {}) }
      if (i.design) {
        const d = designOf(i.design)
        const part = targetPart(d, i.target, i.part)
        const profiles = i.sketches ? i.sketches.map((id) => finished(id, d.id)).map((k) => ({ frame: k.frame, loops: k.loops })) : i.profiles!.map((p, k) => parsedAt(shapeOf(p), p, `profiles.${k}`)).map((f) => profileOut(f, { frame: frameOf(f.frame) }))
        const piece = newPiece(d, i)
        const params: StepParams = loftParams({ profiles, ...loftOpts, operation: i.operation, name: piece ?? i.name, slot: i.slot })
        const n = d.parts.length
        await designs().add(d, i.operation === 'new' ? d.parts.length : (part ?? 0), params, undefined, withFeature(i.feature))
        // exact is not read here: the step is added, and the design's own replay decides whether its body is exact
        const out = await seated(d, i.operation, n, pieceNamed(stepOut(d, verb), piece, i.name))
        // a body's sections under two nozzle lines are named, never refused; a cut or a thickened shell has its own reading
        return i.operation === 'cut' || th ? out : withThinNote(out, profiles as LoftSection[], nozzleOr(deps.nozzleMm?.()))
      }
      if (i.sketches) throw new ToolInputError('sketches: finished sketches loft on a design; give its id as design')
      const profiles = i.profiles!.map((p, k) => parsedAt(shapeOf(p), p, `profiles.${k}`)).map((f) => profileOut(f, plane(f.frame)))
      // each call is a run of the engine of its own, so the exact body comes back as text (bodySmb), not as a number
      const out = await call('sketch.loft', { profiles, ...loftOpts, ...(i.exact ? { exact: true, save: true } : {}), operation: i.operation, ...(await target(i.target, i.operation)) })
      const made = !i.exact ? '' : typeof out['bodySmb'] === 'string' ? ', with its exact solid' : ', without an exact solid'
      return { summary: `${verb} through ${profiles.length} profiles${made}`, output: out }
    },
  })

  // Kept small: a local model gets every build tool's schema on each build turn. The tool parses the profile and path
  // against the full schemas below, so the step and the app get the parsed loops, and a bad field is named by its path.
  const sweepProfile = z.object({ frame: frameSchema.optional(), loops, open: z.literal(false).optional() })
  const openSweepProfile = z.object({ frame: frameSchema.optional(), loops: z.array(chain).length(1), open: z.literal(true) })
  const sweepEnd = z.object({ loops, open: z.literal(false).optional() })
  const openSweepEnd = z.object({ loops: z.array(chain).length(1), open: z.literal(true) })
  const sweepPath = z.object({ frame: frameSchema.optional(), loops: z.array(chain).length(1).optional(), points: z.array(vec3).min(2).max(4096).optional(), smooth: z.boolean().optional() })
  const scaleShape = z.union([z.number().min(0.05).max(20), z.tuple([z.number().min(0.05).max(20), z.number().min(0.05).max(20)])])
  const twistShape = z.number().min(-3600).max(3600)
  const sweep = defineTool({
    name: 'geom.sweep',
    version: '1.11.0',
    source: 'command',
    permission: 'slice',
    description: 'Sweep a profile along an open path (hook, handle, pipe, spout) as a body, joined or cut (must overlap the part); scale, twist_deg and end_profile taper, turn and reshape it. A hook starts inside a side wall below its top, not on an open top, and its path ends bending up into a lip. With "design" it adds a step.',
    input: z.object({
      profile: z.object({ frame: z.unknown().optional(), loops: z.array(z.unknown()), open: z.boolean().optional() }).optional().describe("Loops (inner ones are holes) and frame as revolve takes; plane across the path's start; open: open chain"),
      path: z.object({ frame: z.unknown().optional(), loops: z.array(z.unknown()).optional(), points: z.array(z.array(z.number())).optional(), smooth: z.boolean().optional() }).optional().describe('Open chain (frame, loops) or points; smooth: curve through points'),
      profile_sketch: z.string().optional(),
      path_sketch: z.string().optional(),
      thicken: thicken.optional(),
      scale: z.unknown().optional().describe('End size: n or [u,v]'),
      twist_deg: z.number().optional().describe('Turn by the end'),
      ease: z.enum(['linear', 'smooth']).optional(),
      end_profile: z.unknown().optional().describe('Loop it ends as'),
      operation: z.enum(['new', 'join', 'cut']).default('new'),
      target: z.string().optional().describe('STL to join or cut'),
      design: z.string().optional(),
      feature: featureArg,
      part: z.number().int().min(0).optional(),
      name: z.string().optional(),
      slot: slotArg,
    }),
    async run(i) {
      slotOk(i)
      if (!i.profile === !i.profile_sketch) throw new ToolInputError(i.profile ? 'profile_sketch: give profile or profile_sketch, not both' : 'profile: give the profile, or a finished sketch id as profile_sketch')
      if (!i.path === !i.path_sketch) throw new ToolInputError(i.path ? 'path_sketch: give path or path_sketch, not both' : 'path: give the path, or a finished sketch id as path_sketch')
      if (i.path && !i.path.loops && !i.path.points) throw new ToolInputError('path: give the path as loops on a plane or as points')
      if (i.path?.loops && i.path.points) throw new ToolInputError('path: give loops or points, not both')
      const verb = i.operation === 'cut' ? 'Cut' : i.operation === 'join' ? 'Joined' : 'Swept'
      const th = i.thicken === undefined ? undefined : parsedAt(thickenShape, i.thicken, 'thicken')
      const scale = i.scale === undefined ? undefined : parsedAt(scaleShape, i.scale, 'scale')
      const twist = i.twist_deg === undefined ? undefined : parsedAt(twistShape, i.twist_deg, 'twist_deg')
      // the engine's names, so a step replays with the taper and twist it was made with
      const law = { ...(scale !== undefined && scale !== 1 ? { scaleEnd: scale } : {}), ...(twist ? { twistDeg: twist } : {}), ...(i.ease === 'smooth' ? { ease: i.ease } : {}) }
      const prof = i.profile ? parsedAt(i.profile.open === true ? openSweepProfile : sweepProfile, i.profile, 'profile') : undefined
      // the section it turns into by the end, drawn on the profile's own plane
      const end = i.end_profile as { frame?: unknown; open?: unknown } | undefined
      if (end && typeof end === 'object' && 'frame' in end) throw new ToolInputError("end_profile.frame: the end loop is drawn on the profile's own plane; leave its frame out")
      const last = end === undefined ? undefined : parsedAt(typeof end === 'object' && end.open === true ? openSweepEnd : sweepEnd, end, 'end_profile')
      const morph = last ? { endProfile: { loops: last.loops as SketchLoop[], ...(last.open ? { open: true } : {}) } } : {}
      const pth = i.path ? parsedAt(sweepPath, i.path, 'path') : undefined
      if (pth?.smooth && !pth.points) throw new ToolInputError('path.smooth: smooth is for a path of points; draw a spline for a smooth path on a plane')
      const smooth = pth?.smooth ? { smooth: true } : {}
      const pf = prof?.frame
      const qf = pth?.frame
      const profileLoops = prof?.loops as SketchLoop[] | undefined
      const pathLoops = pth?.loops as SketchLoop[] | undefined
      const points = pth?.points
      const firstPath = pathLoops?.[0]
      const pathStart = points?.[0] ?? (firstPath ? loopStart(frameOf(qf), firstPath) : undefined)
      const away = profileLoops && pathStart ? profileOffPath(frameOf(pf), profileLoops, pathStart as V3) : null
      if (away) throw new ToolInputError(away)
      if (i.design) {
        const d = designOf(i.design)
        const part = targetPart(d, i.target, i.part)
        const k = i.profile_sketch ? finished(i.profile_sketch, d.id) : null
        const profile = k ? { frame: k.frame, loops: k.loops } : { frame: frameOf(pf), loops: profileLoops!, ...(prof?.open ? { open: true } : {}) }
        const j = i.path_sketch ? finished(i.path_sketch, d.id) : null
        const path = j ? { frame: j.frame, loops: j.loops } : points ? { points, ...smooth } : { frame: frameOf(qf), loops: pathLoops! }
        const piece = newPiece(d, i)
        const params: StepParams = sweepParams({ profile, path, thicken: th, ...law, ...morph, operation: i.operation, name: piece ?? i.name, slot: i.slot })
        const n = d.parts.length
        await designs().add(d, i.operation === 'new' ? d.parts.length : (part ?? 0), params, undefined, withFeature(i.feature))
        return seated(d, i.operation, n, pieceNamed(stepOut(d, verb), piece, i.name))
      }
      if (i.profile_sketch || i.path_sketch) throw new ToolInputError(`${i.profile_sketch ? 'profile_sketch' : 'path_sketch'}: finished sketches sweep on a design; give its id as design`)
      const path = points ? { points, ...smooth } : { ...plane(qf), loops: pathLoops }
      const out = await call('sketch.sweep', { profile: { ...plane(pf), loops: profileLoops, ...(prof?.open ? { open: true } : {}) }, path, ...(th ? { thicken: th } : {}), ...law, ...morph, operation: i.operation, ...(await target(i.target, i.operation)) })
      return { summary: `${verb} the profile along the path`, output: out }
    },
  })

  const sketch = defineTool({
    name: 'design.sketch',
    version: '1.4.0',
    source: 'command',
    permission: 'slice',
    description: `Finish a sketch into the open project's design timeline without a solid, solving its constraints first (a dimension that would over-define it stays driven), and return its id to pass as sketch to slicerx_geom_extrude or slicerx_geom_revolve. With design, the frame is in that design's own coordinates, as its other tools take them. Without, it is in the plate's while no design was moved onto the bed; after that it is the only design's, or name the design.`,
    input: z.object({ loops: loopsRef, frame: frameRef.optional(), constraints: z.array(loopConstraint).max(8192).optional(), design: designArg.optional().describe("The design the sketch is drawn for: its frame is in that design's coordinates") }),
    async run(i) {
      const loopsIn = i.loops
      splinesOk(loopsIn)
      const host = deps.designs
      if (!host?.addSketch) throw new ToolInputError('Finished sketches live in the design timeline of the project open in the app; turn on the app link there, then try again')
      // the design it is drawn for, or why there is none to pick, before anything is checked or solved
      const forId = sketchFor(i.design)
      await splinesDraw(loopsIn)
      const frame = frameOf(i.frame)
      if (!i.constraints?.length) {
        const k = host.addSketch(plain({ ...(frame ? { frame } : {}), loops: loopsIn }), forId)
        return { summary: `${k.name} is in the timeline${splines(loopsIn)}`, output: { id: k.id, name: k.name, loops: k.loops.length } }
      }
      if (!host.settleSketch) throw new ToolInputError('constraints: this host cannot solve sketches; leave them out')
      const solved = await host.settleSketch(plain({ loops: loopsIn, constraints: i.constraints as unknown as SketchConstraint[] }))
      if (solved.status === 'conflict' || solved.status === 'failed') throw new ToolInputError(`constraints: they conflict (${solved.status}), so the sketch was not added; slicerx_geom_sketch_solve names the clashing ones`)
      // the solve moves spline points: two on one spot, or one dragged far, is refused here too
      await splinesDraw(solved.loops)
      const k = host.addSketch(plain({ ...(frame ? { frame } : {}), loops: solved.loops, constraints: solved.constraints }), forId)
      const driven = solved.constraints.flatMap((c, n) => ('driven' in c && c.driven ? [n] : []))
      const head = solved.dof === 0 ? 'fully defined' : `${solved.dof} degree${solved.dof === 1 ? '' : 's'} of freedom left`
      return { summary: `${k.name} is in the timeline${splines(loopsIn)}, ${head}${driven.length ? `; dimensions ${JSON.stringify(driven)} are driven` : ''}`, output: { id: k.id, name: k.name, loops: k.loops, dof: solved.dof, driven } }
    },
  })

  const sketchSvg = defineTool({
    name: 'design.sketch_svg',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description: `Turn SVG artwork into a finished sketch in the open project's design timeline, as Import SVG in the sketch tool does: each closed path of a filled or stroked shape becomes a loop of lines, arcs, circles and splines (holes stay loops inside, transforms apply), ready to edit, dimension, or pass as sketch to slicerx_geom_extrude or slicerx_geom_revolve. Open strokes, text and images are left out and named in warnings. Returns the sketch id, its loops as stored, how many of each curve, the size, and the sketch check (holes, area, any crossings).`,
    input: z
      .object({
        svg: z
          .string()
          .min(1)
          .describe(`The SVG file as text. With the other fields it may come to ${kb(SVG_ARGS)} (${SVG_ARGS} bytes of UTF-8 JSON, quotes escaped), the most the app link carries`),
        frame: frameRef.optional(),
        design: designArg.optional().describe("The design the sketch is drawn for: frame and center are in that design's coordinates"),
        scale: z.number().positive().optional().describe("mm per SVG unit; the file's own size when absent, and the fits are ignored when given"),
        fit_width_mm: z.number().positive().max(10_000).optional().describe('Scale the artwork to this width'),
        fit_height_mm: z.number().positive().max(10_000).optional().describe('Scale the artwork to this height, when no width is given'),
        center: vec2.optional().describe("Where the middle of the artwork lands, sketch mm; when absent, the middle of the plane: the bed's middle on the bed, the frame's origin on a plane or face"),
        tolerance_mm: z.number().min(0.001).max(1).optional().describe('How far a spline may stray from a curve of the artwork, 0.001 to 1; 0.01 when absent'),
      })
      .superRefine((args, ctx) => {
        // the link counts the bytes of every field as it sends them, so non-Latin text counts 2 to 4 a character
        const sent = new TextEncoder().encode(JSON.stringify(args)).length
        if (sent > SVG_ARGS) ctx.addIssue({ code: 'custom', path: ['svg'], message: `This SVG comes to ${kb(sent)} once sent to the app, and the app link takes ${kb(SVG_ARGS)}. Simplify it in a vector editor (fewer points, no embedded images, fonts, metadata or long text), or split it and import each part with its own center.` })
      }),
    async run(i) {
      const host = deps.designs
      if (!host?.addSketch) throw new ToolInputError('Finished sketches live in the design timeline of the project open in the app; turn on the app link there, then try again')
      // the design it is drawn for, named or the only one there is once one was moved onto the bed, first: the default
      // center is the middle of the plane, as the sketch panel starts it, which on the bed is the bed's middle in the
      // plate's coordinates, so in that design's frame it is less its landing
      const forId = sketchFor(i.design)
      const bed = i.frame ? undefined : host.bed?.()
      const off = forId !== undefined && bed ? (designOf(forId).placed ?? [0, 0]) : [0, 0]
      const center = i.center ?? (bed ? [bed.widthMm / 2 - off[0]!, bed.depthMm / 2 - off[1]!] : [0, 0])
      const options = plain<Record<string, unknown>>({ scale: i.scale, fitWidthMm: i.fit_width_mm, fitHeightMm: i.fit_height_mm, center, toleranceMm: i.tolerance_mm })
      const req = { svg: i.svg, options }
      const out = deps.files.engine ? await call('sketch.svg', req) : await engine('sketch.svg', req)
      const loopsIn = out['loops'] as Loops
      const check = (out['check'] ?? {}) as { ok?: boolean; areaMm2?: number; loops?: { index: number; role: string; areaMm2: number; lengthMm: number }[]; issues?: { kind: string; message: string }[] }
      const issues = check.issues ?? []
      // a spline that cannot be drawn never reaches the timeline, as for design.sketch
      const bad = undrawable(issues, loopsIn)
      if (bad.length) throw new ToolInputError(`svg: ${bad.map((x) => x.message).join(' ')} Raise tolerance_mm or simplify the artwork.`)
      const k = host.addSketch(plain({ ...(i.frame ? { frame: frameOf(i.frame) } : {}), loops: loopsIn }), forId)
      const counts = out['counts'] as { lines: number; arcs: number; splines: number; circles: number }
      const size = out['sizeMm'] as [number, number]
      const holes = (check.loops ?? []).filter((l) => l.role === 'hole').length
      const n = (v: number, one: string) => `${v} ${one}${v === 1 ? '' : 's'}`
      const curves = [n(counts.lines, 'line'), n(counts.arcs, 'arc'), n(counts.splines, 'spline'), n(counts.circles, 'circle')].filter((t) => !t.startsWith('0 ')).join(', ')
      const warnings = (out['warnings'] ?? []) as string[]
      const head = `${k.name} is in the timeline: ${n(k.loops.length, 'loop')}${holes ? ` (${n(holes, 'hole')})` : ''}, ${curves}, ${size.map((v) => Math.round(v * 100) / 100).join(' x ')} mm`
      const tail = [check.ok === false ? `${n(issues.length, 'problem')} to fix before it makes a solid: ${issues.map((x) => x.message).join(' ')}` : '', ...warnings.map((w) => `${w[0]!.toUpperCase()}${w.slice(1)}.`)].filter(Boolean)
      return {
        summary: tail.length ? `${head}. ${tail.join(' ')}` : head,
        output: { id: k.id, name: k.name, loops: k.loops, counts, sizeMm: size, mmPerUnit: out['mmPerUnit'], check: { ok: check.ok, areaMm2: check.areaMm2, loops: check.loops, issues }, warnings },
      }
    },
  })

  const sketchProject = defineTool({
    name: 'design.sketch_project',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description:
      "Project model geometry onto a finished sketch's plane as sketch curves that follow it when the design changes: picked edges (from slicerx_geom_edge_pick, chained where they meet), a face's outline with its holes, or a body's whole outline seen along the sketch normal (kind silhouette). mode real (the default) makes them profile curves for slicerx_geom_extrude or slicerx_geom_revolve; reference keeps them as construction curves that make no profile. Extrudes and revolves made from the sketch before a projection never take it. With projection, switch one's mode or remove it. Returns every projection of the sketch with its curves, and why when a source is gone.",
    input: z.object({
      sketch: z.string().min(1).max(80).describe('A finished sketch id, from slicerx_design_sketch or slicerx_design_timeline'),
      design: designArg.optional().describe('The body to project from'),
      kind: z.enum(['edges', 'face', 'silhouette']).optional(),
      part: partArg,
      edges: z.array(edgeRef).min(1).max(256).optional(),
      face: faceRef.optional(),
      mode: z.enum(['reference', 'real']).optional().describe('real: profile curves (the default for a new projection); reference: construction curves'),
      projection: z.string().min(1).max(16).optional().describe('A projection of the sketch (p1, p2 and on) to switch or remove'),
      remove: z.boolean().optional(),
    }),
    async run(i) {
      const host = deps.designs
      if (!host?.project || !host.changeProjection) throw new ToolInputError('Finished sketches live in the design timeline of the project open in the app; turn on the app link there, then try again')
      const words = (mode: ProjectMode) => (mode === 'real' ? 'real curves' : 'reference curves')
      const out = (k: SketchItem, replayed: number, extra: Record<string, unknown>) => ({ sketch: k.id, name: k.name, ...extra, projections: projectionsOut(k), loops: k.loops.length, replayed })
      const rebuilt = (n: number) => (n ? `; rebuilt ${n === 1 ? 'the body' : `${n} bodies`} drawn on it` : '')
      if (i.projection !== undefined) {
        if (i.kind || i.design || i.edges || i.face) throw new ToolInputError('projection: to change a projection give only its mode, or remove: true')
        if (!i.remove === !i.mode) throw new ToolInputError(i.remove ? 'mode: give mode or remove, not both' : 'mode: give the mode to switch to, or remove: true')
        const r = await host.changeProjection(i.sketch, i.projection, i.remove ? { remove: true } : { mode: i.mode! })
        const what = i.remove ? `Removed ${i.projection} and its curves from ${r.sketch.name}` : `${i.projection} of ${r.sketch.name} is now ${words(i.mode!)}`
        return { summary: `${what}${rebuilt(r.replayed)}`, output: out(r.sketch, r.replayed, i.remove ? {} : { projection: i.projection }) }
      }
      if (i.remove) throw new ToolInputError('projection: name the projection to remove')
      if (!i.kind) throw new ToolInputError('kind: edges, face or silhouette')
      if (!i.design) throw new ToolInputError('design: the body to project from')
      if (i.kind !== 'edges' && i.edges) throw new ToolInputError(`edges: kind ${i.kind} takes no edges`)
      if (i.kind !== 'face' && i.face) throw new ToolInputError(`face: kind ${i.kind} takes no face`)
      const d = designOf(i.design)
      let source: ProjectSource
      if (i.kind === 'edges') {
        if (!i.edges) throw new ToolInputError('edges: the edges to project, from slicerx_geom_edge_pick')
        source = { kind: 'edges', body: d.id, part: i.part ?? partAt(d, i.edges[0]!.a), transform: [...d.transform], edges: plain(i.edges) }
      } else if (i.kind === 'face') {
        if (!i.face) throw new ToolInputError('face: the face to project: {"at":[x,y,z],"normal":[x,y,z]} or {"triangle":n}')
        const f = pickIn(d, i.face)
        source = { kind: 'face', body: d.id, part: f.part, transform: [...d.transform], face: { at: f.at, normal: f.normal, ...(f.key ? { key: f.key } : {}) } }
      } else source = { kind: 'silhouette', body: d.id }
      const mode = i.mode ?? 'real'
      const r = await host.project(i.sketch, source, mode)
      const curves = curveWords(r.sketch.loops.filter((l) => l.projected === r.projection))
      const what = i.kind === 'edges' ? `${i.edges!.length === 1 ? 'an edge' : `${i.edges!.length} edges`}` : i.kind === 'face' ? 'the face outline' : 'the outline'
      return { summary: `Projected ${what} of ${d.name} into ${r.sketch.name} as ${words(mode)}: ${curves}${rebuilt(r.replayed)}`, output: out(r.sketch, r.replayed, { projection: r.projection }) }
    },
  })

  const traceImage = defineTool({
    name: 'design.trace_image',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description: `Trace a PNG or JPEG into a finished sketch in the open project's design timeline, as Trace image in the sketch tool does: the inside (dark or light areas, opaque areas, or picked colors) is found, specks are cleaned away, and its edges become loops of lines, arcs, circles and splines (holes stay loops inside), ready to edit, dimension, or pass as sketch to slicerx_geom_extrude or slicerx_geom_revolve. The image is traced on this server, so it may be large; the loops then go to the timeline as slicerx_design_sketch sends them. Use dry_run to tune the settings first, and preview_image to see the loops over the image. Returns the sketch id, its loops, how many of each curve, the size, what was cleaned away, and the sketch check.`,
    input: z
      .object({
        image: z
          .union([z.object({ path: z.string().min(1).describe('A .png, .jpg or .jpeg file inside the directories this server may read') }), z.object({ base64: z.string().min(1).describe('The file itself as base64') })])
          .describe('The image, as {path} or {base64}; at most 30 MB'),
        mode: z.enum(['auto', 'dark', 'light', 'color', 'alpha']).optional().describe('What is inside: auto (opaque areas when the image has transparency, else the dark side of an automatic split), dark, light, color (near a picked color) or alpha (opaque areas)'),
        threshold: z.number().min(0).max(255).optional().describe('Luminance 0 to 255 between inside and outside, for dark and light; automatic when absent'),
        colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color is #rrggbb')).min(1).max(8).optional().describe('For mode color: up to 8 colors as #rrggbb'),
        color_tolerance: z.number().min(0).max(100).optional().describe('How near a picked color a pixel must be, 0 to 100; 12 when absent'),
        speck_mm2: z.number().min(0).optional().describe('Specks and pinholes under this area are cleaned away, mm²; 0.5 when absent'),
        smoothing_mm: z.number().min(0.01).max(10).optional().describe('How far a fitted curve may stray from the traced edge, mm; half a working pixel when absent'),
        fit: z.enum(['lines', 'arcs', 'curves']).optional().describe('lines, arcs (lines and arcs) or curves (lines, arcs and splines, the default)'),
        corner_angle_deg: z.number().min(1).max(179).optional().describe('A turn sharper than this is a corner; 50 when absent'),
        width_mm: z.number().positive().max(10_000).optional().describe('The trace is this wide; 50 mm when no size is given'),
        height_mm: z.number().positive().max(10_000).optional().describe('The trace is this tall'),
        mm_per_px: z.number().positive().max(100).optional().describe('mm per pixel of the image as given'),
        center: vec2.optional().describe("Where the middle of the trace lands, sketch mm; when absent, the middle of the plane: on the bed, the middle of the app's bed while the app is linked, else this server's bed, else the origin; on a plane or face, the frame's origin"),
        frame: frameRef.optional(),
        design: designArg.optional().describe("The design the sketch is drawn for: frame and center are in that design's coordinates, as for slicerx_design_sketch"),
        max_side_px: z.number().int().min(16).max(4096).optional().describe('The image is shrunk to this long side before tracing; 2048 when absent'),
        dry_run: z.boolean().optional().describe('Trace and report without adding anything to the timeline'),
        preview_image: z.boolean().optional().describe('Also return a PNG of the image with the loops drawn over it'),
      })
      .superRefine((args, ctx) => {
        const sizes = [args.width_mm, args.height_mm, args.mm_per_px].filter((v) => v !== undefined).length
        if (sizes > 1) ctx.addIssue({ code: 'custom', path: ['width_mm'], message: 'give one of width_mm, height_mm and mm_per_px' })
        if (args.mode === 'color' && !args.colors) ctx.addIssue({ code: 'custom', path: ['colors'], message: 'mode color needs colors' })
      }),
    async run(i, ctx) {
      const bytes = 'path' in i.image ? readImage(i.image.path) : Buffer.from(i.image.base64, 'base64')
      if (bytes.length > IMAGE_BYTES) throw imageTooLarge(bytes.length)
      if (bytes.length === 0) throw new ToolInputError('image: the file is empty. Pass a PNG or JPEG as {path} or {base64}.')
      if (!deps.files.engine && !deps.designs) throw new ToolInputError('Tracing needs the sx-geom engine, which this server did not find.', 'not_supported')
      // the middle of the plane, as the sketch panel and design.sketch_svg start it: the bed's middle on the bed (the
      // app's bed while its link answers, else this server's), the frame's origin on a plane or face
      const local = deps.designs?.bed?.()
      const bedMiddle = i.frame || i.center ? undefined : ((await deps.sketchVia?.bedMiddle?.()) ?? (local ? ([local.widthMm / 2, local.depthMm / 2] as [number, number]) : undefined))
      // the design the trace is drawn for, as design.sketch picks it (the app's when it is routed there), sent on with
      // the loops; the bed's middle is on the plate, so in the frame of a design moved onto the bed it is less that move
      const pick = async () => (deps.sketchVia?.drawnFor ? deps.sketchVia.drawnFor(i.design) : ((id) => (id === undefined ? undefined : { design: id, placed: designOf(id).placed }))(sketchFor(i.design)))
      // a dry run adds nothing, so a design that cannot be picked yet only leaves its center on the plate
      const drawn = await pick().catch((e: unknown) => {
        if (i.dry_run) return undefined
        throw e
      })
      const off: [number, number] = bedMiddle ? (drawn?.placed ?? [0, 0]) : [0, 0]
      const middle = bedMiddle ? ([bedMiddle[0] - off[0], bedMiddle[1] - off[1]] as [number, number]) : undefined
      const center = i.center ?? middle ?? [0, 0]
      const options = plain<Record<string, unknown>>({
        mode: i.mode,
        threshold: i.threshold,
        colors: i.colors?.map((c) => c.toLowerCase()),
        colorTolerance: i.color_tolerance,
        speckMm2: i.speck_mm2,
        smoothingMm: i.smoothing_mm,
        fit: i.fit,
        cornerAngleDeg: i.corner_angle_deg,
        widthMm: i.width_mm,
        heightMm: i.height_mm,
        mmPerPx: i.mm_per_px,
        center,
        maxSidePx: i.max_side_px,
        previewImage: i.preview_image,
      })
      const req = { image: { base64: Buffer.from(bytes).toString('base64') }, options }
      const out = await (deps.files.engine ? call('sketch.trace', req) : engine('sketch.trace', req)).catch((e: unknown) => {
        throw traceRefusal(e)
      })
      const loopsIn = out['loops'] as Loops
      const check = (out['check'] ?? {}) as { ok?: boolean; areaMm2?: number; loops?: { index: number; role: string; areaMm2: number; lengthMm: number }[]; issues?: { kind: string; message: string }[] }
      const issues = check.issues ?? []
      const counts = out['counts'] as { lines: number; arcs: number; splines: number; circles: number }
      const size = out['sizeMm'] as [number, number]
      const dropped = out['dropped'] as { specks: number; holes: number }
      const warnings = (out['warnings'] ?? []) as string[]
      const holes = (check.loops ?? []).filter((l) => l.role === 'hole').length
      const n = (v: number, one: string) => `${v} ${one}${v === 1 ? '' : 's'}`
      const curves = [n(counts.lines, 'line'), n(counts.arcs, 'arc'), n(counts.splines, 'spline'), n(counts.circles, 'circle')].filter((t) => !t.startsWith('0 ')).join(', ')
      const shape = `${n(loopsIn.length, 'loop')}${holes ? ` (${n(holes, 'hole')})` : ''}, ${curves}, ${size.map((v) => Math.round(v * 100) / 100).join(' x ')} mm`
      const cleaned = dropped.specks || dropped.holes ? `Removed ${[dropped.specks ? n(dropped.specks, 'speck') : '', dropped.holes ? n(dropped.holes, 'pinhole') : ''].filter(Boolean).join(' and ')}.` : ''
      const problems = check.ok === false ? `${n(issues.length, 'problem')} to fix before it makes a solid: ${issues.slice(0, 5).map((x) => x.message).join(' ')}` : ''
      const tail = [cleaned, problems, ...warnings.map((w) => `${w[0]!.toUpperCase()}${w.slice(1)}.`)].filter(Boolean)
      const report = { counts, sizeMm: size, mmPerPx: out['mmPerPx'], imagePx: out['imagePx'], workingPx: out['workingPx'], dropped, mode: out['mode'], ...(out['threshold'] !== undefined ? { threshold: out['threshold'] } : {}), check: { ok: check.ok, areaMm2: check.areaMm2, loops: check.loops, issues }, warnings }
      const preview = typeof out['previewPng'] === 'string' ? { images: [{ mime: 'image/png' as const, data: out['previewPng'] }] } : {}
      // the loops go on as design.sketch takes them, so what it would refuse is named here in this tool's options, and
      // a dry run says so too
      const forId = i.design ?? drawn?.design
      const args = plain<Record<string, unknown>>({ loops: loopsIn, ...(i.frame ? { frame: i.frame } : {}), ...(forId !== undefined ? { design: forId } : {}) })
      const refusal = ((): string | undefined => {
        // a spline that cannot be drawn never reaches the timeline
        const bad = undrawable(issues, loopsIn)
        if (bad.length) return `image: ${bad.map((x) => x.message).join(' ')} Raise smoothing_mm or speck_mm2.`
        if (loopsIn.length > 256) return `image: the trace has ${loopsIn.length} loops and a sketch takes 256. Raise speck_mm2 to clean away the small ones, or trace part of the image.`
        const long = traceLoopTooLong(loopsIn)
        if (long) return `image: ${long}. Raise smoothing_mm, fit to curves, or raise speck_mm2.`
        const sent = new TextEncoder().encode(JSON.stringify(args)).length
        if (sent > SVG_ARGS) return `image: the trace's loops come to ${kb(sent)}, and the app link takes ${kb(SVG_ARGS)}. Raise smoothing_mm or speck_mm2, fit to curves, or trace part of the image; dry_run shows the counts without adding anything.`
        return undefined
      })()
      if (i.dry_run) {
        const head = `Traced, nothing added: ${shape}`
        const all = refusal ? [...tail, `Adding it would be refused: ${refusal.replace(/^image: /, '')}`] : tail
        return { summary: all.length ? `${head}. ${all.join(' ')}` : head, output: { loops: loopsIn, ...report, ...(refusal ? { refused: refusal } : {}) }, ...preview }
      }
      if (refusal) throw new ToolInputError(refusal)
      const added = deps.sketchVia?.run ? await deps.sketchVia.run(args, ctx) : await sketch.run(sketch.input.parse(args) as never, ctx as never)
      const made = (added.output ?? {}) as { id?: string; name?: string; in?: string }
      const head = `${made.name ?? 'The sketch'} is in the timeline: ${shape}`
      return {
        summary: tail.length ? `${head}. ${tail.join(' ')}` : head,
        output: { id: made.id, name: made.name, loops: loopsIn, ...report, ...(made.in ? { in: made.in } : {}) },
        ...preview,
      }
    },
  })

  const push = defineTool({
    name: 'geom.push_pull',
    version: '1.4.0',
    source: 'command',
    permission: 'slice',
    description: 'Push or pull a flat face of a model or a design along its normal: a positive distance pulls it out and adds material, a negative one pushes it in and cuts; pushing past the far side makes a hole. With "design" it adds a step to the design; with a model it writes the new STL and reports the volume change and the moved face.',
    input: z.object({ model: modelOrDesign, design: designArg.optional(), feature: featureArg, face: faceRef, distance_mm: z.number().min(-10_000).max(10_000).refine((d) => d !== 0, 'must not be zero') }),
    async run(i) {
      oneOf(i)
      const verb = i.distance_mm > 0 ? 'Pulled' : 'Pushed'
      if (i.design) {
        let d: Design
        const measurements = (body: Design) => {
          const summary = designSummary(body)
          return { sizeMm: summary['sizeMm'], volumeMm3: summary['volumeMm3'] }
        }
        let f: ReturnType<typeof pickIn>
        let before: ReturnType<typeof manifestOf> | undefined
        let dimensionsBefore: ReturnType<typeof measurements> | undefined
        let commit: DesignCommit | undefined
        try {
          d = designOf(i.design)
          f = pickIn(d, i.face)
          before = i.face.topology ? manifestOf(d) : undefined
          if (before && topologyFace(before, i.face.topology!).surfaceType !== 'plane') throw new ToolInputError('Push/pull requires a planar face. Inspect the surface and choose a supported edit.', 'not_supported')
          if (before && verifyPush(d.parts[f.part], d.transform, topologyFace(before, i.face.topology!).face, f.at, f.normal, 0).status !== 'verified') throw new ToolInputError('The selected face has no valid planar measurement.', 'invalid_model')
          dimensionsBefore = before ? measurements(d) : undefined
          const params: StepParams = { op: 'face.push', at: f.at, normal: f.normal, distanceMm: i.distance_mm, ...(f.key ? { faceKey: f.key } : {}) }
          const host = designs()
          if (i.face.topology) {
            if (!host.addWithReceipt) throw new ToolInputError('This host cannot return an atomic edit receipt.', 'not_supported')
            commit = await host.addWithReceipt(d, f.part, params, undefined, withFeature(i.feature, { expectedRevision: i.face.topology.revision }))
          } else await host.add(d, f.part, params, undefined, withFeature(i.feature))
        } catch (e) {
          if (!i.face.topology) throw e
          const rawCode = e instanceof StaleBody ? 'stale_body' : e instanceof ToolInputError ? e.code : e instanceof Error && 'code' in e && e.code === 'not_found' ? 'not_found' : 'internal_error'
          const code = rawCode === 'not_found' ? 'stale_body' : rawCode
          let current: ReturnType<typeof manifestOf> | null = null
          try { current = manifestOf(designOf(i.design)) } catch { /* the body may have been removed */ }
          throw new ToolInputError(e instanceof Error ? e.message : 'The edit was refused.', code, {
            ...(e instanceof ToolInputError ? e.details : {}),
            topology: current ? compactManifest(current) : null,
            operationResult: { operation: 'geom.push_pull', status: 'refused', reason: code, bodyId: bodyIdOf(i.design),
              priorRevision: i.face.topology.revision, revision: current?.revision ?? null, target: i.face.topology },
          })
        }
        const result = stepOut(commit?.design ?? d, verb)
        if (!before) return result
        const after = manifestOf(commit!.design, commit!.revision)
        const targetsAfter = after.faces.filter(face => face.part === f.part && face.faceKey === f.key)
        const targetAfter = targetsAfter.length === 1 && targetsAfter[0]!.ambiguity === 'none' ? targetsAfter[0]! : null
        const verification = verifyPush(commit!.design.parts[f.part], commit!.design.transform, targetAfter?.surfaceType === 'plane' ? targetAfter.face : undefined, f.at, f.normal, i.distance_mm)
        return { ...result, summary: `${result.summary}${verification.status !== 'verified' ? '; the edit was applied but its displacement is not verified' : ''}`, output: { ...result.output, topology: compactManifest(after), operationResult: {
          operation: 'geom.push_pull', status: 'applied', bodyId: d.id, priorRevision: before.revision, revision: after.revision,
          target: i.face.topology, distanceMm: i.distance_mm, verification,
          targetBefore: topologyFace(before, i.face.topology!),
          targetAfter,
          measurements: { source: 'tessellation', before: dimensionsBefore, after: measurements(commit!.design) },
        } } }
      }
      const stlPath = await path(i.model!)
      const out = await call('face.push', { mesh: { stlPath }, ...(await pick(stlPath, i.face)), distanceMm: i.distance_mm })
      return { summary: `${verb} the face ${Math.abs(i.distance_mm)} mm`, output: out }
    },
  })

  const BOOL = { union: 'union', subtract: 'difference', intersect: 'intersection' } as const
  const boolean = defineTool({
    name: 'geom.boolean',
    version: '1.3.1',
    source: 'command',
    permission: 'slice',
    description:
      'Union, subtract or intersect closed bodies. With a model: union joins "model" and every model in "with", subtract removes them from "model", intersect keeps what they share; writes one manifold STL. With "design": "part" is combined with the parts in "with_parts", which go away as their own parts; adds a step.',
    localDescription:
      'Union, subtract or intersect closed bodies (op): subtract removes with (or with_parts) from model (or part); intersect keeps what they share. With a model: one STL. With design: with_parts go away as their own parts; adds a step. More: kb.search "modeling tools".',
    input: z.object({
      op: z.enum(['union', 'subtract', 'intersect']),
      model: modelOrDesign,
      with: z.array(modelArg).min(1).max(32).optional(),
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      with_parts: z.array(z.number().int().min(0)).min(1).max(64).optional().describe('With a design: the other parts, from 0'),
    }),
    async run(i) {
      oneOf(i)
      if (i.design) {
        if (!i.with_parts) throw new ToolInputError('with_parts: name the parts to combine with, from 0')
        const d = designOf(i.design)
        await designs().add(d, i.part ?? 0, { op: 'boolean', kind: BOOL[i.op], with: i.with_parts }, undefined, withFeature(i.feature))
        return stepOut(d, `${i.op[0]?.toUpperCase()}${i.op.slice(1)}`)
      }
      if (!i.with) throw new ToolInputError('with: give the models to combine with')
      const a = [{ stlPath: await path(i.model!) }]
      const b = await Promise.all(i.with.map(async (m) => ({ stlPath: await path(m) })))
      const out = await call('boolean', i.op === 'union' ? { op: 'union', a: [...a, ...b], b: [] } : { op: BOOL[i.op], a, b })
      return { summary: `${i.op[0]?.toUpperCase()}${i.op.slice(1)}: ${String(out['shells'] ?? '?')} shell(s), ${Math.round(Number(out['volumeMm3'] ?? 0))} mm3`, output: out }
    },
  })

  const edges = z.array(edgeItem).min(1).max(256).describe('The edges: loopRef or chainRef from slicerx_geom_edge_pick for a whole loop or chain, or single edges as it returns them')
  const allOrNothing = z.boolean().optional().describe('true: refuse the whole step when any edge cannot be done. Default false: do the edges that can be done, leave the rest as they were and list them in skipped')
  const plural = (n: number): string => `${n} edge${n === 1 ? '' : 's'}`
  type Ref = z.infer<typeof edgeRef>
  /**
   * The edges a call names, with each loop or chain reference picked again on the part as it is now, so it still holds
   * after an earlier step changed the part. `from` is the place in the call's list each edge came from.
   */
  const expand = async (list: readonly z.infer<typeof edgeItem>[], on: { design: Design; part?: number | undefined } | { stlPath: string }): Promise<{ edges: Ref[]; from: number[]; part?: number }> => {
    const out: Ref[] = []
    const from: number[] = []
    let part: number | undefined
    for (const [n, e] of list.entries()) {
      if (!('set' in e)) {
        out.push(e)
        from.push(n)
        continue
      }
      let p: Record<string, unknown> | undefined
      const gone = () => new ToolInputError(`edges.${n}: no flat face faces (${e.normal.join(', ')}) within ${SET_REACH_MM} mm of (${e.at.join(', ')}) any more; pick the edge again with slicerx_geom_edge_pick`, 'invalid_input')
      if ('design' in on) {
        const d = on.design
        for (const [k, mesh] of d.parts.entries()) {
          if (on.part !== undefined && k !== on.part) continue
          const f = setFace(partTriangles(bakeMesh(mesh, d.transform)), e.at, e.normal)
          if (!f) continue
          part ??= k
          p = await engine('edge.pick', { mesh: item(d, k), triangle: f.triangle, at: f.at })
          break
        }
      } else {
        const f = setFace(triangles(on.stlPath), e.at, e.normal)
        if (f) p = await call('edge.pick', { mesh: { stlPath: on.stlPath }, triangle: f.triangle, at: f.at })
      }
      if (!p) throw gone()
      const got = e.set === 'loop' ? (p['loop'] as { edge: Ref; supported: boolean }[]).filter((l) => l.supported).map((l) => l.edge) : (p['chain'] as Ref[])
      if (!got.length) throw new ToolInputError(`edges.${n}: the ${e.set} there has no edge a fillet or chamfer takes`, 'invalid_input')
      for (const g of got) {
        out.push(g)
        from.push(n)
      }
    }
    return { edges: out, from, ...(part !== undefined ? { part } : {}) }
  }
  /** A refusal of a stale single edge says a loop or chain reference holds where a single edge does not. */
  const REPICK = '. A loopRef or chainRef from slicerx_geom_edge_pick is picked again when the step is made, so it still finds the edges after an earlier step changed them'
  const stale = /pick it again|no sharp edge between two flat faces there/
  const repick = (e: unknown): unknown => {
    if (e instanceof Error && stale.test(e.message)) e.message = e.message.replace(/\.? The design is unchanged\.$/, '') + REPICK + (/The design is unchanged\.$/.test(e.message) ? '. The design is unchanged.' : '')
    return e
  }
  /** The edges a step left as they were, by their place in the step's edges (index) and in the call's list (input). */
  const leftOut = (list: readonly { index: number; code: string; message: string }[] | undefined, from: number[]) => (list ?? []).map((x) => ({ index: x.index, input: from[x.index] ?? x.index, code: x.code, message: x.code === 'not_found' && stale.test(x.message) ? x.message + REPICK : x.message }))
  const withSkipped = (o: { summary: string; output: Record<string, unknown> }, skipped: ReturnType<typeof leftOut>) => ({
    summary: skipped.length ? `${o.summary}. Left ${plural(skipped.length)} as ${skipped.length === 1 ? 'it was' : 'they were'} (skipped)` : o.summary,
    output: { ...o.output, skipped },
  })
  const addEdgeStep = async (d: Design, i: { part?: number | undefined; edges: readonly z.infer<typeof edgeItem>[]; feature?: string | undefined }, params: (edges: Extract<StepParams, { op: 'edge.fillet' }>['edges']) => StepParams, verb: string) => {
    const x = await expand(i.edges, { design: d, part: i.part })
    await designs().add(d, i.part ?? x.part ?? partAt(d, x.edges[0]!.a), params(plain(x.edges)), undefined, withFeature(i.feature)).catch((e: unknown) => { throw repick(e) })
    return withSkipped(stepOut(d, verb), leftOut(d.status[d.status.length - 1]?.skipped, x.from))
  }

  const fillet = defineTool({
    name: 'geom.fillet',
    version: '1.6.0',
    source: 'command',
    permission: 'slice',
    description:
      'Round straight edges on a flat face with one radius: convex edges lose material, concave edges gain it, and three filleted edges at a corner get a sphere patch. Edges along a round (a rounded rectangle\'s outline, a cone\'s base rim) become one mitered round. Take the edges from slicerx_geom_edge_pick: its loopRef or chainRef for a whole loop or chain, or single edges. An edge that cannot be done (too small for the radius, a corner it cannot blend) is left as it was and listed in skipped with a code and the reason, and the rest are done; all_or_nothing refuses the whole step instead. With "design" it adds a step to the design; with a model it writes the new STL.',
    localDescription:
      'Round straight edges on a flat face to radius_mm, along rounds too (rounded rectangle loops, cone rims); take the edges from geom.edge_pick as given (or its loopRef or chainRef); edges it cannot do are listed in skipped. With design (a design id) it adds a step; with model (an STL path), an STL. More: kb.search "modeling tools".',
    input: z.object({ model: modelOrDesign, design: designArg.optional(), feature: featureArg, part: partArg, edges, radius_mm: z.number().positive().max(1000), tolerance_mm: z.number().min(0.001).max(1).optional().describe('Chord tolerance of the round, default 0.01 mm'), all_or_nothing: allOrNothing }),
    // a local model does what it can (all_or_nothing is for MCP clients) and sees the edge entries without their texts
    localInput: z.object({ model: localModel, design: localDesign, feature: featureArg, part: partArg, edges: localEdges, radius_mm: z.number().positive().max(1000), tolerance_mm: z.number().min(0.001).max(1).optional() }),
    async run(i) {
      oneOf(i)
      const tolerance = i.tolerance_mm !== undefined ? { toleranceMm: i.tolerance_mm } : {}
      if (i.design) return addEdgeStep(designOf(i.design), i, (edges) => ({ op: 'edge.fillet', edges, radiusMm: i.radius_mm, ...tolerance, allOrNothing: i.all_or_nothing ?? false }), 'Filleted')
      const stlPath = await path(i.model!)
      const x = await expand(i.edges, { stlPath })
      const out = await call('edge.fillet', { mesh: { stlPath }, edges: x.edges, radiusMm: i.radius_mm, ...tolerance, allOrNothing: i.all_or_nothing ?? false }).catch((e: unknown) => { throw repick(e) })
      return withSkipped({ summary: `Filleted ${plural(x.edges.length)} at ${i.radius_mm} mm`, output: out }, leftOut(out['skipped'] as Parameters<typeof leftOut>[0], x.from))
    },
  })

  const chamfer = defineTool({
    name: 'geom.chamfer',
    version: '1.6.0',
    source: 'command',
    permission: 'slice',
    description:
      "Bevel straight edges on a flat face, along rounds too (a rounded rectangle's outline, a cone's base rim), set back by distance_mm on each face (or distance_mm on the edge's own face and distance2_mm on the other). Take the edges from slicerx_geom_edge_pick: its loopRef or chainRef for a whole loop or chain, or single edges. An edge that cannot be done is left as it was and listed in skipped with a code and the reason, and the rest are done; all_or_nothing refuses the whole step instead. With \"design\" it adds a step to the design; with a model it writes the new STL.",
    localDescription:
      "Bevel straight edges on a flat face, along rounds too, set back distance_mm on the edge's own face and distance2_mm (optional, else distance_mm) on the other; take the edges from geom.edge_pick as given (or its loopRef or chainRef); edges it cannot do are listed in skipped. With design (a design id) it adds a step; with model (an STL path), an STL. More: kb.search \"modeling tools\".",
    input: z.object({ model: modelOrDesign, design: designArg.optional(), feature: featureArg, part: partArg, edges, distance_mm: z.number().positive().max(1000), distance2_mm: z.number().positive().max(1000).optional(), all_or_nothing: allOrNothing }),
    // as the fillet's: no all_or_nothing and the edge entries without their texts on a local turn
    localInput: z.object({ model: localModel, design: localDesign, feature: featureArg, part: partArg, edges: localEdges, distance_mm: z.number().positive().max(1000), distance2_mm: z.number().positive().max(1000).optional() }),
    async run(i) {
      oneOf(i)
      const second = i.distance2_mm !== undefined ? { distance2Mm: i.distance2_mm } : {}
      if (i.design) return addEdgeStep(designOf(i.design), i, (edges) => ({ op: 'edge.chamfer', edges, distanceMm: i.distance_mm, ...second, allOrNothing: i.all_or_nothing ?? false }), 'Chamfered')
      const stlPath = await path(i.model!)
      const x = await expand(i.edges, { stlPath })
      const out = await call('edge.chamfer', { mesh: { stlPath }, edges: x.edges, distanceMm: i.distance_mm, ...second, allOrNothing: i.all_or_nothing ?? false }).catch((e: unknown) => { throw repick(e) })
      return withSkipped({ summary: `Chamfered ${plural(x.edges.length)} at ${i.distance_mm} mm`, output: out }, leftOut(out['skipped'] as Parameters<typeof leftOut>[0], x.from))
    },
  })

  const shell = defineTool({
    name: 'geom.shell',
    version: '1.3.0',
    source: 'command',
    permission: 'slice',
    description:
      'Shell a closed body: hollow it to a wall thickness with some flat faces left open, for boxes, trays and enclosures (the shell tool). A body whose faces are all flat gets exact walls. Give each open face as a point on it and its outward normal, as slicerx_geom_faces lists them; none for a closed hollow. With "design" it adds a shell step (the open faces kept by their keys, and its wall an editable number); with a model it writes the new STL and reports the walls. With --app, a design is the body in the open project.',
    localDescription:
      'Hollow a closed body to wall_mm with the open faces left open (each a point on it and its outward normal; none for a closed hollow), for boxes, trays and enclosures. With design it adds a step; with a model, an STL. More: kb.search "modeling tools".',
    input: z.object({
      model: modelOrDesign,
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      open: z.array(z.object({ at: vec3.describe('A point on the face, mm'), normal: vec3.describe('Its outward normal') })).max(64).default([]).describe('Faces to leave open, such as the top of a box'),
      wall_mm: z.number().min(0.2).max(100),
    }),
    async run(i) {
      oneOf(i)
      if (i.design) {
        const d = designOf(i.design)
        const picks = i.open.map((f) => faceAt(d, f.at as V3, f.normal as V3))
        const part = i.part ?? picks[0]?.part ?? 0
        if (picks.some((p) => p.part !== part)) throw new ToolInputError('open: every open face must be on the part being shelled')
        await designs().add(d, part, { op: 'shell', open: i.open.map((f, k) => ({ at: f.at as V3, normal: f.normal as V3, ...(picks[k]?.key ? { key: picks[k]!.key } : {}) })), wallMm: i.wall_mm }, undefined, withFeature(i.feature))
        return stepOut(d, 'Shelled')
      }
      const out = await call('shell', { mesh: { stlPath: await path(i.model!) }, open: i.open, wallMm: i.wall_mm })
      return { summary: `Shelled to ${i.wall_mm} mm walls${i.open.length ? `, ${i.open.length} face${i.open.length === 1 ? '' : 's'} open` : ''}`, output: lean(out) }
    },
  })

  const stepArg = z.union([z.number().int().min(1), z.string().min(1)]).optional().describe('With a design: read it as it was right after this step (an index from 1, a step id or its name, such as "Fillet 1.5 mm"); default the latest')

  const info = defineTool({
    name: 'geom.info',
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    description: 'Check a model or a design: its bounds (min, max and size in mm), volume, surface area, triangle count, whether it is closed (watertight) and how many separate shells it has. A design reads per part, as it is now or right after a given step; a part is closed when, with corners at the same point taken as one, every edge has exactly two faces, as the slicer reads it, and the summary says what keeps a part open. With --app, read the body in the open project without changing its history.',
    localDescription:
      'Read a model or design back: bounds, volume, surface area, triangle count, watertight and shells; a design per part, now or right after a given step. More: kb.search "modeling tools".',
    input: z.object({ model: modelOrDesign, design: designArg.optional(), step: stepArg }),
    async run(i) {
      oneOf(i)
      if (i.design) {
        const d = designOf(i.design)
        const parts = await partsAt(designs(), d, i.step)
        const out = []
        const shut: Closure[] = []
        for (const [k, p] of parts.entries()) {
          const w = bakeMesh(p, d.transform)
          // closed as the slicer reads it, welded by position on the part's own positions: the engine's own reading goes by
          // triangle index
          const c = partClosure(p)
          shut.push(c)
          const { watertight, ...edges } = c
          out.push({ part: k, name: p.name, slot: p.slot, ...(await engine('info', { mesh: { positions: Array.from(w.positions), indices: Array.from(w.indices) } })), edges, watertight })
        }
        const closed = shut.every((c) => c.watertight)
        const why = notClosedWords(shut.reduce((a, c) => ({ boundaryEdges: a.boundaryEdges + c.boundaryEdges, nonManifoldEdges: a.nonManifoldEdges + c.nonManifoldEdges, flippedEdges: a.flippedEdges + c.flippedEdges }), { boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 }))
        return { summary: `${out.length} part${out.length === 1 ? '' : 's'}, ${closed ? 'closed' : `not closed (${why})`}`, output: { design: d.id, ...(i.step !== undefined ? { step: i.step } : {}), parts: out } }
      }
      const out = await call('info', { mesh: { stlPath: await path(i.model!) } })
      return { summary: `${out['watertight'] === true ? 'Closed' : 'Not closed'}, ${Math.round(Number(out['volumeMm3'] ?? 0))} mm3, ${String(out['components'] ?? '?')} shell(s)`, output: out }
    },
  })

  /** A measurement in a few words, the way a maker reads it. */
  const words = (m: Record<string, unknown>): string => {
    const n = (k: string): string | null => (typeof m[k] === 'number' ? String(Math.round((m[k] as number) * 1000) / 1000) : null)
    const parts = [
      n('diameterMm') !== null ? `diameter ${n('diameterMm')} mm` : n('radiusMm') !== null ? `radius ${n('radiusMm')} mm` : null,
      n('distanceMm') !== null ? `distance ${n('distanceMm')} mm` : null,
      n('centerDistanceMm') !== null ? `center distance ${n('centerDistanceMm')} mm` : null,
      n('lengthMm') !== null ? `length ${n('lengthMm')} mm` : null,
      n('angleDeg') !== null ? `angle ${n('angleDeg')} degrees` : null,
      n('areaMm2') !== null ? `area ${n('areaMm2')} mm2` : null,
    ].filter((x): x is string => x !== null)
    return parts.length ? parts.join(', ') : 'nothing to measure there'
  }

  const measure = defineTool({
    name: 'geom.measure',
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    description:
      'Measure a model or a design as the measure tool does (distance, angle and radius): the feature at a picked point, a flat face, a hole or boss (a cylinder, with its diameter), an edge or a corner, and with a second pick "b" the distance and angle between the two. Pick a face by a point on it and its outward normal, as slicerx_geom_faces lists them; snap_mm snaps the pick to an edge or a corner that close, to measure from an edge. With --app, measure a design in the open project, in world coordinates. With "section" in place of "a", cut a design\'s part at a plane (a point on it and its normal) for the cross section: its area in mm2, outline length in mm and outline loops in world mm, to check a wall, bore or lip before calling a part done. Round faces are flat facets, so a circle\'s area reads up to about 0.1 percent under the true circle. A part that is not closed, or a plane that misses it, is refused.',
    input: z.object({
      model: modelOrDesign,
      design: designArg.optional(),
      step: stepArg,
      a: faceRef.optional().describe('The face or point to measure; required unless section is given'),
      b: faceRef.optional(),
      snap_mm: z.number().min(0).max(5).default(0).describe('Snap to an edge or corner within this distance, mm'),
      section: z
        .object({
          part: z.number().int().min(0).default(0).describe('The part, by index; default 0'),
          plane: z.object({ origin: vec3.describe('A point on the plane, mm'), normal: vec3.describe('The plane normal; any length') }),
        })
        .optional()
        .describe("A design's part cut at a plane, in place of a and b"),
    }),
    async run(i) {
      if (i.section) {
        if (!i.design) throw new ToolInputError('section: give a design; a section is of a design\'s part')
        if (i.a || i.b) throw new ToolInputError('section: give either section or a and b, not both')
        if (i.step !== undefined) throw new ToolInputError('section: a section is of the design as it is now; leave out step')
        return sectionOf(designOf(i.design), i.section.part, i.section.plane)
      }
      if (!i.a) throw new ToolInputError('a: give the face to measure (a point on it and its normal), or a section')
      const pickA = i.a
      oneOf(i)
      let feature: (f: z.infer<typeof faceRef>) => Promise<unknown>
      let measureCall: (req: Record<string, unknown>) => Promise<Record<string, unknown>>
      let readGuard: (() => ReturnType<typeof manifestOf>) | undefined
      if (i.design) {
        const d = designOf(i.design)
        const reference = pickA.topology ?? i.b?.topology
        if (reference) {
          if (i.step !== undefined) throw new ToolInputError('A live topology reference cannot select a historical step.')
          if (pickA.topology) pickIn(d, pickA)
          if (i.b?.topology) pickIn(d, i.b)
          readGuard = () => checkedManifest(d.id, reference.revision)
          readGuard()
        }
        const parts = await partsAt(designs(), d, i.step)
        readGuard?.()
        feature = async (f) => {
          if (f.topology) {
            readGuard?.()
            const hit = pickIn(d, f)
            const result = (await engine('measure.feature', { mesh: item(d, hit.part), pick: { triangle: hit.triangle, at: hit.at }, snapMm: i.snap_mm }))['feature']
            readGuard?.()
            return result
          }
          if (!f.at) throw new ToolInputError('a, b: give "at" (a point on the face) and its "normal"')
          const hit = faceAt(d, f.at as V3, f.normal as V3 | undefined, parts)
          return (await engine('measure.feature', { mesh: item(d, hit.part, parts), pick: { triangle: hit.triangle, at: f.at }, snapMm: i.snap_mm }))['feature']
        }
        measureCall = (req) => engine('measure', req)
      } else {
        if (pickA.topology || i.b?.topology) throw new ToolInputError('Topology references require a live design.', 'not_supported')
        const stlPath = await path(i.model!)
        feature = async (f) => (await call('measure.feature', { mesh: { stlPath }, pick: await pick(stlPath, f), snapMm: i.snap_mm }))['feature']
        measureCall = (req) => call('measure', req)
      }
      const a = await feature(pickA)
      const b = i.b ? await feature(i.b) : undefined
      const m = await measureCall({ a, ...(b !== undefined ? { b } : {}) })
      const topology = readGuard?.()
      return { summary: `Measured: ${words(m)}`, output: { measurement: m, a: lean(a), ...(b !== undefined ? { b: lean(b) } : {}), ...(topology ? { topology: compactManifest(topology), measurementSource: 'tessellation' } : {}) } }
    },
  })

  const r3n = (v: number): number => Math.round(v * 1000) / 1000 || 0
  const fitCheck = defineTool({
    name: 'geom.fit_check',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description:
      "Measure the gaps between a design's bodies for print-in-place parts (hinges, pins, chains): every pair that touches or sits closer than the printer keeps open, how many separate pieces print, and per gap fuses, binds or slides. Limits come from the nozzle, layer height and material. slicerx_design_check of a plan with printInPlace waits for this check on the design as it is now.",
    input: z.object({
      design: designArg,
      part: z.array(z.number().int().min(0)).min(1).max(64).optional().describe('Only these parts, by index, each once; default all'),
      material: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[A-Za-z][A-Za-z0-9 +./-]*$/, 'a filament type, such as PLA, PETG or TPU')
        .optional()
        .describe('A filament type, such as PLA, PETG or TPU; default the loaded filament'),
      layer_height_mm: z.number().min(0.04).max(0.8).optional(),
    }),
    async run(i) {
      const d = designOf(i.design)
      for (const k of i.part ?? []) if (!d.parts[k]) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
      const twice = i.part?.find((k, n) => i.part!.indexOf(k) !== n)
      if (twice !== undefined) throw new ToolInputError(`part: part ${twice} is listed twice; list each part once`)
      const profile = deps.fitProfile?.() ?? {}
      const limits = fitLimits({ nozzleMm: deps.nozzleMm?.(), layerHeightMm: i.layer_height_mm ?? profile.layerHeightMm, material: i.material ?? profile.material })
      const fit = await fitFacts(designs(), d, limits, i.part)
      deps.plans?.fitChecked(d.id, { stamp: designStamp(d), parts: i.part ?? 'all' })
      const gaps = fit.gaps.map((g) => ({
        bodies: g.bodies,
        names: g.bodies.map((b) => fit.bodies[b]!.name),
        kind: g.kind,
        direction: g.direction,
        gap_mm: r3n(g.gapMm),
        limit_mm: r3n(g.limitMm),
        verdict: fitVerdict(g, limits),
        ...(g.where ? { where: g.where } : {}),
        from: g.from.map(r3n),
        to: g.to.map(r3n),
      }))
      const tight = fit.gaps.filter((g) => g.kind !== 'apart')
      const warnings = tight.map((g) => gapSentence(fit, g, 'moving pieces need'))
      const least = fit.gaps.reduce<(typeof fit.gaps)[number] | null>((a, g) => (!a || g.gapMm < a.gapMm ? g : a), null)
      const pieces = `${fit.pieces} ${fit.pieces === 1 ? 'piece' : 'pieces'}`
      const summary = tight.length
        ? `${pieces}; ${tight.length} ${tight.length === 1 ? 'gap' : 'gaps'} under the limit: ${warnings[0]}`
        : `${pieces}; no gap under ${limits.sideMm} mm side by side or ${limits.verticalMm} mm above or below${least ? `, smallest ${gapMm(least.gapMm)}` : ''}`
      return {
        summary,
        output: {
          design: d.id,
          limits: { side_mm: limits.sideMm, vertical_mm: limits.verticalMm, material: limits.material, nozzle_mm: limits.nozzleMm, layer_height_mm: limits.layerHeightMm },
          pieces: fit.pieces,
          bodies: fit.bodies.map((b, k) => ({ body: k, part: b.part, name: b.name })),
          gaps,
          warnings,
        },
      }
    },
  })

  /** A design's part in world coordinates once it is closed; an open one is refused in plain words. */
  const closedPart = (d: Design, k: number, arg: string): { positions: number[]; indices: number[] } => {
    const p = d.parts[k]
    if (!p) throw new ToolInputError(`${arg}: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
    const c = partClosure(p)
    if (!c.watertight) throw new ToolInputError(`${arg}: part ${k}${p.name ? ` (${p.name})` : ''} is not closed (${notClosedWords(c)}), so it has no inside to measure; repair it first (slicerx_geom_repair)`, 'invalid_input')
    const w = bakeMesh(p, d.transform)
    return { positions: Array.from(w.positions), indices: Array.from(w.indices) }
  }
  /** At most this many loop points come back; a bigger section gives its area and counts only. */
  const SECTION_POINTS = 4000

  /** A design's part cut at a plane: the area, outline length and loops in world mm, or a refusal in plain words. */
  const sectionOf = async (d: Design, part: number, plane: { origin: V3; normal: V3 }): Promise<ToolOutput> => {
    if (Math.hypot(...plane.normal) < 1e-9) throw new ToolInputError('section.plane.normal: give a direction, not zeros')
    const mesh = closedPart(d, part, 'section.part')
    const name = d.parts[part]!.name
    const label = `part ${part}${name ? ` (${name})` : ''}`
    const r = await engine('section', { mesh, plane: { point: plane.origin, normal: plane.normal } })
    const polys = (r['polygons'] as { outer: [number, number][]; holes: [number, number][][] }[] | undefined) ?? []
    if (!polys.length) throw new ToolInputError(`section.plane: the plane does not cut ${label}; give a point inside the part`, 'invalid_input')
    const f = r['frame'] as { origin: V3; u: V3; v: V3 }
    const at = ([x, y]: [number, number]): V3 => [0, 1, 2].map((k) => r3n(f.origin[k]! + f.u[k]! * x + f.v[k]! * y)) as V3
    const points = polys.reduce((n, q) => n + q.outer.length + q.holes.reduce((m, h) => m + h.length, 0), 0)
    const area = r3n(Number(r['areaMm2'] ?? 0))
    const holes = polys.reduce((n, q) => n + q.holes.length, 0)
    const regions = `${polys.length} ${polys.length === 1 ? 'region' : 'regions'}${holes ? ` with ${holes} ${holes === 1 ? 'hole' : 'holes'}` : ''}`
    return {
      summary: `Section of ${label}: ${area} mm2 in ${regions}`,
      output: {
        section: {
          design: d.id,
          part,
          area_mm2: area,
          outline_mm: r3n(Number(r['seamLengthMm'] ?? 0)),
          regions: polys.length,
          holes,
          ...(points <= SECTION_POINTS
            ? { loops: polys.map((q) => ({ outer: q.outer.map(at), holes: q.holes.map((h) => h.map(at)) })) }
            : { loop_points: points, loops_left_out: `over ${SECTION_POINTS} points; the area and counts stand` }),
        },
      },
    }
  }

  const interference = defineTool({
    name: 'geom.interference',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      "Whether two parts of a design interfere: the volume they share in mm3, or when they do not, the clearance between them (the smallest distance between their surfaces, mm) with the closest points. Use it to check a pin in its hole, a lid on its box or a hinge gap by measurement. A shared volume under 0.001 mm3 counts as touching (clearance 0). The clearance is exact on the triangles: round faces are flat facets, so a gap beside a curve reads up to about 0.02 mm under the modeled one. Refuses a part that is not closed.",
    input: z.object({
      design: designArg,
      a: z.number().int().min(0).describe('The first part, by index'),
      b: z.number().int().min(0).describe('The second part, by index'),
    }),
    async run(i) {
      const d = designOf(i.design)
      if (i.a === i.b) throw new ToolInputError('b: give a different part from a; a part does not interfere with itself')
      const r = await engine('interference', { a: { mesh: closedPart(d, i.a, 'a') }, b: { mesh: closedPart(d, i.b, 'b') } })
      const label = (k: number): string => `part ${k}${d.parts[k]!.name ? ` (${d.parts[k]!.name})` : ''}`
      const interferes = r['interferes'] === true
      const overlap = r3n(Number(r['overlapMm3'] ?? 0))
      const clearance = r3n(Number(r['clearanceMm'] ?? 0))
      const summary = interferes
        ? `${label(i.a)} and ${label(i.b)} interfere: they share ${overlap} mm3`
        : clearance > 0
          ? `${label(i.a)} and ${label(i.b)} clear each other by ${clearance} mm`
          : `${label(i.a)} and ${label(i.b)} touch (clearance 0)`
      return {
        summary,
        output: {
          design: d.id,
          a: i.a,
          b: i.b,
          interferes,
          overlap_mm3: overlap,
          clearance_mm: clearance,
          ...(Array.isArray(r['from']) ? { from: (r['from'] as V3).map(r3n), to: (r['to'] as V3).map(r3n) } : {}),
        },
      }
    },
  })

  /** A hole as the engine finds it (hole.find), the same object the app's hole step keeps. */
  interface FoundHole {
    entry: V3
    axis: V3
    diameterMm: number
    depthMm: number
    through: boolean
  }
  // no -0 in a read-back: it prints as 0 but compares unequal in a client's checks
  const r3 = (v: number): number => Math.round(v * 1000) / 1000 || 0
  const asHole = (v: Record<string, unknown>): FoundHole => {
    const h = v as unknown as FoundHole
    return { entry: h.entry, axis: h.axis, diameterMm: h.diameterMm, depthMm: h.depthMm, through: h.through }
  }
  /** An engine refusal of a pick, in the tool's words: what is there instead of a hole. */
  const pickError = (err: unknown): unknown => {
    const m = /^(?:sx-geom: )?hole: (.*)$/s.exec(err instanceof Error ? err.message : String(err))
    return m ? new ToolInputError(`pick: ${m[1]}`, 'invalid_input') : err
  }
  const findHole = async (run: (req: Record<string, unknown>) => Promise<Record<string, unknown>>, req: Record<string, unknown>): Promise<FoundHole> => {
    try {
      return asHole(await run(req))
    } catch (err) {
      throw pickError(err)
    }
  }
  /** The hole read back for a client: where it starts, which way is out of it, its size and how it ends. */
  const readHole = (h: FoundHole): Record<string, unknown> => ({ center: h.entry.map(r3), axis: h.axis.map(r3), diameterMm: r3(h.diameterMm), depthMm: r3(h.depthMm), kind: h.through ? 'through' : 'blind' })
  type HeadIn = { counterbore?: { diameter_mm: number; depth_mm: number } | undefined; countersink?: { diameter_mm: number; angle_deg: number } | undefined }
  /**
   * The hole as made, from the narrowest hole on the old one's axis line (its shaft), measured from the old entry so a
   * counterbore or a countersink does not shorten it, with the head the spec asked for.
   */
  const readMade = (before: FoundHole, shaft: FoundHole, i: HeadIn): Record<string, unknown> => {
    // the shaft may be found from either end (a countersunk one only from its flat end): its far end is the one
    // farther from the old entry
    const ends = [shaft.entry, sub(shaft.entry, shaft.axis.map((c) => c * shaft.depthMm) as V3)]
    const far = ends.reduce((a, b) => (dot(sub(before.entry, b), before.axis) > dot(sub(before.entry, a), before.axis) ? b : a))
    const head = i.counterbore
      ? { head: 'counterbore', counterbore: { diameterMm: i.counterbore.diameter_mm, depthMm: i.counterbore.depth_mm } }
      : i.countersink
        ? { head: 'countersink', countersink: { diameterMm: i.countersink.diameter_mm, angleDeg: i.countersink.angle_deg } }
        : { head: 'none' }
    return { ...readHole({ ...before, diameterMm: shaft.diameterMm, depthMm: dot(sub(before.entry, far), before.axis), through: shaft.through }), ...head }
  }

  const holeEdit = defineTool({
    name: 'geom.hole_edit',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Change a round hole already in a model or a design, as the hole tool does: a new diameter, a blind hole\'s depth, and a counterbore or a countersink at its entry. It never makes a new hole; for one, use geom.hole. Pick the hole by a point on its wall ("face", with the wall\'s normal pointing into the hole when the point is on an edge) or by "center" and "axis", a point on its axis line (its center on the face it starts at, say) and the axis either way round; a hole with a counterbore already is found by its shaft. Returns the hole as found before the change and as made after it (center, axis, diameterMm, depthMm, kind through or blind, head); a pick with no hole says what face is there. With "design" it adds the same hole step the app records, so it replays and edits like one made by hand; with a model it writes the new STL.',
    localDescription:
      'Change a round hole already in a model or design: a new diameter_mm, a blind hole\'s depth_mm, or a counterbore or countersink at its entry. It never makes a new hole; for one, use geom.hole. Pick it by a point on its wall (face) or by center and axis. With design it adds a step; with a model, an STL. Returns the hole before and after. More: kb.search "change a hole".',
    input: z.object({
      model: modelOrDesign,
      design: designArg.optional(),
      feature: featureArg,
      part: partArg.describe('With a design: the part the hole is in (default: the part picked, or the first part with a hole on that axis)'),
      face: faceRef.optional().describe('A point on the hole\'s wall: {"at":[x,y,z]} (with "normal" on an edge) or {"triangle":n}'),
      center: vec3.optional().describe('With axis: a point on the hole\'s axis line, mm, such as its center on the face it starts at; the end nearest it is the entry'),
      axis: vec3.optional().describe('With center: the hole\'s axis, either way round'),
      diameter_mm: z.number().positive().max(10_000).optional().describe('The new diameter; the hole keeps its own when left out'),
      depth_mm: z.number().positive().max(10_000).optional().describe('A blind hole\'s new depth from its entry; a through hole stays through'),
      counterbore: z.object({ diameter_mm: z.number().positive().max(10_000), depth_mm: z.number().positive().max(10_000) }).optional().describe('A counterbore at the entry for a screw head: wider than the hole, less deep'),
      countersink: z.object({ diameter_mm: z.number().positive().max(10_000), angle_deg: z.number().min(30).max(150).default(90) }).optional().describe('A countersink at the entry for a flat head: its diameter on the face, and the cone\'s full angle (90 for most metric screws)'),
      label: z.string().min(1).max(120).optional().describe('With a design: the step\'s name in the history, such as "M3 clearance"; default "Hole <diameter> mm"'),
    }),
    async run(i) {
      oneOf(i)
      // narrower than the nozzle closes up as it prints: refused as the hole tool refuses it, before the engine runs
      const small = i.diameter_mm === undefined ? null : customHoleProblem(i.diameter_mm, nozzleOr(deps.nozzleMm?.()))
      if (small) throw new ToolInputError(small)
      if (i.face && (i.center || i.axis)) throw new ToolInputError('pick: give "face" (a point on the wall) or "center" and "axis", not both')
      if (!i.face && !(i.center && i.axis)) throw new ToolInputError('pick: give "face" (a point on the hole\'s wall) or "center" and "axis" (a point on its axis line and the axis)')
      if (i.diameter_mm === undefined && i.depth_mm === undefined && !i.counterbore && !i.countersink) throw new ToolInputError('give what the hole becomes: diameter_mm, depth_mm, counterbore or countersink')
      if (i.counterbore && i.countersink) throw new ToolInputError('a hole takes a counterbore or a countersink, not both')
      const spec = (h: FoundHole) => plain<HoleSpec>({
        diameterMm: i.diameter_mm ?? h.diameterMm,
        depthMm: i.depth_mm,
        counterbore: i.counterbore && { diameterMm: i.counterbore.diameter_mm, depthMm: i.counterbore.depth_mm },
        countersink: i.countersink && { diameterMm: i.countersink.diameter_mm, angleDeg: i.countersink.angle_deg },
      })
      const verb = (h: FoundHole, s: HoleSpec) => `Made the ${r3(h.diameterMm)} mm hole ${r3(s.diameterMm)} mm${s.counterbore ? ' with a counterbore' : s.countersink ? ' with a countersink' : ''}`
      const onAxis = (h: FoundHole) => ({ at: h.entry, axis: h.axis })
      if (i.design) {
        const reference = i.face?.topology
        let applied = false
        try {
          const d = designOf(i.design)
          if (reference && i.part !== undefined && i.part !== reference.part) throw new ToolInputError('The part conflicts with the scoped face reference.')
          const host = designs()
          if (reference && !host.addWithReceipt) throw new ToolInputError('This host cannot return an atomic edit receipt.', 'not_supported')
          const find = (part: number, req: Record<string, unknown>, body = d) => findHole((r) => engine('hole.find', r), { mesh: item(body, part), ...req })
          let part: number
          let before: FoundHole
          if (i.face) {
            const f = pickIn(d, i.face)
            part = f.part
            before = await find(part, { triangle: f.triangle, at: f.at })
          } else {
            // the first part with a hole on that line; with none, the most telling refusal (a round face there that is not a hole)
            const tries = i.part !== undefined ? [i.part] : d.parts.map((_, k) => k)
            const misses: unknown[] = []
            let hit: { part: number; hole: FoundHole } | null = null
            for (const k of tries) {
              try {
                hit = { part: k, hole: await find(k, { at: i.center, axis: i.axis }) }
                break
              } catch (err) {
                misses.push(pickError(err))
              }
            }
            if (!hit) throw misses.find((e) => !/on that axis line/.test(e instanceof Error ? e.message : '')) ?? misses[0] ?? new ToolInputError('part: the design has no parts')
            part = hit.part
            before = hit.hole
          }
          const s = spec(before)
          if (reference) {
            checkedManifest(d.id, reference.revision)
            const initial = verifyHole(before, before, {})
            if (initial.status !== 'verified' || before.diameterMm <= 0 || before.depthMm <= 0 || typeof before.through !== 'boolean') throw new ToolInputError('The hole measurement is invalid. Inspect the body again before editing.', 'invalid_model')
          }
          let commit: DesignCommit | undefined
          try {
            const params = plain<StepParams>({ op: 'hole.apply', hole: before, spec: s, label: i.label ?? `Hole ${Math.round(s.diameterMm * 100) / 100} mm` })
            if (reference) commit = await host.addWithReceipt!(d, part, params, undefined, withFeature(i.feature, { expectedRevision: reference.revision }))
            else await host.add(d, part, params, undefined, withFeature(i.feature))
          } catch (e) {
            if (e instanceof StaleBody) throw new ToolInputError(e.message, 'stale_body', { bodyId: e.bodyId, currentRevision: e.currentRevision })
            throw e
          }
          applied = true
          if (commit && reference) {
            const topology = manifestOf(commit.design, commit.revision)
            const out = stepOut(commit.design, verb(before, s))
            let after: Record<string, unknown> | null = null
            let verification: ReturnType<typeof verifyHole> | { status: 'failed'; reason: string }
            try {
              const shaft = await find(part, onAxis(before), commit.design)
              verification = verifyHole(before, shaft, i)
              if (verification.checks.finite && verification.measuredDepthMm !== null) after = readHole({ ...before, diameterMm: shaft.diameterMm, depthMm: verification.measuredDepthMm, through: shaft.through })
            }
            catch (e) { verification = { status: 'failed', reason: e instanceof Error ? e.message : String(e) } }
            return { summary: `${out.summary}${verification.status === 'failed' ? '; the edit was applied but its read-back failed' : verification.status === 'unverified' ? '; head dimensions remain unverified' : ''}`, output: {
              ...out.output, part, before: readHole(before), after, topology: compactManifest(topology),
              operationResult: { operation: 'geom.hole_edit', status: 'applied', bodyId: d.id, priorRevision: reference.revision,
                revision: commit.revision, target: reference, verification,
                measurements: { source: 'tessellation', before: readHole(before), after } },
            } }
          }
          const after = readMade(before, await find(part, onAxis(before)), i)
          const out = stepOut(d, verb(before, s))
          return { summary: out.summary, output: { ...out.output, part, before: readHole(before), after } }
        } catch (e) {
          if (!reference || applied) throw e
          let current: ReturnType<typeof manifestOf> | undefined
          try { current = manifestOf(designOf(i.design)) } catch { /* the body may have been removed */ }
          const rawCode = e instanceof StaleBody ? 'stale_body' : e instanceof ToolInputError ? e.code : e instanceof Error && 'code' in e && e.code === 'not_found' ? 'not_found' : 'internal_error'
          const code = rawCode === 'not_found' ? 'stale_body' : rawCode
          throw new ToolInputError(e instanceof Error ? e.message : 'The edit was refused.', code, {
            ...(e instanceof ToolInputError ? e.details : {}),
            bodyId: bodyIdOf(i.design), currentRevision: current?.revision ?? null,
            topology: current ? compactManifest(current) : null,
            operationResult: { operation: 'geom.hole_edit', status: 'refused', reason: code, bodyId: bodyIdOf(i.design),
              priorRevision: reference.revision, revision: current?.revision ?? null, target: reference },
          })
        }
      }
      const stlPath = await path(i.model!)
      const find = (mesh: string, req: Record<string, unknown>) => findHole((r) => call('hole.find', r), { mesh: { stlPath: mesh }, ...req })
      const before = i.face ? await find(stlPath, await pick(stlPath, i.face)) : await find(stlPath, { at: i.center, axis: i.axis })
      const s = spec(before)
      const out = await call('hole.apply', { mesh: { stlPath }, hole: before, spec: s })
      const made = (out['mesh'] as { stlPath?: string } | undefined)?.stlPath
      const after = made ? readMade(before, await find(made, onAxis(before)), i) : undefined
      return { summary: verb(before, s), output: { ...out, before: readHole(before), ...(after ? { after } : {}) } }
    },
  })

  // A pick that finds no hole most often means a new hole was wanted, which this tool does not make: the refusal says
  // how to make one.
  const resize = holeEdit.run.bind(holeEdit)
  holeEdit.run = async (i, ctx) => {
    try {
      return await resize(i, ctx)
    } catch (e) {
      const m = e instanceof Error ? e.message : ''
      if (!/^pick: (?:no round hole|the hole does not end)/.test(m)) throw e
      throw new ToolInputError(`${m.replace(/\.$/, '')}. This tool changes a hole that is already there; for a new hole, use geom.hole`, e instanceof ToolInputError ? e.code : 'invalid_input', e instanceof ToolInputError ? e.details : undefined)
    }
  }

  const holeMake = defineTool({
    name: 'geom.hole',
    version: '2.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Make a new round hole in a model or a design, a circle on the face it starts at cut into it: diameter_mm across, through the wall it starts in or depth_mm deep, with a counterbore or a countersink at its entry. Give "center", its center on the flat face it starts at (or any point on its axis line), and "axis", the hole\'s axis either way round (left out, square to the face at center); or "face", a point on that face, for a hole square to it. The whole circle, and the head\'s, must sit on that flat face. To change a hole already there, use geom.hole_edit; a hole already on that axis is refused. Returns the hole as made (center, axis, diameterMm, depthMm, kind through or blind, head). With "design" it adds a cut step, and a second one for a counterbore or a countersink; with a model it writes the new STL.',
    localDescription:
      'Make a new round hole of diameter_mm in a model or a design, through the wall it starts in or depth_mm deep, with a counterbore or countersink at its entry. Give center (its center on the flat face it starts at) and axis, or face (a point on that face). To change a hole already there, use geom.hole_edit. More: kb.search "make a hole".',
    input: z.object({
      model: modelOrDesign,
      design: designArg.optional(),
      feature: featureArg,
      part: partArg.describe('With a design: the part to cut it in (default: the part its axis line meets first)'),
      center: vec3.optional().describe('The hole\'s center on the face it starts at, mm, or any point on its axis line'),
      axis: vec3.optional().describe('With center: the hole\'s axis, either way round (default: square to the face at center)'),
      face: z.object({ at: vec3, normal: vec3.optional() }).optional().describe('Instead of center: {"at":[x,y,z]}, a point on the face it starts at (with "normal" on an edge); the hole goes square into it'),
      diameter_mm: z.number().positive().max(10_000),
      depth_mm: z.number().positive().max(10_000).optional().describe('A blind hole\'s depth from its entry; left out, it goes through the wall it starts in'),
      counterbore: z.object({ diameter_mm: z.number().positive().max(10_000), depth_mm: z.number().positive().max(10_000) }).optional().describe('A counterbore at the entry for a screw head: wider than the hole, less deep'),
      countersink: z.object({ diameter_mm: z.number().positive().max(10_000), angle_deg: z.number().min(30).max(90).default(90) }).optional().describe('A countersink at the entry for a flat head: its diameter on the face, and the cone\'s full angle, 30 to 90 (90 for most metric screws)'),
      label: z.string().min(1).max(120).optional().describe('With a design: the step\'s name in the history, such as "M3 clearance"; default "Hole <diameter> mm"'),
    }),
    async run(i) {
      oneOf(i)
      // narrower than the nozzle closes up as it prints: refused as the hole tool refuses it, before the engine runs
      const small = customHoleProblem(i.diameter_mm, nozzleOr(deps.nozzleMm?.()))
      if (small) throw new ToolInputError(small)
      if (i.center && i.face) throw new ToolInputError('give "center" (with "axis") or "face", not both')
      if (!i.center && !i.face) throw new ToolInputError('center: give the hole\'s center on the face it starts at, with its axis, or "face", a point on that face')
      if (i.face && i.axis) throw new ToolInputError('axis: a hole picked by "face" goes square into it; for another axis give "center" and "axis"')
      if (i.counterbore && i.countersink) throw new ToolInputError('a hole takes a counterbore or a countersink, not both')
      const head = i.counterbore ?? i.countersink
      const headName = i.counterbore ? 'counterbore' : 'countersink'
      if (head && head.diameter_mm <= i.diameter_mm) throw new ToolInputError(`${headName}: its diameter_mm must be more than the hole's ${r3(i.diameter_mm)} mm`)
      const at = (i.center ?? i.face!.at) as V3
      const normal = i.face?.normal as V3 | undefined
      const axis = i.axis as V3 | undefined
      const radius = Math.max(i.diameter_mm, head?.diameter_mm ?? 0) / 2
      // a hole already on that axis line, where the new one would start, is refused: changing one is geom.hole_edit's.
      // A wider hole round the line (a planter's bore over its drain holes) or one along the line past the entry is not
      const already = async (find: (req: Record<string, unknown>) => Promise<FoundHole>, from: V3, along: V3, entry?: V3): Promise<void> => {
        const h = await find({ at: from, axis: along }).catch(() => null)
        if (!h) return
        const a = unit(along)!
        const d = sub(h.entry, from)
        const off = len(sub(d, a.map((c) => c * dot(d, a)) as V3))
        if (off > Math.max(0.05, 0.01 * h.diameterMm)) return
        const t = entry ? dot(sub(h.entry, entry), h.axis) : 0
        if (t < -0.05 || t > h.depthMm + 0.05) return
        throw new ToolInputError(`center: a ${r3(h.diameterMm)} mm hole is on that axis already, entering at (${h.entry.map(r3).join(', ')}); to change it, use geom.hole_edit`)
      }
      // where the hole goes, and the cut that makes it: a circle on the entry face cut into it, as Extrude with Cut does
      const placed = async (tris: readonly Tri[], find: (req: Record<string, unknown>) => Promise<FoundHole>) => {
        let p: ReturnType<typeof newHolePath>
        try {
          p = newHolePath(tris, at, axis, normal, radius)
        } catch (e) {
          if (axis) await already(find, at, axis)
          throw e
        }
        await already(find, p.entry, p.into, p.entry)
        const through = i.depth_mm === undefined || i.depth_mm >= p.wallMm - HOLE_FLAT_MM
        const deep = through ? p.wallMm : i.depth_mm!
        if (i.counterbore && i.counterbore.depth_mm >= deep) throw new ToolInputError(`counterbore: its depth_mm must be less than the hole's ${r3(deep)} mm`)
        const circle = (diameterMm: number, distanceMm: number, taperDeg?: number) => ({
          frame: frameFor(p.entry, p.into.map((c) => -c) as V3),
          shape: { type: 'circle' as const, diameterMm },
          placement: { center: [0, 0] as [number, number] },
          spec: { distanceMm, extent: 'oneSide' as const, operation: 'cut' as const, ...(taperDeg ? { taperDeg } : {}) },
        })
        // to a ten-thousandth of a mm, so a depth read from float32 positions reads as typed in the history
        const cut = circle(i.diameter_mm, Math.round((through ? deep + HOLE_OVERLAP_MM : deep) * 1e4) / 1e4)
        // the head is a second cut on the same face: a wider circle for a counterbore, one narrowing to the hole for a
        // countersink (its sides drafted by half the cone's angle)
        const half = ((i.countersink?.angle_deg ?? 90) * Math.PI) / 360
        const headCut = i.counterbore
          ? circle(i.counterbore.diameter_mm, i.counterbore.depth_mm)
          : i.countersink
            ? circle(i.countersink.diameter_mm, (i.countersink.diameter_mm - i.diameter_mm) / 2 / Math.tan(half), i.countersink.angle_deg / 2)
            : undefined
        if (i.countersink && headCut!.spec.distanceMm >= deep) throw new ToolInputError(`countersink: its cone, ${r3(headCut!.spec.distanceMm)} mm deep, must be less deep than the hole's ${r3(deep)} mm`)
        return { ...p, through, cut, headCut }
      }
      const headLabel = head ? `${headName === 'counterbore' ? 'Counterbore' : 'Countersink'} ${Math.round(head.diameter_mm * 100) / 100} mm` : ''
      const verb = (through: boolean) => `Made a ${r3(i.diameter_mm)} mm ${through ? 'through' : 'blind'} hole${head ? ` with a ${headName}` : ''}`
      const plainHole = (h: FoundHole) => ({ ...readHole(h), head: 'none' })
      const onAxis = (h: FoundHole) => ({ at: h.entry, axis: h.axis })
      if (i.design) {
        const d = designOf(i.design)
        const tris = d.parts.map((x) => partTriangles(bakeMesh(x, d.transform)))
        const findIn = (k: number) => (req: Record<string, unknown>) => findHole((r) => engine('hole.find', r), { mesh: item(d, k), ...req })
        if (i.part !== undefined && !tris[i.part]) throw new ToolInputError(`part: the design has ${tris.length} part${tris.length === 1 ? '' : 's'}`)
        let part = i.part
        if (part === undefined && axis) {
          const a = unit(axis)
          if (!a) throw new ToolInputError('axis: must be a non-zero vector')
          const first = tris.map((t, k) => ({ k, s: Math.min(...lineHits(t, at, a).map((h) => Math.abs(h.s))) })).filter((x) => Number.isFinite(x.s)).sort((x, y) => x.s - y.s)[0]
          if (!first) {
            // the line runs down a hole's middle and meets no face
            for (const k of tris.keys()) await already(findIn(k), at, a)
            throw new ToolInputError(`center: the hole's axis line through (${at.map(r3).join(', ')}) meets no part of the design; give its center on the face it starts at`)
          }
          part = first.k
        }
        part ??= faceAt(d, at, normal).part
        const k = part
        const find = findIn(k)
        const p = await placed(tris[k]!, find)
        const host = designs()
        const steps = d.history.steps.length
        const redo = d.redo
        await host.add(d, k, plain<StepParams>({ op: 'shape.extrude', ...p.cut }), i.label ?? `Hole ${Math.round(i.diameter_mm * 100) / 100} mm`, withFeature(i.feature))
        // the hole as cut, when the engine reads it as a hole (one that runs out through a round face does not)
        const hole = await find({ at: p.entry, axis: p.into }).catch(() => null)
        if (p.headCut) {
          try {
            await host.add(d, k, plain<StepParams>({ op: 'shape.extrude', ...p.headCut }), headLabel, withFeature(i.feature))
          } catch (e) {
            // a head that does not go on takes the cut back off, so a call does all or nothing
            await replayChange(host, d, { ...d.history, steps: d.history.steps.slice(0, steps) }, redo)
            throw e
          }
        }
        let made: Record<string, unknown> | null = null
        if (hole) made = p.headCut ? await find(onAxis(hole)).then((shaft) => readMade(hole, shaft, i), () => null) : plainHole(hole)
        const out = stepOut(d, verb(p.through))
        return { summary: made ? out.summary : `${out.summary}; the hole was cut but not read back`, output: { ...out.output, part: k, hole: made } }
      }
      const stlPath = await path(i.model!)
      const find = (mesh: string, req: Record<string, unknown>) => findHole((r) => call('hole.find', r), { mesh: { stlPath: mesh }, ...req })
      const p = await placed(triangles(stlPath), (req) => find(stlPath, req))
      let out = await call('shape.extrude', { ...p.cut, target: { stlPath } })
      const cut = (out['mesh'] as { stlPath?: string } | undefined)?.stlPath
      let made: Record<string, unknown> | null = null
      if (cut) {
        const hole = await find(cut, { at: p.entry, axis: p.into }).catch(() => null)
        if (p.headCut) {
          out = await call('shape.extrude', { ...p.headCut, target: { stlPath: cut } })
          const headed = (out['mesh'] as { stlPath?: string } | undefined)?.stlPath
          made = headed && hole ? await find(headed, onAxis(hole)).then((shaft) => readMade(hole, shaft, i), () => null) : null
        } else made = hole && plainHole(hole)
      }
      return { summary: made ? verb(p.through) : `${verb(p.through)}; the hole was cut but not read back`, output: { ...out, hole: made } }
    },
  })

  return [faces, facePick, edgePick, sketchCheck, sketchSolve, sketchEdit, sketch, sketchSvg, traceImage, extrude, revolve, loft, sweep, sketchProject, push, boolean, fillet, chamfer, info, measure, fitCheck, interference, shell, holeMake, holeEdit] as PilotTool<never>[]
}
