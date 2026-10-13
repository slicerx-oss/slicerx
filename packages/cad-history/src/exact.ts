// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps on exact solids (packages/brep, the brep.* ops) in a replay that asks for them (ReplayRequest.exact, behind a
// developer flag for now). A solid is a cache of the replay itself: a new body step makes one, the kernel's steps
// carry it, and a solid from anywhere else is never read. A step the kernel has no version of, or whose part has no
// solid, returns null and the mesh path runs it; so does a step the kernel fails, with a note. The mesh each step
// leaves is the solid's tessellation, with the solid's faces and keys.
import type { FaceFrame, Shape, Vec2, Vec3 } from './types'
import { direction, invert, point, type HistoryMesh, type Mat4, type PaintTexts, type Step, type StepParams } from './model'

export type Call = (op: string, request: unknown) => Promise<unknown>

/** A part as replay carries it. */
export interface ExactPart {
  name: string
  slot: number
  positions: number[]
  indices: number[]
  faces?: NonNullable<HistoryMesh['faces']>
  paint?: PaintTexts
  smb?: string
  /** The solid as a body number in the kernel, when the replay's engine keeps bodies between calls (the worker). */
  body?: number
  /** With `body`, before the part is tessellated: its faces' keys. Its mesh is empty until a step or the result
   * needs it (meshed). */
  unmeshed?: number[]
}

/** How a replay holds its solids: as text through each call, or (`keep`) as kernel bodies, each one `made` told. */
export interface Solids {
  keep: boolean
  made: (body: number) => void
}

/** The largest solid text kept with a part; a bigger one is dropped and the part goes on on the mesh. */
export const MAX_SOLID_TEXT = 8 * 1024 * 1024

/** The note on a step the kernel could not do, which then ran on the mesh. */
export const EXACT_FELL_BACK = 'The exact solid could not do this step, so it ran on the mesh.'

/** Thrown for an answer that is the step's real outcome, not a kernel failure (no fallback). */
export class ExactBroken extends Error {}

interface Tessellated {
  positions: number[]
  indices: number[]
  faceIds: number[]
  faces: { surface: unknown; key: number }[]
}

/** A part from a solid: its tessellation with faces and keys, and the solid's text unless it is too big to keep. */
export async function fromSolid(call: Call, like: Pick<ExactPart, 'name' | 'slot'>, smb: string): Promise<ExactPart> {
  const t = (await call('brep.tessellate', { body: { smb } })) as Tessellated
  return { name: like.name, slot: like.slot, ...tessellated(t), ...(smb.length <= MAX_SOLID_TEXT ? { smb } : {}) }
}

/** The part with its body tessellated, when it has not been yet. */
export async function meshed<P extends ExactPart>(call: Call, p: P): Promise<P> {
  if (!p.unmeshed || p.body === undefined) return p
  const { unmeshed: _keys, ...rest } = p
  return { ...rest, ...tessellated((await call('brep.tessellate', { body: p.body })) as Tessellated) } as P
}

function tessellated(t: Tessellated): Pick<ExactPart, 'positions' | 'indices' | 'faces'> {
  const table = t.faces.map((f) => f.surface)
  const keys = t.faces.map((f) => f.key)
  // a triangle the kernel could not place on a face gets a face of its own kind, with no key
  let none = -1
  const ids = t.faceIds.map((id) => {
    if (id >= 0) return id
    if (none < 0) {
      none = table.length
      table.push({ kind: 'other' })
      keys.push(0)
    }
    return none
  })
  return { positions: t.positions, indices: t.indices, faces: { ids, table, ...(keys.some((k) => k) ? { keys } : {}) } }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** The step's transform as a frame when it only turns and moves (the kernel's ops are rigid), else null. */
export function rigidFrame(m: Mat4): { origin: Vec3; u: Vec3; normal: Vec3 } | null {
  const x: Vec3 = [m[0]!, m[1]!, m[2]!]
  const y: Vec3 = [m[4]!, m[5]!, m[6]!]
  const z: Vec3 = [m[8]!, m[9]!, m[10]!]
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  if (!(near(dot(x, x), 1) && near(dot(y, y), 1) && near(dot(z, z), 1) && near(dot(x, y), 0) && near(dot(y, z), 0) && near(dot(x, z), 0))) return null
  if (dot(cross(x, y), z) < 0) return null
  return { origin: [m[12]!, m[13]!, m[14]!], u: x, normal: z }
}

