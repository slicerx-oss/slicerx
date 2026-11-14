// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replays an object's history on its base (docs/cad-history.md). Runs in the geometry worker
// (the app's geom-worker.ts, op history.replay) with the engine called directly, and in tests with any engine
// provider. Steps run in order; the first one that fails is marked broken with the engine's sentence,
// every later one is skipped, and the parts are the result just before it. The parts after each step
// are kept from the last replays, so an edit of step k starts at k.
import type { EdgeRef, FaceFrame, MovedFace, Vec3 } from './types'
import { withTilt } from './tilt'
import { IDENTITY, bakeMesh, direction, findByKey, findTriangle, followed, followsOf, hasFaceOn, invert, keyOfTriangle, multiply, newSlot, point, type History, type HistoryMesh, type LoftProfile, type Mat4, type PaintLayer, type PaintTexts, type PatternCopies, type PrimitiveSpec, type ReplayResult, type SkippedEdge, type Step, type StepParams, type StepStatus } from './model'
import { madeBy } from './provenance'
import { makesBody, placeBody, stepParts, turnedOff } from './numbering'
import { stepSalt } from './salt'
import { copiesLanded, repeatProblem, stepCopyMoves, stepPatternProblem } from './pattern'
import { anchorOf, surfaceMoves } from './surface-follow'
import { addedSolids, bandCrossings, bandFaceIds, bandOf, EXACT_FELL_BACK, EXACT_IMPRINT, EXACT_MESH_FROM_HERE, ExactBroken, ExactMissed, exactOps, exactStep, facePaintOf, facingFaceIds, fromSolid, imprinted, MAX_SOLID_TEXT, meshed, paintedFrom, paintOfFaces, rigidFrame, solidTooBig, tooBigOf, type FacePaint, type Plane, type Solids } from './exact'

export type EngineCall = (op: string, request: unknown) => Promise<unknown>

export interface ReplayRequest {
  history: History
  /** Font files by name, for text steps that use one. */
  fonts?: Record<string, string>
  /** Also return the parts as they were before this step index (rolling the view back to edit it). */
  before?: number
  /** Run the steps the B-rep kernel has on parts that carry an exact solid (exact.ts); a developer flag for now. */
  exact?: boolean
  /**
   * Ask the engine for an exact solid on a new lofted body, and nothing else of `exact`. A loft the engine makes no
   * body for is today's mesh loft with no note on its step; its reason comes back in `exactLoftsQuiet`.
   */
  exactLofts?: boolean
}

export interface ReplayOptions {
  /** Called before each step that runs, with that step; throw to stop (a newer edit arrived). */
  yieldStep?: (step: Step) => Promise<void>
  /** The engine keeps kernel bodies between calls (one process, as the worker), so exact steps pass solids by
   * number and tessellate only when a step or the result needs the mesh. */
  keepsBodies?: boolean
}

type Faces = NonNullable<HistoryMesh['faces']>

interface Flat {
  name: string
  slot: number
  /** Lists from a mesh step, or the typed arrays an exact solid's tessellation came in. */
  positions: ArrayLike<number>
  indices: ArrayLike<number>
  /** The engine's faces with their keys, carried from step to step as the tools carry them. */
  faces?: Faces
  /** The solid's own corner normals for these triangles (HistoryMesh.normals); a step that changes the triangles
   * drops them, as it drops paint. */
  normals?: Int16Array
  /** The part's paint; a step that changes its triangles drops it. */
  paint?: PaintTexts
  /** The exact solid the triangles came from, until a step runs on the mesh. Only ever the kernel's own output from
   * this replay: a solid from anywhere else (a file, a caller) is never read, so flat() drops it. */
  smb?: string
  /** The solid as a kernel body (ReplayOptions.keepsBodies), held while a cached step has the part. */
  body?: number
  /** With `body`: its faces' keys, while its mesh is not made yet. */
  unmeshed?: number[]
  /** The shape Add shape made the part as, until a step changes it; exact replays build the part from it. */
  primitive?: PrimitiveSpec
  /** The part's paint by face while it is an exact solid (exact.ts FacePaint); its triangles' paint is made from it. */
  facePaint?: FacePaint
  /** The planes a height band split the solid's faces along (exact.ts ExactPart.splitAt). */
  splitAt?: Plane[]
  /** Faces left bare, by layer (HistoryMesh.unpainted). */
  unpainted?: Partial<Record<PaintLayer, number[]>>
}

const flat = (m: HistoryMesh): Flat => ({ name: m.name, slot: m.slot, positions: Array.from(m.positions), indices: Array.from(m.indices), ...(m.faces ? { faces: { ...m.faces, ids: Array.from(m.faces.ids) } } : {}), ...(m.paint ? { paint: m.paint } : {}), ...(m.primitive ? { primitive: m.primitive } : {}) })

/** What a step that changed a painted part's triangles notes. */
export const PAINT_DROPPED = 'This step changed the part, so its paint was cleared.'

/** A step's note with `more` after what it says already. */
function noteMore(found: Pick<Found, 'notes'>, id: string, more: string): void {
  const was = found.notes[id]
  found.notes[id] = was ? `${was} ${more}` : more
}

/** What a join or cut notes when the engine reports the part it left as not closed. */
export const NOT_CLOSED = 'The part is not closed after this step: look where the shapes meet before it is printed.'

/**
 * A join or cut whose volume changes by no more than this, in mm³, changes nothing. A join off the part always adds a
 * piece, so a join that misses and adds no more than this sits inside the part.
 */
export const ADDS_NOTHING_MM3 = 1e-6

/** `why` without the full stop that ends it, for a sentence that goes on after it ("...: why. The design is unchanged."). */
export const unstopped = (why: string): string => why.replace(/[.\s]+$/, '')

/** Why the engine's join or cut does not touch the part: clear of it by a gap, inside it, or meeting it with no change. */
export type Miss = { reason: 'apart'; gapMm: number } | { reason: 'inside' } | { reason: 'unchanged' }

/** A gap shorter than this, in mm, is not named: the shape meets the part, or part of it does. */
export const GAP_NAMED_MM = 0.05

const INSIDE = 'The shape is already inside the part, so nothing changed.'

/**
 * Why a join or cut that does not touch the part is refused, in a sentence: how far short of the part it stops, a join
 * inside the part, or a shape that only meets it. With no reason (an older engine's reply) a join that adds no volume
 * sits inside the part, and anything else no longer reaches it.
 */
export function missSentence(report: { miss?: Miss; volumeChangeMm3?: number }, joins: boolean): string {
  const m = report.miss
  if (!m) return joins && report.volumeChangeMm3 !== undefined && Math.abs(report.volumeChangeMm3) <= ADDS_NOTHING_MM3 ? INSIDE : 'The shape no longer reaches the part.'
  if (m.reason === 'inside') return INSIDE
  if (m.reason === 'apart' && m.gapMm >= GAP_NAMED_MM) return `The shape stops ${m.gapMm.toFixed(1)} mm short of the part.`
  return m.reason === 'apart' && joins ? 'Part of the shape would float off the part, so nothing changed.' : 'The shape only touches the part, so nothing changed.'
}

/**
 * The part with a step's result mesh, its faces with it. Its paint and its exact normals go: the triangles they named
 * are not there any more. `dropped` is told when there was paint, and `ended` when the part was an exact solid, for
 * the step's note.
 */
const next = (part: Flat, m: { positions: ArrayLike<number>; indices: ArrayLike<number>; faces?: Faces }, dropped?: () => void, ended?: () => void): Flat => {
  const { faces: _old, paint, normals: _normals, smb, body, unmeshed: _keys, primitive: _made, facePaint: _byFace, splitAt: _planes, unpainted: _bare, ...rest } = part
  if (paint && dropped) dropped()
  if ((smb || body !== undefined) && ended) ended()
  return { ...rest, positions: m.positions, indices: m.indices, ...(m.faces ? { faces: m.faces } : {}) }
}

// Parts after each step, by a hash of the base and every step up to it. Bounded by the numbers held.
const cache = new Map<string, Flat[]>()
/** What a replay learns up to a step besides the parts, so a warm replay returns what a cold one does. */
interface Learned {
  /** The pushes that went through the part. */
  gone: string[]
  moved: Record<string, MovedFace>
  keys: Found['keys']
  notes: Found['notes']
  copies: Found['copies']
  /** Per step with face or edge keys: the keys it ran with and the keys it has once the app saves what it found. */
  ran: Record<string, [string, string]>
  /** How many of the parts the history numbers; the rest a turned-off step set aside (numbering.ts). All when absent. */
  numbered?: number
}
// What was learned up to each cached step, by the same keys.
const learnedAt = new Map<string, Learned>()
let cachedNumbers = 0
const CACHE_NUMBERS = 24_000_000
/** What a kept body counts for against CACHE_NUMBERS, as its mesh is not there to count. */
const BODY_NUMBERS = 200_000
/** Cached parts holding each kept body; one no cached step holds any more is freed after the next replay. */
const bodyRefs = new Map<number, number>()
const unheld = new Set<number>()
/**
 * The bodies each running replay works with: the ones it made and the ones it read from the cache. Replays can run at
 * once on one engine (two objects edited together), and a body one of them uses may leave the cache while it runs; it
 * is freed only when no running replay has it, by the last one to end.
 */
