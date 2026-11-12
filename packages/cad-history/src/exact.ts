// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps on exact solids (packages/brep, the brep.* ops) in a replay that asks for them (ReplayRequest.exact, behind a
// developer flag for now). A solid is a cache of the replay itself: a new body step makes one, the kernel's steps
// carry it, and a solid from anywhere else is never read. A step the kernel has no version of, or whose part has no
// solid, returns null and the mesh path runs it; so does a step the kernel fails, with a note. The mesh each step
// leaves is the solid's tessellation, with the solid's faces and keys.
import type { FaceFrame, FreeShape, MovedFace, Polygon, Shape, Vec2, Vec3 } from './types'
import { placeBody } from './numbering'
import { direction, findTriangle, IDENTITY, invert, multiply, newSlot, point, type HistoryMesh, type Mat4, type PaintLayer, type PaintTexts, type PrimitiveSpec, type SolidSpec, type Step, type StepParams } from './model'

export type Call = (op: string, request: unknown) => Promise<unknown>

/** What a push on exact solids tells the replay: the face it moved (world), the key it found the face by, and
 * whether a face is left where it moved to. */
export type Pushed = (moved: MovedFace, faceKey: number, reached: boolean) => void

/** A part as replay carries it. */
export interface ExactPart {
  name: string
  slot: number
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  faces?: NonNullable<HistoryMesh['faces']>
  /** The solid's own corner normals for these triangles (HistoryMesh.normals), from its tessellation. */
  normals?: Int16Array
  paint?: PaintTexts
  smb?: string
  /** The solid as a body number in the kernel, when the replay's engine keeps bodies between calls (the worker). */
  body?: number
  /** With `body`, before the part is tessellated: its faces' keys. Its mesh is empty until a step or the result
   * needs it (meshed). */
  unmeshed?: number[]
  /** The shape Add shape made the part as (HistoryMesh.primitive). */
  primitive?: PrimitiveSpec
  /** The part's paint by face, while it is an exact solid (FacePaint): its triangles' paint is made again from it. */
  facePaint?: FacePaint
}

/**
 * Paint on an exact part, kept by face: per layer, each face painted whole and its text. A face goes by its key; one
 * whose key is 0 (a face a cut split or a join merged) goes by its place, a point on it and the way it faces, as picks
 * do. Every tessellation makes the part's triangles again, so their paint is made again from this (paintOfFaces).
 */
export type FacePaint = Partial<Record<PaintLayer, { key: number; at?: Vec3; normal?: Vec3; text: string }[]>>

/**
 * The part's paint by face, or null when some paint covers part of a face only (brushed), which has no form by face.
 * Null too for paint on a part with no faces.
 */
export function facePaintOf(m: Pick<ExactPart, 'positions' | 'indices' | 'faces' | 'paint'>): FacePaint | null {
  const f = m.faces
  if (!m.paint) return {}
  if (!f) return null
  const triangles = Math.floor(m.indices.length / 3)
  const out: FacePaint = {}
  for (const [layer, texts] of Object.entries(m.paint) as [PaintLayer, Record<number, string>][]) {
    // each face's triangles and the one text they all have, or null when they differ or some are bare
    const byFace = new Map<number, { text: string | null; first: number }>()
    for (let t = 0; t < triangles; t++) {
      const id = f.ids[t]!
      const text = texts[t] ?? ''
      const was = byFace.get(id)
      if (!was) byFace.set(id, { text, first: t })
      else if (was.text !== text) was.text = null
    }
    const list: NonNullable<FacePaint[PaintLayer]> = []
    for (const [id, { text, first }] of byFace) {
      if (text === null) return null
      if (!text) continue
      const key = f.keys?.[id] ?? 0
      if (key) list.push({ key, text })
      else {
        const [a, b, c] = [0, 1, 2].map((j) => point(IDENTITY, m.positions, 3 * m.indices[3 * first + j]!))
        const n = cross([b![0] - a![0], b![1] - a![1], b![2] - a![2]], [c![0] - a![0], c![1] - a![1], c![2] - a![2]])
        const l = Math.hypot(...n) || 1
        list.push({ key: 0, at: [(a![0] + b![0] + c![0]) / 3, (a![1] + b![1] + c![1]) / 3, (a![2] + b![2] + c![2]) / 3], normal: [n[0] / l, n[1] / l, n[2] / l], text })
      }
    }
    if (list.length) out[layer] = list
  }
  return out
}

