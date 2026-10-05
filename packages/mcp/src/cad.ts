// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// CAD tools on the sx-geom engine: sketch and extrude, revolve, push and pull,
// booleans, fillet and chamfer, and the face and edge lookups a client needs to
// target them. Each tool is one engine op (docs/cad-fillet.md and
// docs/build-on-the-engine.md describe the JSON), run like the other geom tools.
// The engine picks faces by triangle index; a client knows points, so the
// lookups here turn a point on a face (and its normal) into that index.
import { readFileSync } from 'node:fs'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { geomCaller, modelArg, vec3, type GeomToolDeps } from './geom'
import { readStlPositions } from './mesh'
import { resolveModel, ToolInputError } from './models'

type V3 = [number, number, number]

const vec2 = z.tuple([z.number(), z.number()])

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

interface Tri {
  p: [V3, V3, V3]
  n: V3
  area: number
}

function triangles(stlPath: string): Tri[] {
  const pos = readStlPositions(readFileSync(stlPath))
  const out: Tri[] = []
  for (let t = 0; t + 9 <= pos.length; t += 9) {
    const at = (k: number): V3 => [pos[t + k] ?? 0, pos[t + k + 1] ?? 0, pos[t + k + 2] ?? 0]
    const p: [V3, V3, V3] = [at(0), at(3), at(6)]
    const c = cross(sub(p[1], p[0]), sub(p[2], p[0]))
    out.push({ p, n: unit(c) ?? [0, 0, 0], area: len(c) / 2 })
  }
  return out
}

/** Distance from a point to a triangle (closest point on the triangle, Ericson 5.1.5). */
function distance(q: V3, [a, b, c]: [V3, V3, V3]): number {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(q, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return len(ap)
  const bp = sub(q, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return len(bp)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const s = d1 / (d1 - d3)
    return len(sub(q, [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s]))
  }
  const cp = sub(q, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return len(cp)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const s = d2 / (d2 - d6)
    return len(sub(q, [a[0] + ac[0] * s, a[1] + ac[1] * s, a[2] + ac[2] * s]))
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const s = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return len(sub(q, [b[0] + (c[0] - b[0]) * s, b[1] + (c[1] - b[1]) * s, b[2] + (c[2] - b[2]) * s]))
  }
  const den = 1 / (va + vb + vc)
  const v = vb * den
  const w = vc * den
  return len(sub(q, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]))
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
    if (dot(best.t.n, want) < Math.cos((2 * Math.PI) / 180)) throw new ToolInputError('normal: no face at that point faces that way; give the outward normal of the face you mean')
    return best.i
  }
  const first = near[0]
  if (!first) throw new ToolInputError('at: no face there')
  if (near.some(({ t }) => dot(t.n, first.t.n) < 0.9999)) throw new ToolInputError('at: the point is on an edge between faces; give normal, the outward normal of the face you mean')
  return first.i
}

interface FaceSummary {
  triangle: number
  at: V3
  normal: V3
  facing?: string
  areaMm2: number
  center: V3
}

const AXES: [string, V3][] = [['+x', [1, 0, 0]], ['-x', [-1, 0, 0]], ['+y', [0, 1, 0]], ['-y', [0, -1, 0]], ['+z (top)', [0, 0, 1]], ['-z (bottom)', [0, 0, -1]]]