const inUse = new Set<Set<number>>()
/** How many times the cache was released (releaseReplayCache): a replay that began before the last keeps nothing. */
let releases = 0

const sizeOf = (parts: readonly Flat[]) => parts.reduce((n, p) => n + p.positions.length + p.indices.length + (p.normals?.length ?? 0) + (p.unmeshed ? BODY_NUMBERS : 0), 0)

function hold(parts: readonly Flat[], by: 1 | -1): void {
  for (const p of parts) {
    if (p.body === undefined) continue
    const n = (bodyRefs.get(p.body) ?? 0) + by
    if (n > 0) {
      bodyRefs.set(p.body, n)
      unheld.delete(p.body)
    } else {
      bodyRefs.delete(p.body)
      unheld.add(p.body)
    }
  }
}

function remember(key: string, parts: Flat[], learned: { gone: ReadonlySet<string>; moved: Record<string, MovedFace>; found: Found; ran: Learned['ran']; numbered?: number }): void {
  if (cache.has(key)) return
  learnedAt.set(key, { gone: [...learned.gone], moved: { ...learned.moved }, keys: { ...learned.found.keys }, notes: { ...learned.found.notes }, copies: { ...learned.found.copies }, ran: { ...learned.ran }, ...(learned.numbered !== undefined && learned.numbered < parts.length ? { numbered: learned.numbered } : {}) })
  cache.set(key, parts)
  hold(parts, 1)
  cachedNumbers += sizeOf(parts)
  for (const k of cache.keys()) {
    if (cachedNumbers <= CACHE_NUMBERS) break
    forget(k)
  }
}

function forget(key: string): void {
  const v = cache.get(key)
  if (!v) return
  cache.delete(key)
  learnedAt.delete(key)
  hold(v, -1)
  cachedNumbers -= sizeOf(v)
}

function recall(key: string): Flat[] | undefined {
  const v = cache.get(key)
  if (v) {
    // Most recently used last.
    cache.delete(key)
    cache.set(key, v)
  }
  return v
}

export function clearReplayCache(): void {
  for (const b of bodyRefs.keys()) unheld.add(b)
  bodyRefs.clear()
  cache.clear()
  learnedAt.clear()
  digests = new WeakMap()
  cachedNumbers = 0
}

/**
 * Frees the kept bodies no cached step holds and no running replay uses. One a running replay uses is freed by the
 * last of them to end. Says how many the engine freed (one of an ended process it no longer has is not counted).
 */
async function freeUnheld(call: EngineCall): Promise<number> {
  const busy = new Set([...inUse].flatMap((u) => [...u]))
  const gone = [...unheld].filter((b) => !busy.has(b))
  for (const b of gone) unheld.delete(b)
  let freed = 0
  for (const b of gone) if (((await call('brep.free', { body: b }).catch(() => null)) as { freed?: boolean } | null)?.freed === true) freed++
  return freed
}

/**
 * Lets every kept step go and frees the bodies they held, for a cleared plate whose designs are gone (history.release).
 * A body a running replay uses goes when that replay ends, and a replay that began before this keeps none of what it
 * makes, so its bodies go then too.
 */
export async function releaseReplayCache(call: EngineCall): Promise<{ freed: number }> {
  releases++
  clearReplayCache()
  return { freed: await freeUnheld(call) }
}

/** FNV-1a over a string, continuing from `h`, as 13 base-36 digits. */
function hash(h: string, text: string): string {
  let a = 0x811c9dc5 ^ parseInt(h.slice(0, 6) || '0', 36)
  let b = 0x01000193 ^ parseInt(h.slice(6) || '0', 36)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c ^ (a >>> 7), 0x01000193) >>> 0
  }
  return a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0')
}

// A base mesh never changes in place, so its digest is worked out once per mesh object.
let digests = new WeakMap<object, string>()
const word = new Float64Array(1)
const words = new Uint32Array(word.buffer)

/** A digest of every number in a list: each one's exact bits, so any changed coordinate or index changes it. */
function numbersDigest(nums: ArrayLike<number>): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ nums.length
  for (let i = 0; i < nums.length; i++) {
    word[0] = nums[i]!
    a = Math.imul(a ^ words[0]!, 0x01000193) >>> 0
    b = Math.imul(b ^ words[1]! ^ (a >>> 7), 0x01000193) >>> 0
  }
  return a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0')
}

function meshDigest(p: HistoryMesh): string {
  let d = digests.get(p)
  if (d === undefined) {
    d = `${p.name}|${p.slot}|${numbersDigest(p.positions)}|${numbersDigest(p.indices)}${p.paint ? `|${hash('', JSON.stringify(p.paint))}` : ''}`
    digests.set(p, d)
  }
  return d
}

function meshHash(parts: readonly HistoryMesh[]): string {
  // The base is identified by all of its numbers, positions and indices both.
  return hash('', `${parts.length}|${parts.map(meshDigest).join('|')}`)
}

// Font files by their content, so a font replaced under the same name gives the steps that use it a new key.
const fontDigests = new Map<string, string>()
function fontDigest(data: string | undefined): string {
  if (data === undefined) return '0'
  let d = fontDigests.get(data)
  if (d === undefined) {
    d = hash('', data)
    if (fontDigests.size > 32) fontDigests.clear()
    fontDigests.set(data, d)
  }
  return d
}

/**
 * An engine error as a step's reason. The operation names before it go, however many ("thread: hole: ..."), as the
 * app's sentence() drops them. A field key ("lengthMm: ...", "wallMm: must be above 0 ...") stays as it is, lower
 * case, for the app to name or drop (sizeWords); any other reason starts with a capital.
 */
export function engineReason(err: unknown): string {
  let why = (err instanceof Error ? err.message : String(err)).trim()
  for (let prev = ''; prev !== why; ) {
    prev = why
    why = why.replace(/^[a-z][a-z0-9_.-]*:\s+/, '')
  }
  return /^[a-z]\w*:/.test(why) ? why : why.charAt(0).toUpperCase() + why.slice(1)
}

class Broken extends Error {}

/** A step that did not reach the part: a pattern leaves that copy out (copiesLanded), anywhere else the step breaks. */
class Missed extends Broken {}

const missed = (e: unknown): boolean => e instanceof Missed || e instanceof ExactMissed

/** A mesh part: no exact solid, and no shape the kernel would make it as (exact.ts makes no sphere yet). */
const meshPart = (x: Flat): boolean => !x.smb && x.body === undefined && (!x.primitive || x.primitive.type === 'sphere')
const meshOnly = ({ smb: _smb, body: _body, unmeshed: _keys, facePaint: _byFace, splitAt: _planes, ...rest }: Flat): Flat => rest

/**
 * After an exact step on `from` (the parts it worked on): their paint by face goes on the parts the step made, whose
 * triangles are painted from it now or when they are tessellated. Says whether paint went: a part painted part way
 * across a face had paint by triangle only, which no new triangle keeps.
 */
function carryPaint(before: readonly Flat[], after: Flat[], from: readonly number[]): { parts: Flat[]; dropped: boolean } {
  const kept = new Set(after)
  const old = new Set(before)
  const fp: FacePaint = {}
  for (const i of from) for (const [layer, list] of Object.entries(before[i]?.facePaint ?? {})) fp[layer as keyof FacePaint] = [...(fp[layer as keyof FacePaint] ?? []), ...(list ?? [])]
  const dropped = before.some((x) => x.paint && !x.facePaint && !kept.has(x))
  // the planes a band split the faces along go on with the solid, for the edge steps after it
  const splitAt = from.flatMap((i) => before[i]?.splitAt ?? [])
  if (!Object.keys(fp).length && !splitAt.length) return { parts: after, dropped }
  const parts = after.map((x) => {
    if (old.has(x)) return x
    if (!Object.keys(fp).length) return { ...x, splitAt }
    const { paint: _paint, unpainted: _bare, ...rest } = x
    if (splitAt.length) Object.assign(rest, { splitAt })
    if (x.unmeshed) return { ...rest, facePaint: fp }
    return { ...rest, facePaint: fp, ...paintedFrom(x, fp) }
  })
  return { parts, dropped }
}