/** The triangles' paint from the part's paint by face: every triangle of a face painted whole gets its text. */
export function paintOfFaces(m: Pick<ExactPart, 'positions' | 'indices' | 'faces'>, fp: FacePaint): PaintTexts {
  const f = m.faces
  const out: PaintTexts = {}
  if (!f) return out
  const triangles = Math.floor(m.indices.length / 3)
  for (const [layer, list] of Object.entries(fp) as [PaintLayer, NonNullable<FacePaint[PaintLayer]>][]) {
    const texts: Record<number, string> = {}
    for (const e of list) {
      // a face with a key wherever it is now; one without, the face under its point
      const at = e.key ? -1 : findTriangle(m, IDENTITY, e.at!, e.normal!)
      const face = at >= 0 ? f.ids[at] : undefined
      for (let t = 0; t < triangles; t++) if (e.key ? f.keys?.[f.ids[t]!] === e.key : f.ids[t] === face) texts[t] = e.text
    }
    if (Object.keys(texts).length) out[layer] = texts
  }
  return out
}


/** How a replay holds its solids: as text through each call, or (`keep`) as kernel bodies, each one `made` told. */
export interface Solids {
  keep: boolean
  /** New-body lofts are asked exact even on a replay that is not (ReplayRequest.exactLofts). */
  lofts?: boolean
  made: (body: number) => void
  /** Whether the engine makes an exact body for this operation itself (exactOps); asked once a replay. */
  has?: (op: string) => Promise<boolean>
}

/** The engine operation that lists the operations it has an exact path for. */
export const EXACT_OPS = 'exact.ops'

/**
 * The operations the engine makes exact bodies for, as it answers EXACT_OPS (`{ ops: [...] }`). An engine without
 * the kernel lists none, and one that does not know the question has none either.
 */
export async function exactOps(call: Call): Promise<Set<string>> {
  try {
    const r = (await call(EXACT_OPS, {})) as { ops?: unknown } | null
    return new Set(Array.isArray(r?.ops) ? r.ops.filter((o): o is string => typeof o === 'string') : [])
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e
    return new Set()
  }
}

/** The largest solid text kept with a part; a bigger one is dropped and the part goes on on the mesh, and the step says so. */
export const MAX_SOLID_TEXT = 8 * 1024 * 1024

/** `chars` and the limit in millions, to one place, or to as many more as it takes for the two to read apart. */
function inMillions(chars: number): [string, string] {
  const m = (n: number, places: number) => (n / 1e6).toFixed(places).replace(/\.?0+$/, '')
  let places = 1
  while (places < 6 && m(chars, places) === m(MAX_SOLID_TEXT, places)) places++
  return [m(chars, places), m(MAX_SOLID_TEXT, places)]
}

/**
 * What a step says when the part's exact solid grew past MAX_SOLID_TEXT: from this step on the part is built as a mesh,
 * or, in a design that must stay exact (`strict`), the step cannot stay exact.
 */
export function solidTooBig(chars: number, strict: boolean): string {
  const [now, limit] = inMillions(chars)
  const size = `size ${now} million, limit ${limit} million`
  return strict
    ? `this step would make the part too detailed to stay an exact solid (${size}).`
    : `This part is now too detailed to stay an exact solid, so from this step on it is built as a mesh. (Size ${now} million, limit ${limit} million.)`
}

/** The note on a step the kernel could not do, which then ran on the mesh. */
export const EXACT_FELL_BACK = 'The exact solid could not do this step, so it ran on the mesh.'

/** The note on a step with no exact path that an exact part goes through, once: the part is a mesh from then on. */
export const EXACT_MESH_FROM_HERE = 'This step works on the mesh, so this part is no longer an exact solid from here on.'

/** Thrown for an answer that is the step's real outcome, not a kernel failure (no fallback). */
export class ExactBroken extends Error {}

/** A join or cut that did not reach the part: a pattern leaves that copy out, as the mesh path does. */
export class ExactMissed extends ExactBroken {}

/**
 * The engine's answer to brep.tessellate, in either form it comes in. The numbers are lists or typed arrays. `faces`
 * is one entry per face, or the face table with its keys beside it; `faceIds` names each triangle's face. `normals`
 * are packed corner normals, six per triangle, when the engine reads them off the solid. Anything else in the answer
 * is left alone.
 */