/** Flat faces: triangles joined across shared edges while they lie in one plane. */
export function flatFaces(tris: Tri[]): FaceSummary[] {
  const key = (v: V3): string => v.map((c) => Math.round(c * 1e4)).join(',')
  const parent = tris.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] ?? i] ?? i
    return i
  }
  const edges = new Map<string, number>()
  tris.forEach((t, i) => {
    if (t.area <= 0) return
    for (let k = 0; k < 3; k++) {
      const a = key(t.p[k] as V3)
      const b = key(t.p[(k + 1) % 3] as V3)
      const e = a < b ? `${a}|${b}` : `${b}|${a}`
      const j = edges.get(e)
      if (j === undefined) {
        edges.set(e, i)
        continue
      }
      const o = tris[j]
      if (o && dot(o.n, t.n) > 0.99999 && Math.abs(dot(o.n, sub(t.p[0], o.p[0]))) < 1e-3) parent[find(i)] = find(j)
    }
  })
  const groups = new Map<number, number[]>()
  tris.forEach((t, i) => {
    if (t.area <= 0) return
    const r = find(i)
    groups.set(r, [...(groups.get(r) ?? []), i])
  })
  const round = (v: V3): V3 => v.map((c) => Math.round(c * 1000) / 1000) as V3
  const out: FaceSummary[] = []
  for (const list of groups.values()) {
    let area = 0
    const c: V3 = [0, 0, 0]
    let big = list[0] ?? 0
    for (const i of list) {
      const t = tris[i] as Tri
      area += t.area
      for (let k = 0; k < 3; k++) c[k] = (c[k] ?? 0) + ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) * (t.area / 3)
      if (t.area > (tris[big]?.area ?? 0)) big = i
    }
    const t = tris[big] as Tri
    const centroid: V3 = [0, 1, 2].map((k) => ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) / 3) as V3
    const facing = AXES.find(([, a]) => dot(a, t.n) > 0.9998)?.[0]
    out.push({ triangle: big, at: round(centroid), normal: round(t.n), ...(facing ? { facing } : {}), areaMm2: Math.round(area * 1000) / 1000, center: round(c.map((x) => x / area) as V3) })
  }
  return out.sort((a, b) => b.areaMm2 - a.areaMm2)
}

const faceRef = z
  .object({
    at: vec3.optional().describe('A point on the face, mm (the "at" of slicerx_geom_faces, or any point on it)'),
    normal: vec3.optional().describe('Outward normal of the face; needed when "at" lies on an edge'),
    triangle: z.number().int().min(0).optional().describe('Triangle index from slicerx_geom_faces, instead of a point'),
  })
  .describe('The face: {"at":[x,y,z],"normal":[x,y,z]} or {"triangle":n}')

const frameSchema = z
  .object({ origin: vec3, normal: vec3, u: vec3.optional(), v: vec3.optional() })
  .describe('Sketch plane: the "frame" of slicerx_geom_face_pick, or {"origin":[x,y,z],"normal":[x,y,z]} for any plane. Shape and sketch coordinates are [u, v] in it. Absent: the bed (origin 0,0,0, normal +Z, u along +X)')

const segment = z
  .object({
    type: z.enum(['line', 'arc']),
    to: vec2.optional(),
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
  .describe('{"type":"line","to":[u,v]}, {"type":"line","lengthMm":l,"angleDeg":a}, {"type":"line","lengthMm":l,"turnDeg":t}, {"type":"arc","center":[u,v],"sweepDeg":s}, {"type":"arc","to":[u,v],"through":[u,v]}, {"type":"arc","to":[u,v],"radiusMm":r,"clockwise"?:b,"large"?:b}, or {"type":"arc","radiusMm":r,"sweepDeg":s} (tangent)')

const loop = z
  .union([
    z.object({ type: z.literal('circle'), center: vec2, diameterMm: z.number().positive() }),
    z.object({ start: vec2, segments: z.array(segment).min(1).max(512) }),
    z.object({ points: z.array(vec2).min(3).max(4096) }),
  ])
  .describe('A closed loop: {"points":[[u,v],...]}, {"type":"circle","center":[u,v],"diameterMm":d}, or {"start":[u,v],"segments":[...]}. A loop inside another is a hole')

const loops = z.array(loop).min(1).max(256)

const shape = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('rectangle'), widthMm: z.number().positive(), heightMm: z.number().positive(), cornerRadiusMm: z.number().min(0).optional() }),
    z.object({ type: z.literal('circle'), diameterMm: z.number().positive() }),
    z.object({ type: z.literal('slot'), lengthMm: z.number().positive(), widthMm: z.number().positive() }),
    z.object({ type: z.literal('polygon'), sides: z.number().int().min(3).max(256), diameterMm: z.number().positive(), fit: z.enum(['inscribed', 'circumscribed']).optional() }),
    z.object({ type: z.literal('text'), text: z.string().min(1).max(200), sizeMm: z.number().positive(), letterSpacingMm: z.number().optional(), lineSpacing: z.number().positive().optional(), align: z.enum(['left', 'center', 'right']).optional() }),
    z.object({ type: z.literal('sketch'), loops }),
    z.object({ type: z.literal('svg'), svg: z.string().min(1).max(2_000_000), widthMm: z.number().positive(), toleranceMm: z.number().positive().optional() }),
  ])
  .describe('What to extrude, in the plane: rectangle, circle, slot, polygon or text centered on placement.center, a free sketch of closed loops (as typed), or SVG artwork scaled to widthMm')