const meshedAll = (call: EngineCall, parts: Flat[]): Promise<Flat[]> => (parts.some((p) => p.unmeshed) ? Promise.all(parts.map((p) => meshed(call, p))) : Promise.resolve(parts))

/** A list as the engine's mesh steps read it: a typed array from a tessellation is copied to a plain list here only. */
const listed = (v: ArrayLike<number>): number[] => (Array.isArray(v) ? (v as number[]) : Array.from(v))

/** A part's mesh as a mesh step takes it. */
const meshOf = (p: Flat) => ({ positions: listed(p.positions), indices: listed(p.indices), ...(p.faces ? { faces: Array.isArray(p.faces.ids) ? p.faces : { ...p.faces, ids: listed(p.faces.ids) } } : {}) })

/** The bed's frame, which a loft profile with no frame of its own lies on. */
const BED: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** A loft profile given in world at a step's transform, on the same plane in the part's own frame (`inv` the transform inverted). */
function localProfile(q: LoftProfile, inv: Mat4): LoftProfile {
  const f = q.frame ?? BED
  return { ...q, frame: { origin: point(inv, f.origin), normal: direction(inv, f.normal), u: direction(inv, f.u), v: direction(inv, f.v) } }
}

/** What a new-body loft notes when its step is stretched or mirrored, so the engine was not asked for an exact solid. */
export const EXACT_LOFT_NOT_PLACED = 'This loft is stretched or mirrored where it sits, so it was made as a mesh, not an exact solid.'

/**
 * The edges of a fillet or chamfer step that are still there: an edge whose ends both sat on a face a
 * push took all the way through (a pocket floor pushed out the bottom) went with that face.
 */
function keptEdges<E>(s: Step, edges: readonly E[], gone: ReadonlySet<string>): E[] {
  const through = followsOf(s).filter((f) => gone.has(f.step))
  return edges.filter((_, i) => !through.some((f) => !f.points || (f.points.includes(2 * i) && f.points.includes(2 * i + 1))))
}

/** What a step found its faces by on this replay, and what it noticed. */
interface Found {
  keys: Record<string, { faceKey?: number; openKeys?: number[]; edgeKeys?: ([number, number] | null)[]; skipped?: SkippedEdge[] }>
  notes: Record<string, string>
  /** Per pattern of steps, which copies landed (StepStatus.copies). */
  copies: Record<string, PatternCopies>
  /** Steps the exact kernel failed on this replay, which ran on the mesh. */
  fellBack: string[]
  /** New-body lofts asked exact by `exactLofts` alone that the engine made no body for, with its reason. */
  quiet: { step: string; why: string }[]
}

/**
 * A step's params with the keys a replay found its faces or edges by saved in them, as the app keeps the step after
 * the replay, so a step from a version 1 file has them from then on.
 */
export function withFound(p: StepParams, f: NonNullable<ReplayResult['found']>[string] | undefined): StepParams {
  if (f?.faceKey && p.op === 'face.push') return { ...p, faceKey: f.faceKey }
  if (f?.openKeys && p.op === 'shell') return { ...p, open: p.open.map((o, j) => (f.openKeys![j] ? { ...o, key: f.openKeys![j]! } : o)) }
  if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') {
    // the edges a step left out the first time it ran are kept with it, so a later replay that leaves out others says so
    const skipped = p.skipped === undefined && f?.skipped ? { skipped: f.skipped.map((x) => x.index) } : {}
    if (f?.edgeKeys) return { ...p, ...skipped, edges: p.edges.map((e, j) => (f.edgeKeys![j] ? { ...e, keys: f.edgeKeys![j]! } : e)) }
    return { ...p, ...skipped }
  }
  return p
}

/**
 * The params without the face and edge keys a replay saves into them (withFound), for the cache key: saving what a
 * replay found leaves the step's result the same, so the next replay still finds it. A hit checks the keys (fits).
 */
function unkeyed(p: StepParams): StepParams {
  if (p.op === 'face.push') {
    const { faceKey: _key, ...rest } = p
    return rest
  }
  if (p.op === 'shell') return { ...p, open: p.open.map(({ key: _key, ...o }) => o) }
  if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') {
    const { skipped: _skipped, ...rest } = p
    return { ...rest, edges: p.edges.map(({ keys: _keys, ...e }) => e) }
  }
  return p
}

/** The keys unkeyed leaves out, as text; empty for a step that has none to have. */
function keysOf(p: StepParams): string {
  if (p.op === 'face.push') return String(p.faceKey ?? 0)
  if (p.op === 'shell') return JSON.stringify(p.open.map((o) => o.key ?? 0))
  if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') return JSON.stringify(p.edges.map((e) => e.keys ?? 0))
  return ''
}

/**
 * Whether a cached result holds for these steps' keys: each step has the keys it ran with, or the ones the app saved
 * from that run. Keys a person or a client changed another way run the step again.
 */
function fits(learned: Learned | undefined, steps: readonly Step[]): boolean {
  if (!learned) return false
  return steps.every((s) => {
    const k = s.suppressed ? '' : keysOf(s.params)
    const r = learned.ran[s.id]
    return !k || (!!r && (k === r[0] || k === r[1]))
  })
}