export interface Tessellated {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  faceIds?: ArrayLike<number>
  faces?: { surface: unknown; key?: number }[] | { table: unknown[]; keys?: number[] }
  normals?: ArrayLike<number>
}

/** A part from a solid: its tessellation with faces and keys, and the solid's text unless it is too big to keep. */
export async function fromSolid(call: Call, like: Pick<ExactPart, 'name' | 'slot'>, smb: string, tooBig?: (chars: number) => void): Promise<ExactPart> {
  if (smb.length > MAX_SOLID_TEXT) tooBig?.(smb.length)
  const t = (await call('brep.tessellate', { body: { smb } })) as Tessellated
  return { name: like.name, slot: like.slot, ...tessellated(t), ...(smb.length <= MAX_SOLID_TEXT ? { smb } : {}) }
}

/** The part with its body tessellated, when it has not been yet. */
export async function meshed<P extends ExactPart>(call: Call, p: P): Promise<P> {
  if (!p.unmeshed || p.body === undefined) return p
  // normals come from this tessellation or not at all
  const { unmeshed: _keys, normals: _old, paint: _paint, ...rest } = p
  const mesh = tessellated((await call('brep.tessellate', { body: p.body })) as Tessellated)
  // paint kept by face goes on the new triangles
  const paint = p.facePaint ? paintOfFaces(mesh, p.facePaint) : undefined
  return { ...rest, ...mesh, ...(paint && Object.keys(paint).length ? { paint } : {}) } as P
}