const operation = z.enum(['new', 'join', 'cut']).default('new').describe('new: a separate body; join: add to target; cut: remove from target')
const edgeRef = z.object({ a: vec3, b: vec3, face: vec3 }).describe('An edge as slicerx_geom_edge_pick returns it: end points a and b and the normal of its first face')

/** Drops per-triangle lists from a reply; a client never needs them and they are long. */
function lean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(lean)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === 'triangles' && Array.isArray(x))).map(([k, x]) => [k, lean(x)]))
  return v
}

export function cadTools(deps: GeomToolDeps): PilotTool<never>[] {
  const call = geomCaller(deps)
  const path = (model: string): Promise<string> => resolveModel(deps.policy, model)
  const target = async (model: string | undefined, op: string): Promise<Record<string, unknown>> => {
    if (op === 'new') return {}
    if (!model) throw new ToolInputError(`target: ${op} needs a target model`)
    return { target: { stlPath: await path(model) } }
  }
  const pick = async (stlPath: string, face: z.infer<typeof faceRef>): Promise<{ triangle: number; at: V3 }> => {
    const tris = triangles(stlPath)
    if (face.triangle !== undefined) {
      const t = tris[face.triangle]
      if (!t) throw new ToolInputError(`triangle: out of range (the model has ${tris.length})`)
      return { triangle: face.triangle, at: face.at ?? ([0, 1, 2].map((k) => ((t.p[0][k] ?? 0) + (t.p[1][k] ?? 0) + (t.p[2][k] ?? 0)) / 3) as V3) }
    }
    if (!face.at) throw new ToolInputError('face: give "at" (a point on the face) or "triangle"')
    return { triangle: triangleAt(tris, face.at, face.normal), at: face.at }
  }
  const plane = (f: z.infer<typeof frameSchema> | undefined): Record<string, unknown> => (f ? { frame: frameFor(f.origin, f.normal, f.u) } : {})

  const faces = defineTool({
    name: 'geom.faces',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'List the flat faces of a model, largest first: a point "at" on each face, its outward normal, which axis it faces (+z (top), -x and so on), its area and center. Use a face\'s "at" and "normal" with slicerx_geom_face_pick, slicerx_geom_edge_pick or slicerx_geom_push_pull. Curved surfaces show up as many small faces.',
    input: z.object({ model: modelArg, limit: z.number().int().min(1).max(500).default(40) }),
    async run(i) {
      const all = flatFaces(triangles(await path(i.model)))
      return { summary: `${all.length} flat face${all.length === 1 ? '' : 's'}${all.length > i.limit ? `, the largest ${i.limit} listed` : ''}`, output: { count: all.length, faces: all.slice(0, i.limit) } }
    },
  })

  const facePick = defineTool({
    name: 'geom.face_pick',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Pick a flat face of a model: returns its sketch frame (origin, normal, u, v in mm), its outline in that frame, area and bounds. Pass the frame to slicerx_geom_extrude or slicerx_geom_revolve to sketch on the face; outline points are [u, v] in it.',
    input: z.object({ model: modelArg, face: faceRef }),
    async run(i) {
      const stlPath = await path(i.model)
      const out = await call('face.pick', { mesh: { stlPath }, ...(await pick(stlPath, i.face)) })
      return { summary: `Picked a face of ${Math.round(Number(out['areaMm2'] ?? 0) * 100) / 100} mm2`, output: lean(out) }
    },
  })

  const edgePick = defineTool({
    name: 'geom.edge_pick',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Pick an edge for a fillet or chamfer: give a point on a flat face near the edge (or on the edge) and that face\'s normal. Returns the edge (pass it to slicerx_geom_fillet or slicerx_geom_chamfer as is), its length, whether it is convex, whether it can be filleted and why not, the largest radius and bevel that fit, the tangent chain it belongs to, and the loop of every edge around that face.',
    input: z.object({ model: modelArg, face: faceRef.describe('The face the edge bounds: {"at":[x,y,z] near the edge,"normal":[x,y,z]} or {"triangle":n}') }),
    async run(i) {
      const stlPath = await path(i.model)
      const out = await call('edge.pick', { mesh: { stlPath }, ...(await pick(stlPath, i.face)) })
      return { summary: out['supported'] ? `Picked an edge of ${String(out['lengthMm'])} mm, fillet up to ${String(out['maxRadiusMm'])} mm` : `Picked an edge that cannot be filleted: ${String(out['reason'] ?? '')}`, output: lean(out) }
    },
  })

  const sketchCheck = defineTool({
    name: 'geom.sketch_check',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Check sketch loops before extruding or revolving: whether they close and do not cross, which loops are holes, the filled area, and each problem with the loop and segment that causes it. There is no constraint solver; positions are as typed.',
    input: z.object({ loops }),
    async run(i) {
      const out = await call('sketch.check', { loops: i.loops })
      return { ok: out['ok'] === true, summary: out['ok'] === true ? `The sketch is closed, ${String(out['areaMm2'])} mm2` : `The sketch has ${Array.isArray(out['issues']) ? out['issues'].length : 0} problem(s)`, output: out }
    },
  })

  const extrude = defineTool({
    name: 'geom.extrude',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Sketch and extrude: a shape (rectangle, circle, slot, polygon, text, a free sketch of lines and arcs, or SVG artwork) on the bed, any plane or a picked face, extruded as a new body, joined to a target model, or cut from it. Writes the result as an STL ("mesh") and the extruded solid ("tool"), with volume, bounds and whether it is watertight.',
    input: z.object({
      shape,
      frame: frameSchema.optional(),
      placement: z.object({ center: vec2.optional(), rotationDeg: z.number().optional() }).optional().describe('Where the shape sits in the plane: center [u, v] and rotation, degrees'),
      distance_mm: z.number().positive().max(10_000),
      extent: z.enum(['oneSide', 'symmetric', 'twoSides']).default('oneSide'),
      distance2_mm: z.number().positive().max(10_000).optional().describe('Second distance for extent twoSides'),
      flip: z.boolean().optional().describe('Reverse the direction. By default new and join go out along the plane normal and cut goes into the face'),
      taper_deg: z.number().min(-45).max(45).optional().describe('Draft angle; positive narrows away from the plane'),
      operation,
      target: modelArg.optional().describe('The model to join to or cut from'),
    }),
    async run(i) {
      const spec = { distanceMm: i.distance_mm, extent: i.extent, operation: i.operation, ...(i.distance2_mm !== undefined ? { distance2Mm: i.distance2_mm } : {}), ...(i.flip !== undefined ? { flip: i.flip } : {}), ...(i.taper_deg !== undefined ? { taperDeg: i.taper_deg } : {}) }
      const out = await call('shape.extrude', { shape: i.shape, ...plane(i.frame), ...(i.placement ? { placement: i.placement } : {}), spec, ...(await target(i.target, i.operation)) })
      return { summary: `${i.operation === 'cut' ? 'Cut' : i.operation === 'join' ? 'Joined' : 'Extruded'} a ${i.shape.type} ${i.distance_mm} mm`, output: out }
    },
  })

  const revolve = defineTool({
    name: 'geom.revolve',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Revolve a sketch profile around an axis in its plane, up to 360 degrees, as a new body, joined to a target or cut from it. The profile must stay on one side of the axis. Writes the result as an STL.',
    input: z.object({
      loops,
      frame: frameSchema.optional(),
      axis: z.object({ point: vec2, direction: vec2 }).describe('The axis in the sketch plane, [u, v]'),
      angle_deg: z.number().positive().max(360).default(360),
      operation,
      target: modelArg.optional(),
    }),
    async run(i) {
      const out = await call('sketch.revolve', { loops: i.loops, ...plane(i.frame), axis: i.axis, angleDeg: i.angle_deg, operation: i.operation, ...(await target(i.target, i.operation)) })
      return { summary: `Revolved the sketch ${i.angle_deg} degrees`, output: out }
    },
  })

  const push = defineTool({
    name: 'geom.push_pull',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Push or pull a flat face of a model along its normal: a positive distance pulls it out and adds material, a negative one pushes it in and cuts; pushing past the far side makes a hole. Writes the new STL and reports the volume change and the moved face.',
    input: z.object({ model: modelArg, face: faceRef, distance_mm: z.number().min(-10_000).max(10_000).refine((d) => d !== 0, 'must not be zero') }),
    async run(i) {
      const stlPath = await path(i.model)
      const out = await call('face.push', { mesh: { stlPath }, ...(await pick(stlPath, i.face)), distanceMm: i.distance_mm })
      return { summary: `${i.distance_mm > 0 ? 'Pulled' : 'Pushed'} the face ${Math.abs(i.distance_mm)} mm`, output: out }
    },
  })

  const BOOL = { union: 'union', subtract: 'difference', intersect: 'intersection' } as const
  const boolean = defineTool({
    name: 'geom.boolean',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Union, subtract or intersect closed models: union joins "model" and every model in "with", subtract removes them from "model", intersect keeps what they share. Writes one manifold STL, or fails with a reason.',
    input: z.object({ op: z.enum(['union', 'subtract', 'intersect']), model: modelArg, with: z.array(modelArg).min(1).max(32) }),
    async run(i) {
      const a = [{ stlPath: await path(i.model) }]
      const b = await Promise.all(i.with.map(async (m) => ({ stlPath: await path(m) })))
      const out = await call('boolean', i.op === 'union' ? { op: 'union', a: [...a, ...b], b: [] } : { op: BOOL[i.op], a, b })
      return { summary: `${i.op[0]?.toUpperCase()}${i.op.slice(1)}: ${String(out['shells'] ?? '?')} shell(s), ${Math.round(Number(out['volumeMm3'] ?? 0))} mm3`, output: out }
    },
  })

  const edges = z.array(edgeRef).min(1).max(256)
  const plural = (n: number): string => `${n} edge${n === 1 ? '' : 's'}`

  const fillet = defineTool({
    name: 'geom.fillet',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Round straight edges where two flat faces meet, with one radius: convex edges lose material, concave edges gain it, and three filleted edges at a corner get a sphere patch. Take the edges from slicerx_geom_edge_pick (its chain or loop picks several). Writes the new STL.',
    input: z.object({ model: modelArg, edges, radius_mm: z.number().positive().max(1000), tolerance_mm: z.number().min(0.001).max(1).optional().describe('Chord tolerance of the round, default 0.01 mm') }),
    async run(i) {
      const { model, ...rest } = i
      const out = await call('edge.fillet', { mesh: { stlPath: await path(model) }, ...rest })
      return { summary: `Filleted ${plural(i.edges.length)} at ${i.radius_mm} mm`, output: out }
    },
  })

  const chamfer = defineTool({
    name: 'geom.chamfer',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      "Bevel straight edges where two flat faces meet, set back by distance_mm on each face (or distance_mm on the edge's own face and distance2_mm on the other). Take the edges from slicerx_geom_edge_pick. Writes the new STL.",
    input: z.object({ model: modelArg, edges, distance_mm: z.number().positive().max(1000), distance2_mm: z.number().positive().max(1000).optional() }),
    async run(i) {
      const { model, ...rest } = i
      const out = await call('edge.chamfer', { mesh: { stlPath: await path(model) }, ...rest })
      return { summary: `Chamfered ${plural(i.edges.length)} at ${i.distance_mm} mm`, output: out }
    },
  })

  return [faces, facePick, edgePick, sketchCheck, extrude, revolve, push, boolean, fillet, chamfer] as PilotTool<never>[]
}