async function runStep(engine: EngineCall, s: Step, parts: Flat[], fonts: Record<string, string>, moved: Record<string, MovedFace>, gone: Set<string>, found: Found, exact = false, solids?: Solids, strict = false): Promise<Flat[]> {
  const p = s.params
  // Every call of the step makes its faces' keys from the step's own salt, as when the tool first ran it.
  const call: EngineCall = (op, r) => engine(op, { ...(r as object), keySalt: stepSalt(s.id), withFaces: true })
  // A new order changes no geometry, so it runs the same on meshes and on exact solids.
  if (p.op === 'parts.order') {
    // parts a step before it added since (a clone or a shape put in at the rolled-back marker) stay after the ordered ones
    if (p.order.length > parts.length) throw new Broken(`This step orders ${p.order.length} parts, and the object has ${parts.length} here.`)
    return [...p.order.map((k) => parts[k]!), ...parts.slice(p.order.length)]
  }
  // A part's filament changes no geometry either: the part, exact or not, keeps its shape and takes the slot.
  if (p.op === 'parts.slot') {
    if (s.part !== -1 && !parts[s.part]) throw new Broken('The part this step works on is gone.')
    return parts.map((x, i) => (s.part === -1 || i === s.part ? { ...x, slot: p.slot } : x))
  }
  // Nor does a part's new name: the part, exact or not, keeps its shape and takes the name.
  if (p.op === 'parts.name') {
    if (!parts[s.part]) throw new Broken('The part this step works on is gone.')
    return parts.map((x, i) => (i === s.part ? { ...x, name: p.name } : x))
  }
  // A part added to a design with exact solids lives beside the exact parts. In a design that must stay exact, each
  // added shape the kernel makes (a box, a cylinder, a cone) is its own solid; any other added part is a mesh part, and
  // elsewhere a shape becomes a solid when a step first works on it. The parts there stay as they are, exact or not.
  if (exact && p.op === 'parts.add') {
    // Separate copies of an exact part (copyOf) are to be made from its solid by the engine's copy call, one move each
    // (piece F). Until the engine has it they are the meshes the step stores: mesh parts beside the exact ones.
    const added: Flat[] = []
    for (const x of p.parts) added.push((strict ? (await addedSolids(call, [x], solids))?.[0] : undefined) ?? flat(x))
    return [...parts, ...added]
  }
  // a solid too big to keep, by cad-history's own limit or as the engine refused it: never silent, and a design that
  // must stay exact stops here; the sentence to put on the step otherwise
  const tooBig = (chars: number, limit: number): string => {
    if (strict) throw new ExactBroken(solidTooBig(chars, true, limit))
    return solidTooBig(chars, false, limit)
  }
  // A step that works only on mesh parts, and makes no new body, runs on the mesh: there is no exact part to keep.
  const reads = s.part === -1 ? parts : [parts[s.part], ...(p.op === 'boolean' ? p.with.map((i) => parts[i]) : [])]
  const newBody = makesBody(p)
  const onMesh = exact && !newBody && reads.length > 0 && reads.every((x) => !!x && meshPart(x))
  if (exact && !onMesh && (parts.some((x) => x.smb || x.body !== undefined || x.primitive) || p.op === 'shape.extrude')) {
    let big: string | undefined
    const done = await exactStep(
      call,
      s,
      parts,
      (error) => {
        // an engine that gives no size and limit (an older one) keeps its own sentence
        const t = tooBigOf(error)
        if (strict && !t) throw new Broken(`Exact operation failed: ${error instanceof Error ? error.message : String(error)}`)
        found.notes[s.id] = t ? tooBig(t.size, t.limit) : EXACT_FELL_BACK
        found.fellBack.push(s.id)
      },
      solids,
      (m, key, reached) => {
        // as the mesh path below records a push
        moved[s.id] = m
        if (p.op === 'face.push' && key && key !== p.faceKey) found.keys[s.id] = { faceKey: key }
        if (!reached) gone.add(s.id)
      },
      undefined,
      (chars, limit) => {
        big = tooBig(chars, limit)
      },
    )
    if (done) {
      const carried = carryPaint(parts, done, [s.part, ...(p.op === 'boolean' ? p.with : [])])
      if (carried.dropped) found.notes[s.id] = PAINT_DROPPED
      if (big) found.notes[s.id] = found.notes[s.id] ? `${found.notes[s.id]} ${big}` : big
      return carried.parts
    }
  }
  // A new body lofted where the engine makes exact lofts itself is asked for as one. The op takes no transform, so
  // the profiles go in the part's own frame and the body comes back there, as every later exact step expects it.
  let lofted: { mesh: { positions: number[]; indices: number[] } } | undefined
  if ((exact || solids?.lofts) && solids && p.op === 'sketch.loft' && (p.operation ?? 'new') === 'new' && (await solids.has?.('sketch.loft'))) {
    // a loft the engine made no body for runs on the mesh, with the engine's own sentence on the step; asked by
    // `exactLofts` alone, the step has no note and the sentence goes to the quiet list
    const fell = (why: string) => {
      if (strict) throw new Broken(`Exact operation failed: ${why}`)
      if (!exact) {
        found.quiet.push({ step: s.id, why })
        return
      }
      found.notes[s.id] = why
      found.fellBack.push(s.id)
    }
    if (!rigidFrame(s.transform)) fell(EXACT_LOFT_NOT_PLACED)
    else {
      const same = s.transform.every((v, i) => v === IDENTITY[i])
      const inv = invert(s.transform)
      // asked for and answered as the other exact steps' bodies are (exact.ts): a number with its faces' keys
      // (`withKeys`) from an engine that keeps bodies, the solid's text (`save`) from one that does not
      let r: { mesh: { positions: number[]; indices: number[] }; body?: unknown; bodyKeys?: unknown; bodySmb?: unknown; exact?: { made?: boolean; why?: unknown } }
      let refused = false
      try {
        r = (await call('sketch.loft', { ...loftOpts(same ? p : { ...p, profiles: p.profiles.map((q) => localProfile(q, inv)) }), operation: 'new', exact: true, ...(solids.keep ? { withKeys: true } : { save: true }) })) as typeof r
      } catch (e) {
        // a body too big for the engine: the loft runs on the mesh with the size and the limit; any other error is the step's
        const t = tooBigOf(e)
        if (!t) throw e
        fell(tooBig(t.size, t.limit))
        refused = true
        r = { mesh: { positions: [], indices: [] } }
      }
      const like = { name: p.name ? p.name : 'Body', slot: newSlot(p) ?? parts[s.part]?.slot ?? 1 }
      let body: Flat | undefined
      if (solids.keep && typeof r.body === 'number') {
        solids.made(r.body)
        body = { ...like, positions: [], indices: [], body: r.body, unmeshed: Array.isArray(r.bodyKeys) ? (r.bodyKeys as number[]) : [] }
      } else if (!solids.keep && typeof r.bodySmb === 'string') {
        let big: string | undefined
        body = await fromSolid(call, like, r.bodySmb, (chars, limit) => (big = tooBig(chars, limit)), (await solids.limit?.()) ?? MAX_SOLID_TEXT)
        if (big) {
          if (exact) found.notes[s.id] = big
          else found.quiet.push({ step: s.id, why: big })
        }
      }
      if (body) {
        const out = parts.slice()
        placeBody(out, s.part, body)
        return out
      }
      if (!refused) fell(typeof r.exact?.why === 'string' && r.exact.why ? r.exact.why : EXACT_FELL_BACK)
      // the answer's mesh is today's loft when the profiles went as they are
      if (same && !refused) lofted = r
    }
  }
  // paint keeps a solid when it covers whole faces (below), so a design that must stay exact takes it
  if (strict && !onMesh && p.op !== 'paint') throw new Broken(`Exact replay does not support ${p.op} for this part. The mesh path was not used.`)
  const targets = s.part === -1 ? parts.map((_, i) => i) : [s.part]
  // the mesh path works on meshes: the kept bodies of the parts it reads are tessellated now, and every other part
  // keeps its solid untouched; a new body or an added part reads none
  const meshes = p.op === 'parts.add' || newBody ? [] : reads
  parts = meshes.some((x) => x?.unmeshed) ? await Promise.all(parts.map((x) => (meshes.includes(x) ? meshed(engine, x) : x))) : parts
  const out = parts.slice()
  const item = (f: Flat) => ({ mesh: meshOf(f), transform: s.transform })
  const dropped = () => {
    found.notes[s.id] = PAINT_DROPPED
  }
  // a part that was an exact solid until this step is a mesh from here on: the step says so, once, unless its note
  // already says it ran on the mesh (EXACT_FELL_BACK)
  const ended = () => {
    if (exact && !found.fellBack.includes(s.id) && !found.notes[s.id]?.includes(EXACT_MESH_FROM_HERE)) noteMore(found, s.id, EXACT_MESH_FROM_HERE)
  }
  // A result in world space, back in the part's frame. Only the name and slot carry over: paint goes, as in next().
  const local = (m: { positions: ArrayLike<number>; indices: ArrayLike<number> }, like: Pick<Flat, 'name' | 'slot' | 'paint'>): Flat => {
    if (like.paint) dropped()
    return flat(bakeMesh({ name: like.name, slot: like.slot, ...m }, invert(s.transform)))
  }
  const keep = (part: Flat, m: { positions: ArrayLike<number>; indices: ArrayLike<number>; faces?: Faces }) => next(part, m, dropped, ended)
  if (p.op === 'parts.add') return [...out, ...p.parts.map(flat)]
  if (p.op === 'boolean' || p.op === 'plane.cut' || p.op === 'split' || p.op === 'mirror') return partsStep(call, s, p, out, dropped, ended)
  // newBody holds only for these ops; naming them again narrows p
  if (newBody && (p.op === 'shape.extrude' || p.op === 'sketch.revolve' || p.op === 'sketch.loft' || p.op === 'sketch.sweep')) {
    const name = p.name ? p.name : 'Body'
    const req = p.op === 'shape.extrude' ? { frame: p.frame, shape: p.shape, placement: p.placement ?? {}, spec: p.spec, ...(p.font ? { fontBase64: font(p.font, fonts) } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) } : p.op === 'sketch.loft' ? { ...loftOpts(p), operation: 'new' } : p.op === 'sketch.sweep' ? { ...sweepOpts(p), operation: 'new' } : { frame: p.frame, loops: p.loops, axis: p.axis, angleDeg: p.angleDeg, operation: 'new' }
    const r = lofted ?? ((await call(p.op, req)) as { mesh: { positions: number[]; indices: number[] } })
    const body = local(r.mesh, { name, slot: newSlot(p) ?? out[s.part]?.slot ?? 1 })
    placeBody(out, s.part, body)
    return out
  }
  for (const i of targets) {
    const part = out[i]
    if (!part) throw new Broken('The part this step works on is gone.')
    switch (p.op) {
      case 'face.push': {
        // a saved key never falls back to a nearby face
        const byKey = p.faceKey ? findByKey(part, s.transform, p.faceKey, p.at) : null
        if (p.faceKey && !byKey) throw new Broken('Missing face; pick the face again to repair this step.')
        if (byKey?.split) throw new Broken('Ambiguous face; pick the face again to repair this step.')
        const triangle = byKey ? byKey.triangle : findTriangle(part, s.transform, p.at, p.normal)
        if (triangle < 0) throw new Broken('The face this step moved is gone.')
        const key = keyOfTriangle(part, triangle)
        if (key && key !== p.faceKey) found.keys[s.id] = { faceKey: key }
        const r = (await call('face.push', { mesh: item(part), triangle, at: byKey ? byKey.at : p.at, distanceMm: p.distanceMm })) as { mesh: Flat; moved: MovedFace }
        moved[s.id] = r.moved
        out[i] = keep(part, r.mesh)
        // No face is left where it moved to: it went through the part, and the edges on it with it.
        const l = Math.hypot(...p.normal) || 1
        const cap: [number, number, number] = [p.at[0] + (p.normal[0] / l) * p.distanceMm, p.at[1] + (p.normal[1] / l) * p.distanceMm, p.at[2] + (p.normal[2] / l) * p.distanceMm]
        if (!hasFaceOn(out[i]!, s.transform, cap, p.normal)) gone.add(s.id)
        break
      }
      case 'shape.extrude':
      case 'sketch.revolve':
      case 'sketch.loft':
      case 'sketch.sweep': {
        const req = p.op === 'shape.extrude' ? { frame: p.frame, shape: p.shape, placement: p.placement ?? {}, spec: p.spec, target: item(part), ...(p.font ? { fontBase64: font(p.font, fonts) } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) } : p.op === 'sketch.loft' ? { ...loftOpts(p), operation: p.operation, target: item(part) } : p.op === 'sketch.sweep' ? { ...sweepOpts(p), operation: p.operation, target: item(part) } : { frame: p.frame, loops: p.loops, axis: p.axis, angleDeg: p.angleDeg, operation: p.operation, target: item(part) }
        const r = (await call(p.op, req)) as { mesh: Flat; report: { touches: boolean; miss?: Miss; volumeChangeMm3?: number; watertight?: boolean } }
        const joins = (p.op === 'shape.extrude' ? p.spec.operation : p.operation) === 'join'
        if (!r.report.touches) {
          const why = missSentence(r.report, joins)
          throw why === INSIDE ? new Broken(why) : new Missed(why)
        }
        out[i] = keep(part, r.mesh)
        // the step lands, and says so, when the engine reads the part it left as open
        if (r.report.watertight === false) noteMore(found, s.id, NOT_CLOSED)
        break
      }
      case 'subtract': {
        // as the tool sends it: the part with its transform, answered in the part's frame with the cut's faces
        const r = (await call('subtract', { mesh: item(part), solids: p.solids })) as { mesh: Flat; removedVolumeMm3: number; watertight?: boolean }
        if (!(r.removedVolumeMm3 > 0)) throw new Missed('The shape no longer reaches the part.')
        out[i] = keep(part, r.mesh)
        // a cut the same size as a wall it meets can leave the part open: it lands, and says so, as a join does
        if (r.watertight === false) noteMore(found, s.id, NOT_CLOSED)
        break
      }
      case 'hollow':
      case 'repair':
      case 'simplify': {
        const options = p.op === 'hollow' ? { wallMm: p.wallMm } : p.op === 'simplify' ? { targetRatio: p.targetRatio } : {}
        const r = (await call(p.op, { mesh: meshOf(part), options })) as { mesh: Flat }
        out[i] = keep(part, r.mesh)
        break
      }
      case 'array.merged': {
        const r = (await call('array', { mesh: item(part), spec: p.spec, merge: true, options: {} })) as { mesh: Flat }
        out[i] = keep(part, r.mesh)
        break
      }
      case 'hole.apply': {
        // The engine finds the hole again on the part as it is now, or says it is gone.
        let r: { mesh: Flat }
        try {
          r = (await call('hole.apply', { mesh: item(part), hole: p.hole, spec: p.spec })) as { mesh: Flat }
        } catch (err) {
          throw new Broken(engineReason(err))
        }
        out[i] = keep(part, r.mesh)
        break
      }
      case 'shell': {
        // The open faces are found again by their keys, or by their place and normal, on the part as it is now.
        let r: { mesh: Flat; report: { openKeys?: number[] } }
        try {
          r = (await call('shell', { mesh: item(part), open: p.open, wallMm: p.wallMm })) as { mesh: Flat; report: { openKeys?: number[] } }
        } catch (err) {
          throw new Broken(engineReason(err))
        }
        const keys = r.report.openKeys ?? []
        if (keys.some((k, j) => k && k !== p.open[j]?.key)) found.keys[s.id] = { openKeys: keys }
        out[i] = keep(part, r.mesh)
        break
      }
      case 'thread.apply': {
        // A hole's wall is found again on the part as it is now; a rod or boss keeps its place.
        let r: { mesh: Flat }
        try {
          r = (await call('thread.apply', { mesh: item(part), thread: p.thread, spec: p.spec })) as { mesh: Flat }
        } catch (err) {
          throw new Broken(engineReason(err))
        }
        out[i] = keep(part, r.mesh)
        break
      }
      case 'paint': {
        // The target found again on the part as it is now; a seed's face first by its key, as push steps find theirs.
        let target = p.target
        // a paint step with no target (none can be made, but a history may hold one) is broken as a lost face is
        if (!target?.kind) throw new Broken('Missing face; pick the face again to repair this step.')
        if (target.kind === 'seed' && target.faceKey) {
          const byKey = findByKey(part, s.transform, target.faceKey, target.point)
          if (!byKey) throw new Broken('Missing face; pick the face again to repair this step.')
          if (byKey.split) throw new Broken('Ambiguous face; pick the face again to repair this step.')
          target = { ...target, point: byKey.at }
        }
        // A height band on an exact part goes on whole faces, so it lasts through the part's next exact steps as paint by
        // face does: the kernel first splits the faces that cross the band's edges (an engine that cannot leaves the
        // band on the triangles, below)
        let whole: Set<number> | undefined
        let on = part
        if (target.kind === 'height' && (on.smb || on.body !== undefined) && on.faces && solids) {
          const band = bandOf(target)
          const at = bandCrossings(on, s.transform, band)
          if (!at.length || (await solids.has?.(EXACT_IMPRINT))) {
            if (at.length) {
              try {
                on = await imprinted(call, on, s.transform, at, solids, (chars, limit) => noteMore(found, s.id, tooBig(chars, limit)))
              } catch (err) {
                if (err instanceof ExactBroken || (err as { name?: string }).name === 'AbortError') throw err
                throw new Broken(engineReason(err))
              }
            }
            whole = bandFaceIds(on, s.transform, band)
          }
        }
        const texts = on.paint?.[p.layer] ?? {}
        let r: { changed: Record<string, string> }
        try {
          r = whole ? await paintFaces(engine, on, s.transform, whole, texts, p.state) : ((await engine('paint.select', { mesh: meshOf(on), transform: s.transform, paint: texts, state: p.state, target, ...(p.maxDepth !== undefined ? { maxDepth: p.maxDepth } : {}) })) as { changed: Record<string, string> })
        } catch (err) {
          if (err instanceof Broken || err instanceof ExactBroken) throw err
          throw new Broken(engineReason(err))
        }
        // a direction on an exact part goes on whole faces too: each face it reached, when the face's own normal is
        // within the angle (a curved face only partly facing that way stays bare), so the paint lasts as paint by face
        if (target.kind === 'direction' && (on.smb || on.body !== undefined) && on.faces) {
          try {
            r = await paintFaces(engine, on, s.transform, facingFaceIds(on, s.transform, target, Object.keys(r.changed).map(Number)), texts, p.state)
          } catch (err) {
            throw new Broken(engineReason(err))
          }
        }
        const layer: Record<number, string> = { ...texts }
        for (const [k, v] of Object.entries(r.changed)) {
          if (v) layer[Number(k)] = v
          else delete layer[Number(k)]
        }
        const { [p.layer]: _was, ...others } = on.paint ?? {}
        const paint: PaintTexts = Object.keys(layer).length ? { ...others, [p.layer]: layer } : others
        const { paint: _old, facePaint: _byFace, ...rest } = on
        const painted: Flat = Object.keys(paint).length ? { ...rest, paint } : rest
        if (!on.smb && on.body === undefined) {
          out[i] = painted
          break
        }
        // an exact part keeps its paint by face, so the paint lasts through its next exact steps. Paint across part of a
        // face has no such form: it stays on the triangles, and the part's next exact step clears it with its note
        const byFace = facePaintOf(painted)
        // a face left bare because its pieces were painted apart stays so, and listed, until this layer paints it
        const { unpainted: _bare, ...plain } = painted
        const tris = (id: number) => Array.from(on.faces?.ids ?? []).flatMap((x, t) => (x === id ? [t] : []))
        const bare = (on.unpainted?.[p.layer] ?? []).filter((id) => tris(id).every((t) => !layer[t]))
        const unpainted = { ...on.unpainted, [p.layer]: bare }
        if (!bare.length) delete unpainted[p.layer]
        const listed: Flat = Object.keys(unpainted).length ? { ...plain, unpainted } : plain
        if (byFace && bare.length) {
          const kept = (on.facePaint?.[p.layer] ?? []).filter((e) => {
            const t = e.at && e.normal ? findTriangle(on, IDENTITY, e.at, e.normal) : -1
            return t >= 0 && bare.includes(on.faces!.ids[t]!)
          })
          byFace[p.layer] = [...(byFace[p.layer] ?? []), ...kept]
        }
        if (byFace) out[i] = Object.keys(byFace).length ? { ...listed, facePaint: byFace } : listed
        else if (strict) throw new Broken(`Exact replay does not support ${p.op} for this part. The mesh path was not used.`)
        else out[i] = listed
        break
      }
      case 'edge.fillet':
      case 'edge.chamfer': {
        const { op: _op, ...rest } = p
        const edges = keptEdges(s, p.edges, gone)
        if (!edges.length) break
        const { skipped: before, ...ask } = rest
        const r = (await call(p.op, { mesh: item(part), ...ask, edges })) as { mesh: Flat; refs?: EdgeRef[]; notes?: string[]; skipped?: SkippedEdge[] }
        // The keys each edge was found by, in the step's own order, for the step to keep.
        const keys: ([number, number] | null)[] = p.edges.map((e) => e.keys ?? null)
        let changed = false
        edges.forEach((e, j) => {
          const k = r.refs?.[j]?.keys
          const at = p.edges.indexOf(e)
          if (k && at >= 0 && (keys[at]?.[0] !== k[0] || keys[at]?.[1] !== k[1])) {
            keys[at] = k
            changed = true
          }
        })
        // what was left out, by the step's own edge numbers
        const skipped = r.skipped?.map((x) => ({ ...x, index: p.edges.indexOf(edges[x.index]!) }))
        if (changed || skipped) found.keys[s.id] = { ...(changed ? { edgeKeys: keys } : {}), ...(skipped ? { skipped } : {}) }
        const notes = r.notes?.map((n) => n.charAt(0).toUpperCase() + n.slice(1)) ?? []
        const now = (skipped ?? []).map((x) => x.index)
        if (before && skipped && JSON.stringify(before) !== JSON.stringify(now)) {
          const list = (l: number[]) => (l.length ? l.map((i) => i + 1).join(', ') : 'none')
          notes.unshift(`This step now leaves edges ${list(now)} as they were; when it was made it left ${list(before)}`)
        }
        if (notes.length) found.notes[s.id] = notes.join('. ') + '.'
        out[i] = keep(part, r.mesh)
        break
      }
    }
  }
  return out
}