/** The part fields a tessellation gives, from either form of the answer. */
export function tessellated(t: Tessellated): Pick<ExactPart, 'positions' | 'indices' | 'faces' | 'normals'> {
  const triangles = Math.floor(t.indices.length / 3)
  // packed normals count only when every triangle corner has its pair
  const normals = t.normals && t.normals.length === triangles * 6 ? (t.normals instanceof Int16Array ? t.normals : Int16Array.from(t.normals)) : undefined
  const mesh = { positions: t.positions, indices: t.indices, ...(normals ? { normals } : {}) }
  const given = t.faces
  const from = t.faceIds
  if (!given || !from || from.length !== triangles) return mesh
  const table = Array.isArray(given) ? given.map((f) => f.surface) : [...given.table]
  const keys = Array.isArray(given) ? given.map((f) => f.key ?? 0) : table.map((_, i) => given.keys?.[i] ?? 0)
  const known = table.length
  const placed = (id: number) => Number.isInteger(id) && id >= 0 && id < known
  let ids = from
  for (let i = 0; i < from.length; i++) {
    if (placed(from[i]!)) continue
    // a triangle the kernel could not place on a face gets a face of its own kind, with no key
    table.push({ kind: 'other' })
    keys.push(0)
    ids = Array.from(from, (id) => (placed(id) ? id : known))
    break
  }
  return { ...mesh, faces: { ids, table, ...(keys.some((k) => k) ? { keys } : {}) } }
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

/** A piece of a kernel loop: a line to `to`, or an arc to it around `center` (sweep counterclockwise positive). */
type Piece = { to: Vec2; center?: Vec2; sweepDeg?: number }
type Ellipse = { center: Vec2; widthMm: number; heightMm: number; angleDeg: number }
type Loop = { points: Vec2[] } | { center: Vec2; diameterMm: number } | Ellipse | { start: Vec2; segments: Piece[] }
type Profile = { outer: Loop; holes: Loop[] }

/** The same loop the other way round, each arc swept back. */
function reversed(start: Vec2, segments: Piece[]): Piece[] {
  const ends = [start, ...segments.map((g) => g.to)]
  return segments.map((_, k) => {
    const i = segments.length - 1 - k
    const g = segments[i]!
    return { to: ends[i]!, ...(g.center ? { center: g.center, sweepDeg: -g.sweepDeg! } : {}) }
  })
}

/** A kernel loop as a ring of points, each arc in pieces of at most 5 degrees. */
function ring(l: Loop): Vec2[] {
  if ('points' in l) return l.points
  if ('widthMm' in l) {
    const [a, b, t] = [l.widthMm / 2, l.heightMm / 2, (l.angleDeg * Math.PI) / 180]
    return Array.from({ length: 72 }, (_, i): Vec2 => {
      const [x, y] = [a * Math.cos((i * Math.PI) / 36), b * Math.sin((i * Math.PI) / 36)]
      return [l.center[0] + x * Math.cos(t) - y * Math.sin(t), l.center[1] + x * Math.sin(t) + y * Math.cos(t)]
    })
  }
  if ('center' in l) {
    const r = l.diameterMm / 2
    return Array.from({ length: 72 }, (_, i): Vec2 => [l.center[0] + r * Math.cos((i * Math.PI) / 36), l.center[1] + r * Math.sin((i * Math.PI) / 36)])
  }
  const out: Vec2[] = []
  let from = l.start
  for (const g of l.segments) {
    out.push(from)
    if (g.center) {
      const [cx, cy] = g.center
      const a0 = Math.atan2(from[1] - cy, from[0] - cx)
      const r = Math.hypot(from[0] - cx, from[1] - cy)
      const n = Math.max(1, Math.ceil(Math.abs(g.sweepDeg!) / 5))
      for (let k = 1; k < n; k++) {
        const a = a0 + (((g.sweepDeg! * k) / n) * Math.PI) / 180
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      }
    }
    from = g.to
  }
  return out
}

/** A slot or a rounded rectangle as lines and arcs, counterclockwise, centered on the origin. */
function rounded(shape: Shape): Loop | null {
  if (shape.type === 'slot') {
    const r = shape.widthMm / 2
    const x = shape.lengthMm / 2 - r
    if (!(r > 0) || x < 0) return null
    return { start: [-x, -r], segments: [{ to: [x, -r] }, { to: [x, r], center: [x, 0], sweepDeg: 180 }, { to: [-x, r] }, { to: [-x, -r], center: [-x, 0], sweepDeg: 180 }] }
  }
  if (shape.type !== 'rectangle' || !shape.cornerRadiusMm) return null
  const w = shape.widthMm / 2
  const h = shape.heightMm / 2
  const r = shape.cornerRadiusMm
  if (!(w > 0 && h > 0 && r > 0 && r <= Math.min(w, h))) return null
  const [x, y] = [w - r, h - r]
  return {
    start: [w, -y],
    segments: [
      { to: [w, y] },
      { to: [x, h], center: [x, y], sweepDeg: 90 },
      { to: [-x, h] },
      { to: [-w, y], center: [-x, y], sweepDeg: 90 },
      { to: [-w, -y] },
      { to: [-x, -h], center: [-x, -y], sweepDeg: 90 },
      { to: [x, -h] },
      { to: [w, -y], center: [x, -y], sweepDeg: 90 },
    ],
  }
}

/**
 * A new body's outline as the kernel's loops, in the frame, or null for one only the mesh path draws. A sketch's
 * loops come from the engine (sketch.curves), nested and exact; one it finds a problem in goes to the mesh path,
 * which says what the problem is.
 */
async function loops(call: Call, shape: Shape | FreeShape, placement: { center?: Vec2; rotationDeg?: number }, flipV: boolean): Promise<Profile[] | null> {
  const [cx, cy] = placement.center ?? [0, 0]
  const a = ((placement.rotationDeg ?? 0) * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  // as the engine places a shape (sx-geom face.rs): turned about its center, then moved
  const at = (p: Vec2): Vec2 => {
    const q: Vec2 = [cx + c * p[0] - s * p[1], cy + s * p[0] + c * p[1]]
    return flipV ? [q[0], -q[1]] : q
  }
  // placed in the frame and kept counterclockwise there, as the kernel wants
  const placed = (l: Loop): Loop => {
    if ('points' in l) {
      const ring = l.points.map(at)
      return { points: flipV ? ring.reverse() : ring }
    }
    if ('start' in l) {
      const start = at(l.start)
      const segments = l.segments.map((g) => ({ to: at(g.to), ...(g.center ? { center: at(g.center), sweepDeg: flipV ? -g.sweepDeg! : g.sweepDeg! } : {}) }))
      return { start, segments: flipV ? reversed(start, segments) : segments }
    }
    // turned with the placement, and mirrored with the frame
    if ('widthMm' in l) return { center: at(l.center), widthMm: l.widthMm, heightMm: l.heightMm, angleDeg: (flipV ? -1 : 1) * (l.angleDeg + (placement.rotationDeg ?? 0)) }
    return { center: at(l.center), diameterMm: l.diameterMm }
  }
  let profiles: Profile[]
  if (shape.type === 'sketch') {
    try {
      profiles = (await call('sketch.curves', { loops: shape.loops })) as Profile[]
    } catch {
      return null
    }
  } else if (shape.type === 'circle') {
    profiles = [{ outer: { center: [0, 0], diameterMm: shape.diameterMm }, holes: [] }]
  } else if (shape.type === 'ellipse') {
    profiles = [{ outer: { center: [0, 0], widthMm: shape.widthMm, heightMm: shape.heightMm, angleDeg: 0 }, holes: [] }]
  } else if (shape.type === 'rectangle' && !shape.cornerRadiusMm) {
    const w = shape.widthMm / 2
    const h = shape.heightMm / 2
    profiles = [{ outer: { points: [[-w, -h], [w, -h], [w, h], [-w, h]] }, holes: [] }]
  } else if (shape.type === 'polygon') {
    const n = shape.sides
    const apothem = shape.fit === 'circumscribed' ? shape.diameterMm / 2 : (shape.diameterMm / 2) * Math.cos(Math.PI / n)
    const r = apothem / Math.cos(Math.PI / n)
    const start = -Math.PI / 2 - Math.PI / n
    profiles = [{ outer: { points: Array.from({ length: n }, (_, i): Vec2 => [r * Math.cos(start + (2 * Math.PI * i) / n), r * Math.sin(start + (2 * Math.PI * i) / n)]) }, holes: [] }]
  } else {
    const l = rounded(shape as Shape)
    if (!l) return null
    profiles = [{ outer: l, holes: [] }]
  }
  return profiles.map((p) => ({ outer: placed(p.outer), holes: p.holes.map(placed) }))
}

/** Where a new body runs along the frame's normal, as the engine reads the spec (sx-geom face.rs). */
function range(spec: Extract<StepParams, { op: 'shape.extrude' }>['spec']): [number, number] | null {
  const d = spec.distanceMm
  // a cut goes into the face, as in sx-geom face.rs
  const sign = (spec.operation === 'cut' ? -1 : 1) * (spec.flip ? -1 : 1) * (d < 0 ? -1 : 1)
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
 * Whether a part's triangles are still the shape Add shape made: a closed mesh whose every vertex sits on the shape
 * (a box's corners, a cylinder's or cone's rims and axis ends, a sphere's surface) and that reaches its full size.
 * A part that was edited, scaled or turned since stays on the mesh. Within a millionth of the part's size, as an f32
 * position is stored, plus a hundred thousandth of the size.
 */
export function fits(spec: PrimitiveSpec, positions: ArrayLike<number>, indices: ArrayLike<number>): boolean {
  const { origin: o, u, normal: n } = spec.frame
  const v = cross(n, u)
  const size = spec.type === 'box' ? Math.max(...spec.sizeMm) : spec.type === 'sphere' ? spec.diameterMm : Math.max(spec.diameterMm, spec.heightMm)
  const far = Math.max(...o.map(Math.abs)) + size
  const tol = 1e-5 * size + 1e-6 * far
  const near = (a: number, b: number) => Math.abs(a - b) <= tol
  if (positions.length < 12 || indices.length < 12) return false
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d: Vec3 = [positions[i]! - o[0], positions[i + 1]! - o[1], positions[i + 2]! - o[2]]
    const q = [dot(d, u), dot(d, v), dot(d, n)]
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, q[k]!)
      hi[k] = Math.max(hi[k]!, q[k]!)
    }
    const [x, y, z] = q as [number, number, number]
    const rho = Math.hypot(x, y)
    if (spec.type === 'box') {
      const [w, dp, h] = spec.sizeMm
      if (!(near(Math.abs(x), w / 2) && near(Math.abs(y), dp / 2) && (near(z, 0) || near(z, h)))) return false
    } else if (spec.type === 'sphere') {
      const r = spec.diameterMm / 2
      if (!near(Math.hypot(x, y, z - r), r)) return false
    } else {
      const h = spec.heightMm
      const top = spec.type === 'cone' ? spec.topDiameterMm / 2 : spec.diameterMm / 2
      const rim = near(z, 0) ? spec.diameterMm / 2 : near(z, h) ? top : NaN
      if (!(near(rho, rim) || (near(rho, 0) && (near(z, 0) || near(z, h))))) return false
    }
  }
  const [ex, ey, ez] = spec.type === 'box' ? [spec.sizeMm[0] / 2, spec.sizeMm[1] / 2, spec.sizeMm[2]] : spec.type === 'sphere' ? [spec.diameterMm / 2, spec.diameterMm / 2, spec.diameterMm] : [spec.diameterMm / 2, spec.diameterMm / 2, spec.heightMm]
  if (!(near(lo[2]!, 0) && near(hi[2]!, ez) && near(hi[0]!, ex) && near(-lo[0]!, ex) && near(hi[1]!, ey) && near(-lo[1]!, ey))) {
    // a round rim's sides need not have a vertex on every axis; its height and widest point must still be there
    if (spec.type === 'box' || !(near(lo[2]!, 0) && near(hi[2]!, ez))) return false
  }
  // closed: each edge used an even number of times, corners welded to 1 um so split vertices count once
  const weld = new Map<string, number>()
  const id: number[] = []
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const key = `${Math.round(positions[i]! * 1000)},${Math.round(positions[i + 1]! * 1000)},${Math.round(positions[i + 2]! * 1000)}`
    if (!weld.has(key)) weld.set(key, weld.size)
    id.push(weld.get(key)!)
  }
  const edges = new Map<number, number>()
  const nv = weld.size
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = id[indices[t + k]!]!
      const b = id[indices[t + ((k + 1) % 3)]!]!
      if (a === b) continue
      const key = Math.min(a, b) * nv + Math.max(a, b)
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  for (const c of edges.values()) if (c % 2 !== 0) return false
  return true
}