/** A new body's outline as the kernel's loops, in the frame, or null for one only the mesh path draws. */
function loops(shape: Shape, placement: { center?: Vec2; rotationDeg?: number }, flipV: boolean): { outer: unknown; holes: unknown[] }[] | null {
  const [cx, cy] = placement.center ?? [0, 0]
  const a = ((placement.rotationDeg ?? 0) * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  // as the engine places a shape (sx-geom face.rs): turned about its center, then moved
  const at = (x: number, y: number): Vec2 => {
    const p: Vec2 = [cx + c * x - s * y, cy + s * x + c * y]
    return flipV ? [p[0], -p[1]] : p
  }
  if (shape.type === 'circle') {
    const [x, y] = at(0, 0)
    return [{ outer: { center: [x, y], diameterMm: shape.diameterMm }, holes: [] }]
  }
  let ring: Vec2[]
  if (shape.type === 'rectangle' && !shape.cornerRadiusMm) {
    const w = shape.widthMm / 2
    const h = shape.heightMm / 2
    ring = [at(-w, -h), at(w, -h), at(w, h), at(-w, h)]
  } else if (shape.type === 'polygon') {
    const n = shape.sides
    const apothem = shape.fit === 'circumscribed' ? shape.diameterMm / 2 : (shape.diameterMm / 2) * Math.cos(Math.PI / n)
    const r = apothem / Math.cos(Math.PI / n)
    const start = -Math.PI / 2 - Math.PI / n
    ring = Array.from({ length: n }, (_, i) => at(r * Math.cos(start + (2 * Math.PI * i) / n), r * Math.sin(start + (2 * Math.PI * i) / n)))
  } else {
    return null
  }
  // the kernel wants the outline counterclockwise in the frame
  if (flipV) ring.reverse()
  return [{ outer: { points: ring }, holes: [] }]
}

/** Where a new body runs along the frame's normal, as the engine reads the spec (sx-geom face.rs). */
function range(spec: Extract<StepParams, { op: 'shape.extrude' }>['spec']): [number, number] | null {
  if (spec.taperDeg) return null
  const d = spec.distanceMm
  const sign = (spec.flip ? -1 : 1) * (d < 0 ? -1 : 1)
  const m = Math.abs(d)
  const extent = spec.extent ?? 'oneSide'
  const [a, b] = extent === 'symmetric' ? [-m, m] : extent === 'twoSides' ? [-sign * (spec.distance2Mm ?? 0), sign * m] : [0, sign * m]
  return a < b ? [a, b] : [b, a]
}

/** A frame given in world at the step's transform, in the part's own coordinates. */
function localFrame(s: Step, f: FaceFrame): { origin: Vec3; u: Vec3; normal: Vec3 } {
  const inv = invert(s.transform)
  return { origin: point(inv, f.origin), u: direction(inv, f.u), normal: direction(inv, f.normal) }
}

/**
 * The parts after step `s` on exact solids, or null when the mesh path should run it. Kernel failures come back as
 * null too, with `fellBack` told; an answer that is the step's real result (a plane that misses) throws ExactBroken.
 */
export async function exactStep(call: Call, s: Step, parts: ExactPart[], fellBack: () => void, solids: Solids = { keep: false, made: () => {} }): Promise<ExactPart[] | null> {
  const p = s.params
  const target = parts[s.part]
  const frame = rigidFrame(s.transform)
  if (!frame) return null
  const solid = (b: ExactPart | undefined) => (b?.body !== undefined ? b.body : b?.smb ? { smb: b.smb } : null)
  // kept bodies come back by number with their faces' keys, text ones as text
  const kept = solids.keep ? { withKeys: true } : { save: true }
  const reply = (r: unknown, k = 'body') => {
    const v = (r as Record<string, unknown>)[solids.keep ? k : `${k}Smb`]
    if (solids.keep ? typeof v !== 'number' : typeof v !== 'string') throw new Error(`brep: no ${k} in the reply`)
    if (typeof v === 'number') solids.made(v)
    return v as number | string
  }
  const part = async (like: Pick<ExactPart, 'name' | 'slot'>, r: unknown, k = 'body'): Promise<ExactPart> => {
    const v = reply(r, k)
    if (typeof v === 'string') return fromSolid(call, like, v)
    const keys = (r as Record<string, unknown>)[`${k}Keys`]
    return { name: like.name, slot: like.slot, positions: [], indices: [], body: v, unmeshed: Array.isArray(keys) ? (keys as number[]) : [] }
  }
  try {
    const out = parts.slice()
    switch (p.op) {
      case 'shape.extrude': {
        if ((p.spec.operation ?? 'new') !== 'new' || !p.frame || p.pattern || !('type' in p.shape)) return null
        const f = localFrame(s, p.frame)
        // the kernel's frame has v = normal x u; the step's may be the other way round
        const flipV = dot(cross(f.normal, f.u), direction(invert(s.transform), p.frame.v)) < 0
        const polygons = loops(p.shape as Shape, p.placement ?? {}, flipV)
        const z = range(p.spec)
        if (!polygons || !z) return null
        const r = await call('brep.extrude', { frame: f, polygons, fromMm: z[0], toMm: z[1], ...kept })
        const body = await part({ name: p.name ?? 'Body', slot: out[s.part]?.slot ?? 1 }, r)
        if (s.part < out.length) out[s.part] = body
        else out.push(body)
        return out
      }
      case 'subtract': {
        const b = solid(target)
        if (b === null || !target) return null
        const r = await call('brep.subtract', { body: b, solids: p.solids, frame, ...kept })
        out[s.part] = await part(target, r)
        return out
      }
      case 'boolean': {
        const others = p.with.map((i) => parts[i])
        const all = [target, ...others]
        if (!others.length || p.with.includes(s.part) || all.some((x) => solid(x) === null)) return null
        // the engine intersects the part with all the others joined, which pairwise steps would not give
        if (p.kind === 'intersection' && others.length > 1) return null
        // pairwise, in the parts' own coordinates (one object, one transform)
        let acc: unknown = solid(target)
        let r: unknown = null
        for (const o of others) {
          r = await call('brep.boolean', { op: p.kind, a: acc, b: solid(o), ...kept })
          const v = reply(r)
          acc = typeof v === 'number' ? v : { smb: v }
        }
        out[s.part] = typeof acc === 'number' ? await part(target!, r) : await fromSolid(call, target!, (acc as { smb: string }).smb)
        return out.filter((_, i) => !p.with.includes(i))
      }
      case 'edge.fillet':
      case 'edge.chamfer': {
        const b = solid(target)
        if (b === null || !target) return null
        // the edges in the part's own coordinates; the kernel finds each by its faces' keys, then by place
        const inv = invert(s.transform)
        const edges = p.edges.map((e) => ({ a: point(inv, e.a), b: point(inv, e.b), ...(e.center ? { center: point(inv, e.center) } : {}), ...(e.keys ? { keys: e.keys } : {}) }))
        const size = p.op === 'edge.fillet' ? { radiusMm: p.radiusMm } : { distanceMm: p.distanceMm, ...(p.distance2Mm !== undefined ? { distance2Mm: p.distance2Mm } : {}) }
        const r = await call(p.op === 'edge.fillet' ? 'brep.fillet' : 'brep.chamfer', { body: b, edges, ...size, ...kept })
        out[s.part] = await part(target, r)
        return out
      }
      case 'plane.cut': {
        const b = solid(target)
        if (b === null || !target) return null
        const inv = invert(s.transform)
        const n = direction(inv, p.plane.normal)
        const l = Math.hypot(...n) || 1
        const plane = { point: point(inv, p.plane.point), normal: [n[0] / l, n[1] / l, n[2] / l] }
        const r = (await call('brep.cut', { body: b, plane, ...kept })) as Record<string, unknown>
        // both sides are made, kept or not; a side the plane misses comes back null
        for (const k of ['below', 'above']) if (solids.keep && typeof r[k] === 'number') solids.made(r[k] as number)
        if (r['below'] === null || r['above'] === null) throw new ExactBroken('The plane no longer crosses the part.')
        const below = () => part(target, r, 'below')
        const above = async () => ({ ...(await part(target, r, 'above')), name: `${target.name} top` })
        if (p.keep === 'below') out[s.part] = await below()
        else if (p.keep === 'above') out[s.part] = { ...(await above()), name: target.name }
        else out.splice(s.part, 1, await below(), await above())
        return out
      }
      default:
        return null
    }
  } catch (e) {
    if (e instanceof ExactBroken || (e as { name?: string }).name === 'AbortError') throw e
    fellBack()
    return null
  }
}