/**
 * Paints `state` on the whole of faces `ids` of the part, as the engine paints a whole part (paint.select): the
 * triangles' new texts, by the part's own triangle numbers.
 */
async function paintFaces(engine: EngineCall, part: Flat, transform: Mat4, ids: ReadonlySet<number>, texts: Record<number, string>, state: number): Promise<{ changed: Record<string, string> }> {
  const tris: number[] = []
  for (let t = 0; t < Math.floor(part.indices.length / 3); t++) if (ids.has(part.faces!.ids[t]!)) tris.push(t)
  if (!tris.length) return { changed: {} }
  const indices = tris.flatMap((t) => [part.indices[3 * t]!, part.indices[3 * t + 1]!, part.indices[3 * t + 2]!])
  const paint: Record<number, string> = {}
  tris.forEach((t, j) => {
    if (texts[t] !== undefined) paint[j] = texts[t]!
  })
  const r = (await engine('paint.select', { mesh: { positions: listed(part.positions), indices }, transform, paint, state, target: { kind: 'part' } })) as { changed: Record<string, string> }
  return { changed: Object.fromEntries(Object.entries(r.changed).map(([j, v]) => [String(tris[Number(j)]), v])) }
}

/** A step's params for a copy a pattern makes: without the face and edge keys, which name the original's faces. */
function copyParams(p: StepParams): StepParams {
  const q = unkeyed(p)
  if (q.op !== 'paint' || q.target?.kind !== 'seed' || !q.target.faceKey) return q
  const { faceKey: _key, ...target } = q.target
  return { ...q, target }
}