/** A kernel loop moved by (dx, dy) in its frame. */
function shiftLoop(l: Loop, dx: number, dy: number): Loop {
  const at = (q: Vec2): Vec2 => [q[0] + dx, q[1] + dy]
  if ('points' in l) return { points: l.points.map(at) }
  if ('start' in l) return { start: at(l.start), segments: l.segments.map((g) => ({ ...g, to: at(g.to), ...(g.center ? { center: at(g.center) } : {}) })) }
  return { ...l, center: at(l.center) }
}

/**
 * The copies (from 0) whose every tool the kernel names in its reply's `missed` (indices of the outlines or cutters,
 * in request order, each copy `per` of them in a row), or null when the reply has no `missed` list.
 */
function missedCopies(r: unknown, per: number, count: number): number[] | null {
  const m = (r as { missed?: unknown }).missed
  if (!Array.isArray(m) || !m.every((k) => Number.isInteger(k))) return null
  const gone = new Set(m as number[])
  return Array.from({ length: count }, (_, j) => j).filter((j) => Array.from({ length: per }, (_, t) => j * per + t).every((k) => gone.has(k)))
}

/** How close a pattern's copy move must come to a plain shift (no turn) to be laid in one exact call, unitless. */
const SHIFT_ONLY = 1e-9

/** The shift of a move with no turn in it, or null when it turns or mirrors. */
function shiftOf(m: Mat4): Vec3 | null {
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const r = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!]
  return r.every((v, i) => Math.abs(v - id[i]!) < SHIFT_ONLY) ? [m[12]!, m[13]!, m[14]!] : null
}

