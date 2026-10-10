// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replays an object's history on its base (docs/cad-history.md). Runs in the geometry worker
// (geom-worker.ts, op history.replay) with the engine called directly, and in tests with any engine
// provider. Steps run in order; the first one that fails is marked broken with the engine's sentence,
// every later one is skipped, and the parts are the result just before it. The parts after each step
// are kept from the last replays, so an edit of step k starts at k.
import type { EdgeRef, MovedFace } from '../../geom/cad'
import { bakeMesh, findByKey, findTriangle, followed, followsOf, hasFaceOn, invert, keyOfTriangle, type History, type HistoryMesh, type ReplayResult, type Step, type StepStatus } from './model'
import { stepSalt } from './salt'

export type EngineCall = (op: string, request: unknown) => Promise<unknown>

export interface ReplayRequest {
  history: History
  /** Font files by name, for text steps that use one. */
  fonts?: Record<string, string>
  /** Also return the parts as they were before this step index (rolling the view back to edit it). */
  before?: number
}

export interface ReplayOptions {
  /** Called between steps; throw to stop (a newer edit arrived). */
  yieldStep?: () => Promise<void>
}

type Faces = NonNullable<HistoryMesh['faces']>

interface Flat {
  name: string
  slot: number
  positions: number[]
  indices: number[]
  /** The engine's faces with their keys, carried from step to step as the tools carry them. */
  faces?: Faces
}

/** Positions rounded to f32, as the app keeps them (Float32Array). */
const asStored = (p: ArrayLike<number>): number[] => Array.from(p, Math.fround)

const flat = (m: HistoryMesh): Flat => ({ name: m.name, slot: m.slot, positions: Array.from(m.positions), indices: Array.from(m.indices), ...(m.faces ? { faces: m.faces } : {}) })

/** The part with a step's result mesh, its faces with it. */
const next = (part: Flat, m: { positions: number[]; indices: number[]; faces?: Faces }): Flat => {
  const { faces: _old, ...rest } = part
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
}
// What was learned up to each cached step, by the same keys.
const learnedAt = new Map<string, Learned>()
let cachedNumbers = 0
const CACHE_NUMBERS = 24_000_000

function remember(key: string, parts: Flat[], learned: { gone: ReadonlySet<string>; moved: Record<string, MovedFace>; found: Found }): void {
  if (cache.has(key)) return
  learnedAt.set(key, { gone: [...learned.gone], moved: { ...learned.moved }, keys: { ...learned.found.keys }, notes: { ...learned.found.notes } })
  const size = parts.reduce((n, p) => n + p.positions.length + p.indices.length, 0)
  cache.set(key, parts)
  cachedNumbers += size
  for (const [k, v] of cache) {
    if (cachedNumbers <= CACHE_NUMBERS) break
    cache.delete(k)
    learnedAt.delete(k)
    cachedNumbers -= v.reduce((n, p) => n + p.positions.length + p.indices.length, 0)
  }
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
  cache.clear()
  learnedAt.clear()
  digests = new WeakMap()
  cachedNumbers = 0
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
    d = `${p.name}|${p.slot}|${numbersDigest(p.positions)}|${numbersDigest(p.indices)}`
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

class Broken extends Error {}

const meshOf = (p: Flat) => ({ positions: p.positions, indices: p.indices, ...(p.faces ? { faces: p.faces } : {}) })

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
  keys: Record<string, { faceKey?: number; openKeys?: number[]; edgeKeys?: ([number, number] | null)[] }>
  notes: Record<string, string>
}