/** A step that went through: its note, for a pattern of steps which copies landed, and the edges it left out. */
function doneStatus(found: Found, id: string): StepStatus {
  const note = found.notes[id]
  const copies = found.copies[id]
  // the edges a step that may leave some out left as they were (a fillet or chamfer)
  const left = found.keys[id]?.skipped
  return { state: 'done', ...(note ? { note } : {}), ...(copies ? { copies } : {}), ...(left ? { skipped: left } : {}) }
}

/** Which copies of a pattern of steps landed (StepStatus.copies), as data from the reckoning its note words. */
function keptCopies(found: Found, id: string, total: number, missed: number[]): void {
  found.copies[id] = { total, kept: total - missed.length, missed }
}

/**
 * A pattern step: the steps it repeats (from `earlier`, the steps before it) run again for each copy, at their
 * transform moved by the copy's move, so each lands where the copy is, with no value of theirs rewritten. Copies get
 * their own ids, so the faces they make get keys of their own; what they find or note is the pattern's.
 */
async function patternStep(call: EngineCall, s: Step, earlier: readonly Step[], parts: Flat[], fonts: Record<string, string>, moved: Record<string, MovedFace>, gone: Set<string>, found: Found, exact = false, solids?: Solids, strict = false, inCopy?: number): Promise<Flat[]> {
  const p = s.params
  if (p.op !== 'pattern') return parts
  const byId = new Map(earlier.map((x) => [x.id, x]))
  const sources = p.steps.map((id) => byId.get(id))
  if (sources.some((x) => !x)) throw new Broken('A step this pattern repeats is gone or comes after it; pick the steps again.')
  const live = (sources as Step[]).filter((x) => !x.suppressed)
  for (const x of live) {
    const why = repeatProblem(x) ?? (x.part !== s.part ? 'A pattern repeats steps on the part it works on; a step it names works on another part.' : null)
    if (why) throw new Broken(why)
  }
  const why = stepPatternProblem(p.spec)
  if (why) throw new Broken(why)
  if (!live.length) {
    found.notes[s.id] = 'The steps this pattern repeats are turned off, so it repeats nothing.'
    return parts
  }
  const notes: string[] = []
  const toWorld = s.transform
  const fromWorld = invert(s.transform)
  // one cut or join repeated on an exact solid is made in one kernel call with every copy's tool, not one per copy;
  // a row that follows a surface turns its copies, and runs copy by copy
  const only = live.length === 1 ? live[0]! : undefined
  const target = parts[s.part]
  const follows = p.spec.kind === 'linear' && !!p.spec.onSurface
  if (exact && only && !follows && only.params.op !== 'pattern' && target && (target.smb || target.body !== undefined || target.primitive)) {
    const moves = stepCopyMoves(p.spec).map((move) => multiply(fromWorld, multiply(move, toWorld)))
    const salted: EngineCall = (op, r) => call(op, { ...(r as object), keySalt: stepSalt(s.id), withFaces: true })
    const copies = moves.map((_, k) => k + 2)
    let done: Flat[] | null
    // which copies left nothing of their own, as the kernel says; null when it does not say, and then today's check
    // stands: a call that touches nothing missed with every copy, one that touches kept them all
    let left = null as number[] | null
    try {
      done = await exactStep(salted, { ...only, id: s.id, params: copyParams(only.params) }, parts, () => {}, solids, () => {}, moves, undefined, (m) => { left = m && m.map((j) => j + 2) })
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e
      if (!missed(e)) throw new Broken(e instanceof Error ? e.message : String(e))
      left = copies
      done = null
    }
    const landed = copiesLanded(copies, left, inCopy)
    if (landed.broken) throw new Missed(landed.broken)
    // every copy missed inside a copy of an outer pattern: the parts stay as they are, and the note says so
    if (done || left === copies) {
      const carried = done ? carryPaint(parts, done, [s.part]) : { parts, dropped: false }
      if (carried.dropped) found.notes[s.id] = PAINT_DROPPED
      if (inCopy === undefined) keptCopies(found, s.id, moves.length + 1, landed.missed)
      if (landed.note) found.notes[s.id] = found.notes[s.id] ? `${landed.note} ${found.notes[s.id]}` : landed.note
      return carried.parts
    }
  }
  let out = parts
  const moves = stepCopyMoves(p.spec)
  // each copy's move along the surface, or null for one that found no side there
  let placed: (Mat4 | null)[] | null = null
  // a row along a curved side: each copy slides onto the part's surface where it lands and turns to it
  if (p.spec.kind === 'linear' && p.spec.onSurface) {
    const anchor = live.map((x) => anchorOf(x.params)).find((a) => a !== null)
    if (!anchor) throw new Broken('A row follows a surface from a cut or a shape on a face; the steps it repeats have no place on the part to start from.')
    const part = parts[s.part]
    if (!part) throw new Broken('The part this pattern works on is gone.')
    const world = bakeMesh({ name: part.name, slot: part.slot, positions: part.positions, indices: part.indices }, s.transform)
    const follow = surfaceMoves(moves, anchor, Array.from(world.positions), Array.from(part.indices))
    if (!Array.isArray(follow)) throw new Broken(`Copy ${follow.copy}: ${follow.why}`)
    placed = follow.map((m) => (Array.isArray(m) ? m : null))
  }
  const left: number[] = []
  for (const [k, move] of moves.entries()) {
    // a copy of a row along a surface that found no side where it lands is left out as one that missed
    const on = placed ? placed[k] : move
    if (!on) {
      left.push(k + 2)
      continue
    }
    // the copy's move in the part's own frame, undone at each step's transform: the step then lands moved by it
    const back = invert(multiply(fromWorld, multiply(on, toWorld)))
    // a copy that misses the part is left out whole: the parts go back to how they were before its first step
    const before = out
    let miss = false
    for (const [j, x] of live.entries()) {
      const copy: Step = { id: `${s.id}#${k + 2}.${j + 1}`, part: x.part, transform: multiply(x.transform, back), params: copyParams(x.params) }
      try {
        if (x.params.op === 'pattern') {
          // a pattern of a pattern (a row of vents mirrored to the other side): the inner pattern's own steps run
          // again moved by this copy, then the inner pattern runs on them, moved too
          const inner = x.params
          const tag = `#${k + 2}.${j + 1}`
          const own = new Set(inner.steps)
          const movedEarlier = earlier.map((e) => (own.has(e.id) ? { ...e, id: `${e.id}${tag}`, transform: multiply(e.transform, back), params: copyParams(e.params) } : e))
          for (const e of movedEarlier) if (e.id.endsWith(tag) && !e.suppressed) out = await runStep(call, e, out, fonts, moved, gone, found, exact, solids, strict)
          out = await patternStep(call, { ...copy, params: { ...inner, steps: inner.steps.map((id) => `${id}${tag}`) } }, movedEarlier, out, fonts, moved, gone, found, exact, solids, strict, k + 2)
          continue
        }
        out = await runStep(call, copy, out, fonts, moved, gone, found, exact, solids, strict)
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') throw e
        if (!missed(e)) throw new Broken(`Copy ${k + 2}: ${e instanceof Error ? e.message : String(e)}`)
        miss = true
        out = before
      } finally {
        const note = found.notes[copy.id]
        if (note && note !== EXACT_FELL_BACK && !notes.includes(note)) notes.push(note)
        delete found.notes[copy.id]
        delete found.keys[copy.id]
        delete moved[copy.id]
        gone.delete(copy.id)
        const fell = found.fellBack.indexOf(copy.id)
        if (fell >= 0) {
          found.fellBack.splice(fell, 1)
          if (!found.fellBack.includes(s.id)) found.fellBack.push(s.id)
          if (!notes.includes(EXACT_FELL_BACK)) notes.push(EXACT_FELL_BACK)
        }
      }
      if (miss) break
    }
    if (miss) left.push(k + 2)
  }
  const landed = copiesLanded(moves.map((_, k) => k + 2), left, inCopy)
  if (landed.broken) throw new Missed(landed.broken)
  // which copies landed, as data, from the same reckoning the note words; an inner pattern's are its outer copy's
  if (inCopy === undefined) keptCopies(found, s.id, moves.length + 1, landed.missed)
  if (landed.note) notes.unshift(landed.note)
  if (notes.length) found.notes[s.id] = notes.join(' ')
  return out
}