/** A cutter solid given in world at a step's transform `t`, moved by `m` in the part's own coordinates, or null for a box a turn would tip. */
function movedSolid(x: SolidSpec, t: Mat4, m: Mat4): SolidSpec | null {
  const w = multiply(t, multiply(m, invert(t)))
  if (x.type === 'cylinder') return { ...x, origin: point(w, x.origin), axis: direction(w, x.axis) }
  const d = shiftOf(w)
  if (!d) return null
  return { type: 'box', min: [x.min[0] + d[0], x.min[1] + d[1], x.min[2] + d[2]], max: [x.max[0] + d[0], x.max[1] + d[1], x.max[2] + d[2]] }
}

/**
 * The parts an add makes, as the kernel's solids of the shapes they were made as, or null when a part has none the
 * kernel starts from (a mesh, a sphere, or a shape the part no longer fits). Each added part is its own solid.
 */
export async function addedSolids(call: Call, added: readonly HistoryMesh[], solids: Solids = { keep: false, made: () => {} }): Promise<ExactPart[] | null> {
  if (!added.length || !added.every((x) => x.primitive && x.primitive.type !== 'sphere' && fits(x.primitive, x.positions, x.indices))) return null
  const out: ExactPart[] = []
  for (const x of added) {
    const r = (await call('brep.primitive', { ...x.primitive!, ...(solids.keep ? { withKeys: true } : { save: true }) })) as Record<string, unknown>
    if (solids.keep) {
      if (typeof r['body'] !== 'number') throw new Error('brep: no body in the reply')
      solids.made(r['body'])
      out.push({ name: x.name, slot: x.slot, positions: [], indices: [], body: r['body'], unmeshed: Array.isArray(r['bodyKeys']) ? (r['bodyKeys'] as number[]) : [] })
    } else {
      if (typeof r['bodySmb'] !== 'string') throw new Error('brep: no bodySmb in the reply')
      out.push(await fromSolid(call, x, r['bodySmb']))
    }
  }
  return out
}