async function runStep(engine: EngineCall, s: Step, parts: Flat[], fonts: Record<string, string>, moved: Record<string, MovedFace>, gone: Set<string>, found: Found): Promise<Flat[]> {
  const p = s.params
  // Every call of the step makes its faces' keys from the step's own salt, as when the tool first ran it.
  const call: EngineCall = (op, r) => engine(op, { ...(r as object), keySalt: stepSalt(s.id), withFaces: true })
  const targets = s.part === -1 ? parts.map((_, i) => i) : [s.part]
  const out = parts.slice()
  const item = (f: Flat) => ({ mesh: meshOf(f), transform: s.transform })
  const local = (m: { positions: number[]; indices: number[] }, like: Pick<Flat, 'name' | 'slot'>): Flat => flat(bakeMesh({ ...like, ...m }, invert(s.transform)))
  const newBody = (p.op === 'shape.extrude' && (p.spec.operation ?? 'new') === 'new') || (p.op === 'sketch.revolve' && (p.operation ?? 'new') === 'new')
  if (p.op === 'parts.add') return [...out, ...p.parts.map(flat)]
  if (newBody) {
    const name = (p.op === 'shape.extrude' || p.op === 'sketch.revolve') && p.name ? p.name : 'Body'
    const req = p.op === 'shape.extrude' ? { frame: p.frame, shape: p.shape, placement: p.placement ?? {}, spec: p.spec, ...(p.font ? { fontBase64: font(p.font, fonts) } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) } : { frame: p.frame, loops: p.loops, axis: p.axis, angleDeg: p.angleDeg, operation: 'new' }
    const r = (await call(p.op, req)) as { mesh: { positions: number[]; indices: number[] } }
    const body = local(r.mesh, { name, slot: out[s.part]?.slot ?? 1 })
    if (s.part < out.length) out[s.part] = body
    else out.push(body)
    return out
  }
  for (const i of targets) {
    const part = out[i]
    if (!part) throw new Broken('The part this step works on is gone.')
    switch (p.op) {
      case 'face.push': {
        // By the face's key first, then by where it was.
        const byKey = p.faceKey ? findByKey(part, s.transform, p.faceKey, p.at) : null
        const triangle = byKey ? byKey.triangle : findTriangle(part, s.transform, p.at, p.normal)
        if (triangle < 0) throw new Broken('The face this step moved is gone.')
        if (byKey?.split) found.notes[s.id] = 'The face this step moved was split in two; picked the larger part.'
        const key = keyOfTriangle(part, triangle)
        if (key && key !== p.faceKey) found.keys[s.id] = { faceKey: key }
        const r = (await call('face.push', { mesh: item(part), triangle, at: byKey ? byKey.at : p.at, distanceMm: p.distanceMm })) as { mesh: Flat; moved: MovedFace }
        moved[s.id] = r.moved
        out[i] = next(part, r.mesh)
        // No face is left where it moved to: it went through the part, and the edges on it with it.
        const l = Math.hypot(...p.normal) || 1
        const cap: [number, number, number] = [p.at[0] + (p.normal[0] / l) * p.distanceMm, p.at[1] + (p.normal[1] / l) * p.distanceMm, p.at[2] + (p.normal[2] / l) * p.distanceMm]
        if (!hasFaceOn(out[i]!, s.transform, cap, p.normal)) gone.add(s.id)
        break
      }
      case 'shape.extrude':
      case 'sketch.revolve': {
        const req = p.op === 'shape.extrude' ? { frame: p.frame, shape: p.shape, placement: p.placement ?? {}, spec: p.spec, target: item(part), ...(p.font ? { fontBase64: font(p.font, fonts) } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) } : { frame: p.frame, loops: p.loops, axis: p.axis, angleDeg: p.angleDeg, operation: p.operation, target: item(part) }
        const r = (await call(p.op, req)) as { mesh: Flat; report: { touches: boolean } }
        if (!r.report.touches) throw new Broken('The shape no longer reaches the part.')
        out[i] = next(part, r.mesh)
        break
      }
      case 'subtract': {
        const world = bakeMesh(part, s.transform)
        // in world space as the tool sends it: baked to f32 (plate/mesh-ops.ts bake)
        const r = (await call('subtract', { mesh: { positions: asStored(world.positions), indices: world.indices }, solids: p.solids })) as { mesh: Flat; removedVolumeMm3: number }
        if (!(r.removedVolumeMm3 > 0)) throw new Broken('The shape no longer reaches the part.')
        out[i] = local(r.mesh, part)
        break
      }
      case 'hollow':
      case 'repair':
      case 'simplify': {
        const options = p.op === 'hollow' ? { wallMm: p.wallMm } : p.op === 'simplify' ? { targetRatio: p.targetRatio } : {}
        const r = (await call(p.op, { mesh: meshOf(part), options })) as { mesh: Flat }
        out[i] = next(part, r.mesh)
        break
      }
      case 'array.merged': {
        const r = (await call('array', { mesh: item(part), spec: p.spec, merge: true, options: {} })) as { mesh: Flat }
        out[i] = next(part, r.mesh)
        break
      }
      case 'hole.apply': {
        // The engine finds the hole again on the part as it is now, or says it is gone.
        let r: { mesh: Flat }
        try {
          r = (await call('hole.apply', { mesh: item(part), hole: p.hole, spec: p.spec })) as { mesh: Flat }
        } catch (err) {
          const why = (err instanceof Error ? err.message : String(err)).replace(/^hole: /, '')
          throw new Broken(why.charAt(0).toUpperCase() + why.slice(1))
        }
        out[i] = next(part, r.mesh)
        break
      }
      case 'shell': {
        // The open faces are found again by their keys, or by their place and normal, on the part as it is now.
        let r: { mesh: Flat; report: { openKeys?: number[] } }
        try {
          r = (await call('shell', { mesh: item(part), open: p.open, wallMm: p.wallMm })) as { mesh: Flat; report: { openKeys?: number[] } }
        } catch (err) {
          const why = (err instanceof Error ? err.message : String(err)).replace(/^(shell|open|wallMm): /, '')
          throw new Broken(why.charAt(0).toUpperCase() + why.slice(1))
        }
        const keys = r.report.openKeys ?? []
        if (keys.some((k, j) => k && k !== p.open[j]?.key)) found.keys[s.id] = { openKeys: keys }
        out[i] = next(part, r.mesh)
        break
      }
      case 'thread.apply': {
        // A hole's wall is found again on the part as it is now; a rod or boss keeps its place.
        let r: { mesh: Flat }
        try {
          r = (await call('thread.apply', { mesh: item(part), thread: p.thread, spec: p.spec })) as { mesh: Flat }
        } catch (err) {
          const why = (err instanceof Error ? err.message : String(err)).replace(/^(thread|hole): /, '')
          throw new Broken(why.charAt(0).toUpperCase() + why.slice(1))
        }
        out[i] = next(part, r.mesh)
        break
      }
      case 'edge.fillet':
      case 'edge.chamfer': {
        const { op: _op, ...rest } = p
        const edges = keptEdges(s, p.edges, gone)
        if (!edges.length) break
        const r = (await call(p.op, { mesh: item(part), ...rest, edges })) as { mesh: Flat; refs?: EdgeRef[]; notes?: string[] }
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
        if (changed) found.keys[s.id] = { edgeKeys: keys }
        if (r.notes?.length) found.notes[s.id] = r.notes.map((n) => n.charAt(0).toUpperCase() + n.slice(1)).join('. ') + '.'
        out[i] = next(part, r.mesh)
        break
      }
    }
  }
  return out
}