type PartsParams = Extract<StepParams, { op: 'boolean' | 'plane.cut' | 'split' | 'mirror' }>

const unit3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** A plane given in world at the step's transform, in the part's own frame. */
function localPlane(s: Step, plane: { point: Vec3; normal: Vec3 }): { point: Vec3; normal: Vec3 } {
  const inv = invert(s.transform)
  return { point: point(inv, plane.point), normal: unit3(direction(inv, plane.normal)) }
}

const hasTriangles = (m: { indices?: ArrayLike<number> } | undefined): m is { positions: ArrayLike<number>; indices: ArrayLike<number>; faces?: Faces } => (m?.indices?.length ?? 0) >= 3

/** Steps that change which parts there are: combining parts, cutting one in two, splitting it to fit, mirroring it. */
async function partsStep(call: EngineCall, s: Step, p: PartsParams, parts: Flat[], dropped: () => void, ended: () => void): Promise<Flat[]> {
  const part = parts[s.part]
  if (!part) throw new Broken('The part this step works on is gone.')
  const item = (f: Flat) => ({ mesh: meshOf(f), transform: s.transform })
  const out = parts.slice()
  switch (p.op) {
    case 'boolean': {
      const others = p.with.map((i) => parts[i])
      if (p.with.includes(s.part) || others.some((o) => !o)) throw new Broken('A part this step combines is gone.')
      const rest = others as Flat[]
      const r = (await call('boolean', p.kind === 'union' ? { op: 'union', a: [item(part), ...rest.map(item)], b: [] } : { op: p.kind, a: [item(part)], b: rest.map(item) })) as { mesh: Flat }
      if (!hasTriangles(r.mesh)) throw new Broken('Nothing is left of the part after this step.')
      out[s.part] = next(part, r.mesh, dropped, ended)
      return out.filter((_, i) => !p.with.includes(i))
    }
    case 'plane.cut': {
      const r = (await call('cut', { mesh: meshOf(part), plane: localPlane(s, p.plane), options: {} })) as { below?: Flat; above?: Flat }
      const below = hasTriangles(r.below) ? r.below : undefined
      const above = hasTriangles(r.above) ? r.above : undefined
      if (!below || !above) throw new Broken('The plane no longer crosses the part.')
      if (p.keep === 'below') out[s.part] = next(part, below, dropped, ended)
      else if (p.keep === 'above') out[s.part] = next(part, above, dropped, ended)
      else out.splice(s.part, 1, next(part, below, dropped, ended), { ...next(part, above, dropped, ended), name: p.name ?? `${part.name} top` })
      return out
    }
    case 'split': {
      const r = (await call('split', { mesh: meshOf(part), options: { buildVolumeMm: p.buildVolumeMm, ...(p.marginMm !== undefined ? { marginMm: p.marginMm } : {}) } })) as { parts?: { mesh: Flat }[] }
      const pieces = (r.parts ?? []).map((x) => x.mesh).filter(hasTriangles)
      if (!pieces.length) throw new Broken('The part could not be split to fit.')
      out.splice(s.part, 1, ...pieces.map((m, k) => ({ ...next(part, m, dropped, ended), ...(pieces.length > 1 ? { name: `${part.name} ${k + 1}` } : {}) })))
      return out
    }
    case 'mirror': {
      const { point: q, normal: n } = localPlane(s, p.plane)
      const d = 2 * (q[0] * n[0] + q[1] * n[1] + q[2] * n[2])
      // Reflection through the plane, column-major: I - 2nn^T, moved by 2(n.q)n.
      const m: number[] = [1 - 2 * n[0] * n[0], -2 * n[1] * n[0], -2 * n[2] * n[0], 0, -2 * n[0] * n[1], 1 - 2 * n[1] * n[1], -2 * n[2] * n[1], 0, -2 * n[0] * n[2], -2 * n[1] * n[2], 1 - 2 * n[2] * n[2], 0, d * n[0], d * n[1], d * n[2], 1]
      const image = bakeMesh(part, m)
      const flipped = { positions: Array.from(image.positions), indices: Array.from(image.indices) }
      const r = (await call('boolean', { op: 'union', a: p.copy ? [{ mesh: meshOf(part) }, { mesh: flipped }] : [{ mesh: flipped }], b: [] })) as { mesh: Flat }
      if (!hasTriangles(r.mesh)) throw new Broken('The mirror made nothing.')
      out[s.part] = next(part, r.mesh, dropped, ended)
      return out
    }
  }
}

/** A sweep step's engine request without its operation: the profile, the path, and the taper, twist and end section it was made with. */
function sweepOpts(p: Extract<StepParams, { op: 'sketch.sweep' }>): Record<string, unknown> {
  return { profile: p.profile, path: p.path, ...(p.thicken ? { thicken: p.thicken } : {}), ...(p.scaleEnd !== undefined ? { scaleEnd: p.scaleEnd } : {}), ...(p.twistDeg ? { twistDeg: p.twistDeg } : {}), ...(p.ease ? { ease: p.ease } : {}), ...(p.endProfile ? { endProfile: p.endProfile } : {}) }
}

/** A loft step's engine request without its operation: the profiles and the options it was made with. */
function loftOpts(p: Extract<StepParams, { op: 'sketch.loft' }>): Record<string, unknown> {
  return { profiles: p.profiles, ...(p.smooth ? { smooth: true } : {}), ...(p.closed ? { closed: true } : {}), ...(p.thicken ? { thicken: p.thicken } : {}) }
}

function font(name: string, fonts: Record<string, string>): string {
  const f = fonts[name]
  if (!f) throw new Broken(`Pick the font again: ${name} is not loaded.`)
  return f
}