/** The steps exactStep has a version of on exact solids. */
const EXACT_STEPS: ReadonlySet<StepParams['op']> = new Set(['face.push', 'hole.apply', 'shape.extrude', 'subtract', 'boolean', 'edge.fillet', 'edge.chamfer', 'plane.cut'])

/**
 * The parts after step `s` on exact solids, or null when the mesh path should run it. Kernel failures come back as
 * null too, with `fellBack` told; an answer that is the step's real result (a plane that misses) throws ExactBroken.
 * With `copies` (a pattern's moves, in the part's own coordinates) the step's cut or join is made once more at each
 * move instead of where it is, all in one kernel call: the extrude's outlines shifted in its plane, or the subtract's
 * cutters moved; null when a move would take the outline off its plane or tip a box, for the pattern to run copy by copy.
 * `missed` is told which copies (from 0, in `copies` order) left no face of their own in the result, from the kernel's
 * `missed` list of outlines or cutters, or null when the kernel's reply does not say (an engine from before it did).
 */
export async function exactStep(call: Call, s: Step, given: ExactPart[], fellBack: (error?: unknown) => void, solids: Solids = { keep: false, made: () => {} }, pushed: Pushed = () => {}, copies?: readonly Mat4[], tooBig?: (chars: number) => void, missed?: (copies: number[] | null) => void): Promise<ExactPart[] | null> {
  const p = s.params
  let parts = given
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
    if (typeof v === 'string') return fromSolid(call, like, v, tooBig)
    const keys = (r as Record<string, unknown>)[`${k}Keys`]
    return { name: like.name, slot: like.slot, positions: [], indices: [], body: v, unmeshed: Array.isArray(keys) ? (keys as number[]) : [] }
  }
  // a step with no exact version runs on the mesh, before any part is made a solid for it
  if (!EXACT_STEPS.has(p.op)) return null
  if (copies && !(copies.length && (p.op === 'subtract' || (p.op === 'shape.extrude' && (p.spec.operation ?? 'new') !== 'new')))) return null
  try {
    // the parts the step works on that Add shape made, and still fit the shape, start as the kernel's solid of it;
    // not a sphere yet, whose triangles at the mesh's resolution take the kernel over 20 ms
    const used = new Set([s.part, ...(p.op === 'boolean' ? p.with : [])])
    parts = await Promise.all(parts.map(async (x, i) => (used.has(i) && x.primitive && x.primitive.type !== 'sphere' && solid(x) === null && fits(x.primitive, x.positions, x.indices) ? part(x, await call('brep.primitive', { ...x.primitive, ...kept })) : x)))
    const target = parts[s.part]
    const out = parts.slice()
    switch (p.op) {
      case 'face.push': {
        const b = solid(target)
        if (b === null || !target) return null
        // the face in the part's own coordinates; a missing or ambiguous key requires repair
        const inv = invert(s.transform)
        const n = direction(inv, p.normal)
        const l = Math.hypot(...n) || 1
        const r = (await call('brep.push', { body: b, at: point(inv, p.at), normal: [n[0] / l, n[1] / l, n[2] / l], distanceMm: p.distanceMm, ...(p.faceKey ? { faceKey: p.faceKey } : {}), ...kept })) as { frame: FaceFrame; polygons: Profile[]; faceKey: number; reached: boolean }
        out[s.part] = await part(target, r)
        // the face it moved, in world at the step's transform, its outline in the face's frame
        const f = r.frame
        const normal = direction(s.transform, f.normal)
        const u = direction(s.transform, f.u)
        const outline: Polygon[] = r.polygons.map((q) => ({ outer: ring(q.outer), holes: q.holes.map(ring) }))
        pushed({ frame: { origin: point(s.transform, f.origin), normal, u, v: cross(normal, u) }, outline, distanceMm: p.distanceMm }, r.faceKey, r.reached)
        return out
      }
      case 'hole.apply': {
        const b = solid(target)
        if (b === null || !target) return null
        // the hole in the part's own coordinates; the kernel finds it again as the part is now
        const inv = invert(s.transform)
        const a = direction(inv, p.hole.axis)
        const l = Math.hypot(...a) || 1
        const hole = { ...p.hole, entry: point(inv, p.hole.entry), axis: [a[0] / l, a[1] / l, a[2] / l] }
        out[s.part] = await part(target, await call('brep.hole', { body: b, hole, spec: p.spec, ...kept }))
        return out
      }
      case 'shape.extrude': {
        const op = p.spec.operation ?? 'new'
        if (p.pattern || !('type' in p.shape)) return null
        const into = op === 'new' ? null : solid(target)
        if (op !== 'new' && (into === null || !target)) return null
        const sourceFrame: FaceFrame = p.frame ?? { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
        const f = localFrame(s, sourceFrame)
        // the kernel's frame has v = normal x u; the step's may be the other way round
        const flipV = dot(cross(f.normal, f.u), direction(invert(s.transform), sourceFrame.v)) < 0
        const own = await loops(call, p.shape, p.placement ?? {}, flipV)
        const z = range(p.spec)
        if (!own || !z) return null
        let polygons = own
        if (copies) {
          // each copy's outline is the step's own, shifted in the plane by the copy's move
          const v = cross(f.normal, f.u)
          const shifts: [number, number][] = []
          for (const m of copies) {
            const d = shiftOf(m)
            if (!d || Math.abs(dot(d, f.normal)) > 1e-6 * (1 + Math.hypot(...d))) return null
            shifts.push([dot(d, f.u), dot(d, v)])
          }
          polygons = shifts.flatMap(([dx, dy]) => own.map((q) => ({ outer: shiftLoop(q.outer, dx, dy), holes: q.holes.map((h) => shiftLoop(h, dx, dy)) })))
        }
        const r = await call('brep.extrude', { frame: f, polygons, fromMm: z[0], toMm: z[1], ...(p.spec.taperDeg ? { taperDeg: p.spec.taperDeg } : {}), ...(into === null ? {} : { target: into, operation: op }), ...kept })
        if (into !== null) {
          // a join or cut that misses changes nothing; the kernel makes no body then
          if (!(r as { touches?: boolean }).touches) throw new ExactMissed('The shape no longer reaches the part.')
          if (copies) missed?.(missedCopies(r, own.length, copies.length))
          out[s.part] = await part(target!, r)
          return out
        }
        const body = await part({ name: p.name ?? 'Body', slot: newSlot(p) ?? out[s.part]?.slot ?? 1 }, r)
        placeBody(out, s.part, body)
        return out
      }
      case 'subtract': {
        const b = solid(target)
        if (b === null || !target) return null
        let cutters: SolidSpec[] = p.solids
        if (copies) {
          const moved = copies.flatMap((m) => p.solids.map((x) => movedSolid(x, s.transform, m)))
          if (moved.some((x) => x === null)) return null
          cutters = moved as SolidSpec[]
        }
        const r = await call('brep.subtract', { body: b, solids: cutters, frame, ...kept })
        if (copies) missed?.(missedCopies(r, p.solids.length, copies.length))
        out[s.part] = await part(target, r)
        return out
      }
      case 'boolean': {
        const others = p.with.map((i) => parts[i])
        const all = [target, ...others]
        if (!others.length || p.with.includes(s.part) || all.some((x) => solid(x) === null)) return null
        // pairwise, in the parts' own coordinates (one object, one transform)
        let r: unknown = null
        const fold = async (op: string, first: unknown, rest: unknown[]) => {
          let acc = first
          for (const b of rest) {
            r = await call('brep.boolean', { op, a: acc, b, ...kept })
            if ((r as { body?: unknown }).body === null) throw new ExactBroken('Nothing is left of the part after this step.')
            const v = reply(r)
            acc = typeof v === 'number' ? v : { smb: v }
          }
          return acc
        }
        // as the mesh boolean does: an intersection keeps what every part shares
        const acc = await fold(p.kind, solid(target), others.map(solid))
        out[s.part] = typeof acc === 'number' ? await part(target!, r) : await fromSolid(call, target!, (acc as { smb: string }).smb, tooBig)
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
        const above = async () => ({ ...(await part(target, r, 'above')), name: p.name ?? `${target.name} top` })
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
    if (e instanceof Error && /^(?:brep: )?faceReference:/.test(e.message)) throw new ExactBroken(e.message)
    fellBack(e)
    return null
  }
}