function font(name: string, fonts: Record<string, string>): string {
  const f = fonts[name]
  if (!f) throw new Broken(`Pick the font again: ${name} is not loaded.`)
  return f
}

/** Runs the history and says, per step, what happened. */
export async function replayHistory(call: EngineCall, req: ReplayRequest, o: ReplayOptions = {}): Promise<ReplayResult & { before?: HistoryMesh[] }> {
  const { history } = req
  const steps = history.steps
  const status: StepStatus[] = steps.map((s) => (s.suppressed ? { state: 'suppressed' } : { state: 'skipped' }))
  const moved: Record<string, MovedFace> = {}
  const found: Found = { keys: {}, notes: {} }
  // Pushes whose face went through the part.
  let gone = new Set<string>()
  // Keys after each step; a step's key covers everything that can change its result.
  const keys: string[] = []
  let k = meshHash(history.base)
  const baseKey = k
  const effective = steps.map((s) => followed(s, steps))
  for (const s of effective) {
    k = hash(k, s.suppressed ? `-${s.id}` : JSON.stringify([s.part, s.transform, s.params, s.params.op === 'shape.extrude' && s.params.font ? fontDigest(req.fonts?.[s.params.font]) : 0, s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer' ? (s.follow ?? 0) : 0]))
    keys.push(k)
  }
  // Start after the last step whose result is still known, when every step before it went through.
  let start = 0
  let parts: Flat[] = history.base.map(flat)
  for (let i = keys.length - 1; i >= 0; i--) {
    const hit = recall(keys[i]!)
    if (hit) {
      start = i + 1
      parts = hit
      const learned = learnedAt.get(keys[i]!)
      gone = new Set(learned?.gone)
      Object.assign(moved, learned?.moved)
      Object.assign(found.keys, learned?.keys)
      Object.assign(found.notes, learned?.notes)
      break
    }
  }
  remember(baseKey, history.base.map(flat), { gone: new Set(), moved: {}, found: { keys: {}, notes: {} } })
  const fonts = req.fonts ?? {}
  let before: Flat[] | undefined = req.before === 0 ? history.base.map(flat) : req.before !== undefined && req.before <= start && req.before > 0 ? recall(keys[req.before - 1]!) : undefined
  for (let i = 0; i < start; i++) {
    if (steps[i]!.suppressed) continue
    const note = found.notes[steps[i]!.id]
    status[i] = note ? { state: 'done', note } : { state: 'done' }
  }
  for (let i = start; i < effective.length; i++) {
    if (req.before === i) before = parts
    const s = effective[i]!
    if (s.suppressed) {
      remember(keys[i]!, parts, { gone, moved, found })
      continue
    }
    if (o.yieldStep) await o.yieldStep()
    try {
      parts = await runStep(call, s, parts, fonts, moved, gone, found)
      const note = found.notes[s.id]
      status[i] = note ? { state: 'done', note } : { state: 'done' }
      remember(keys[i]!, parts, { gone, moved, found })
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e
      status[i] = { state: 'broken', message: e instanceof Error ? e.message : String(e) }
      if (req.before !== undefined && req.before > i) before = parts
      break
    }
  }
  return { parts, status, moved, ...(Object.keys(found.keys).length ? { found: found.keys } : {}), ...(before ? { before } : {}) }
}