/** Runs the history and says, per step, what happened. */
export async function replayHistory(call: EngineCall, req: ReplayRequest, o: ReplayOptions = {}): Promise<ReplayResult & { before?: HistoryMesh[] }> {
  if (req.history.exact) req = { ...req, exact: true }
  const made = new Set<number>()
  // which operations the engine makes exact bodies for is asked once, by the first step that needs to know
  let has: ReturnType<typeof exactOps> | undefined
  const uses = new Set<number>()
  inUse.add(uses)
  const solids: Solids = { keep: !!((req.exact || req.exactLofts) && o.keepsBodies), lofts: !!req.exactLofts, made: (b) => (made.add(b), uses.add(b)), has: async (op) => (await (has ??= exactOps(call))).ops.has(op), limit: async () => (await (has ??= exactOps(call))).maxSolidText }
  try {
    return await replaySteps(call, req, o, solids, (b) => uses.add(b), releases)
  } finally {
    inUse.delete(uses)
    // bodies this replay made that no cached step holds, and ones whose last cached step went, but none another
    // running replay still uses: that one frees it when it ends
    for (const b of made) if (!bodyRefs.has(b)) unheld.add(b)
    if (solids.keep) await freeUnheld(call)
  }
}

async function replaySteps(call: EngineCall, req: ReplayRequest, o: ReplayOptions, solids: Solids, uses: (body: number) => void, era: number): Promise<ReplayResult & { before?: HistoryMesh[] }> {
  const { history } = req
  // a release since this replay began let its design go: what it makes from here is not kept
  const cacheStep: typeof remember = (key, parts, learned) => {
    if (era === releases) remember(key, parts, learned)
  }
  const steps = history.steps
  const status: StepStatus[] = steps.map((s) => (s.suppressed ? { state: 'suppressed' } : { state: 'skipped' }))
  const moved: Record<string, MovedFace> = {}
  const found: Found = { keys: {}, notes: {}, copies: {}, fellBack: [], quiet: [] }
  // Pushes whose face went through the part.
  let gone = new Set<string>()
  // Keys after each step; a step's key covers everything that can change its result. The face and edge keys a replay
  // finds and the app saves are left out (unkeyed), so saving them keeps the key; a hit checks them instead (fits).
  const keys: string[] = []
  // the shapes base parts were made as change an exact replay's parts, so they are in its key
  // and a replay that asks for exact lofts alone makes other parts than one that asks for none
  let k = req.exact ? hash(meshHash(history.base), JSON.stringify(['exact', !!history.exact, history.base.map((m) => m.primitive ?? 0)])) : req.exactLofts ? hash(meshHash(history.base), 'exactLofts') : meshHash(history.base)
  const baseKey = k
  // a step's lean is laid on its numbers here, so its key, its pattern copies and what follows it see the lean
  const effective = steps.map((s) => withTilt(followed(s, steps)))
  for (const s of effective) {
    k = hash(k, s.suppressed ? `-${s.id}` : JSON.stringify([s.part, s.transform, unkeyed(s.params), s.params.op === 'shape.extrude' && s.params.font ? fontDigest(req.fonts?.[s.params.font]) : 0, s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer' ? (s.follow ?? 0) : 0]))
    keys.push(k)
  }
  // The result kept after step i, when it was made with the keys the steps have now; one made with others goes.
  const known = (i: number): Flat[] | undefined => {
    const key = keys[i]!
    if (!cache.has(key)) return undefined
    if (fits(learnedAt.get(key), effective.slice(0, i + 1))) {
      // its bodies are this replay's to use from here, though the cache may let them go while it runs
      const hit = recall(key)
      for (const p of hit ?? []) if (p.body !== undefined) uses(p.body)
      return hit
    }
    forget(key)
    return undefined
  }
  // Per keyed step: the keys it ran with on this replay or the one kept, and the keys it has once saved.
  const ran: Learned['ran'] = {}
  // Start after the last step whose result is still known, when every step before it went through.
  let start = 0
  let parts: Flat[] = history.base.map(flat)
  // how many parts the steps number, the rest set aside by a turned-off step (numbering.ts)
  let numbered = parts.length
  for (let i = keys.length - 1; i >= 0; i--) {
    const hit = known(i)
    if (hit) {
      start = i + 1
      parts = hit
      const learned = learnedAt.get(keys[i]!)
      numbered = learned?.numbered ?? hit.length
      gone = new Set(learned?.gone)
      Object.assign(moved, learned?.moved)
      Object.assign(found.keys, learned?.keys)
      Object.assign(found.notes, learned?.notes)
      Object.assign(found.copies, learned?.copies)
      Object.assign(ran, learned?.ran)
      break
    }
  }
  cacheStep(baseKey, history.base.map(flat), { gone: new Set(), moved: {}, found: { keys: {}, notes: {}, copies: {}, fellBack: [], quiet: [] }, ran: {} })
  const fonts = req.fonts ?? {}
  let before: Flat[] | undefined = req.before === 0 ? history.base.map(flat) : req.before !== undefined && req.before <= start && req.before > 0 ? known(req.before - 1) : undefined
  for (let i = 0; i < start; i++) {
    if (steps[i]!.suppressed) continue
    status[i] = doneStatus(found, steps[i]!.id)
  }
  for (let i = start; i < effective.length; i++) {
    if (req.before === i) before = parts
    const s = effective[i]!
    if (s.suppressed) {
      // turned off, it still numbers the parts as if it had run, and keeps the parts it would have taken away
      ;({ parts, numbered } = turnedOff(s, { parts, numbered }))
      cacheStep(keys[i]!, parts, { gone, moved, found, ran, numbered })
      continue
    }
    if (o.yieldStep) await o.yieldStep(s)
    try {
      const on = stepParts(s, { parts, numbered })
      const out = s.params.op === 'pattern' ? await patternStep(call, s, effective.slice(0, i), on.parts, fonts, moved, gone, found, req.exact, solids, !!history.exact) : await runStep(call, s, on.parts, fonts, moved, gone, found, req.exact, solids, !!history.exact)
      ;({ parts, numbered } = on.after(out))
      status[i] = doneStatus(found, s.id)
      const had = keysOf(s.params)
      if (had) ran[s.id] = [had, keysOf(withFound(s.params, found.keys[s.id]))]
      cacheStep(keys[i]!, parts, { gone, moved, found, ran, numbered })
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e
      status[i] = { state: 'broken', message: e instanceof Error ? e.message : String(e), ...(e instanceof ExactBroken && e.cause ? { cause: e.cause } : {}) }
      if (req.before !== undefined && req.before > i) before = parts
      break
    }
  }
  // the parts that are meshes, read before the kept bodies are meshed too
  const meshIndices = parts.flatMap((x, i) => (meshPart(x) ? [i] : []))
  // the result's meshes, made now for kept bodies
  parts = await meshedAll(call, parts)
  if (before) before = await meshedAll(call, before)
  const made = madeAfter(steps, keys, status, parts)
  // the solids stay in the cache here: the caller gets meshes, and a project or an undo step never holds one
  return { parts: parts.map(meshOnly), status, moved, ...(Object.keys(found.keys).length ? { found: found.keys } : {}), ...(made ? { madeBy: made } : {}), ...(before ? { before: before.map(meshOnly) } : {}), ...(found.fellBack.length ? { exactFellBack: found.fellBack } : {}), ...(found.quiet.length ? { exactLoftsQuiet: found.quiet } : {}), ...(req.exact ? { meshParts: meshIndices } : {}) }
}

/**
 * The step that made each face of the result, by face key, from the parts kept after each step that went through.
 * Faces of the base are left out. Undefined when a kept result is gone from the cache or the parts have no keys.
 */
function madeAfter(steps: readonly Step[], keys: readonly string[], status: readonly StepStatus[], parts: readonly Flat[]): Record<number, string> | undefined {
  const last = status.reduce((n, st, i) => (st.state === 'done' || st.state === 'suppressed' ? i : n), -1)
  if (last < 0 || !parts.some((p) => p.faces?.keys?.length)) return undefined
  const after: Flat[][] = []
  for (let i = 0; i <= last; i++) {
    const kept = cache.get(keys[i]!)
    if (!kept) return undefined
    // a kept body not tessellated has its keys alone
    after.push(kept.map((p) => (p.unmeshed ? { ...p, faces: { ids: [], table: [], keys: p.unmeshed } } : p)))
  }
  const all = madeBy(steps.slice(0, last + 1), after)
  const out: Record<number, string> = {}
  for (const p of parts) for (const k of p.faces?.keys ?? []) {
    const id = all.get(k)
    if (id) out[k] = id
  }
  return out
}
