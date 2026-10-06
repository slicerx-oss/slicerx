// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replays an object's history on its base (docs/cad-history.md). Runs in the geometry worker
// (geom-worker.ts, op history.replay) with the engine called directly, and in tests with any engine
// provider. Steps run in order; the first one that fails is marked broken with the engine's sentence,
// every later one is skipped, and the parts are the result just before it. The parts after each step
// are kept from the last replays, so an edit of step k starts at k.
import type { MovedFace } from '../../geom/cad'
import { bakeMesh, findTriangle, followed, followsOf, hasFaceOn, invert, type History, type HistoryMesh, type ReplayResult, type Step, type StepStatus } from './model'

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

interface Flat {
  name: string
  slot: number
  positions: number[]
  indices: number[]
}

const flat = (m: HistoryMesh): Flat => ({ name: m.name, slot: m.slot, positions: Array.from(m.positions), indices: Array.from(m.indices) })

// Parts after each step, by a hash of the base and every step up to it. Bounded by the numbers held.
const cache = new Map<string, Flat[]>()
// The pushes that went through the part up to each cached step, by the same keys.
const goneAt = new Map<string, string[]>()
let cachedNumbers = 0
const CACHE_NUMBERS = 24_000_000

function remember(key: string, parts: Flat[], gone: ReadonlySet<string>): void {
  if (cache.has(key)) return
  if (gone.size) goneAt.set(key, [...gone])
  const size = parts.reduce((n, p) => n + p.positions.length + p.indices.length, 0)
  cache.set(key, parts)
  cachedNumbers += size
  for (const [k, v] of cache) {
    if (cachedNumbers <= CACHE_NUMBERS) break
    cache.delete(k)
    goneAt.delete(k)
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
  goneAt.clear()
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

function meshHash(parts: readonly HistoryMesh[]): string {
  // The base is identified by its sizes and a sample of its numbers; it never changes in place.
  let s = `${parts.length}`
  for (const p of parts) {
    s += `|${p.name}|${p.slot}|${p.positions.length}|${p.indices.length}`
    const step = Math.max(1, Math.floor(p.positions.length / 64))
    for (let i = 0; i < p.positions.length; i += step) s += `,${p.positions[i]}`
  }
  return hash('', s)
}

class Broken extends Error {}

const meshOf = (p: Flat) => ({ positions: p.positions, indices: p.indices })

/**
 * The edges of a fillet or chamfer step that are still there: an edge whose ends both sat on a face a
 * push took all the way through (a pocket floor pushed out the bottom) went with that face.
 */
function keptEdges<E>(s: Step, edges: readonly E[], gone: ReadonlySet<string>): E[] {
  const through = followsOf(s).filter((f) => gone.has(f.step))
  return edges.filter((_, i) => !through.some((f) => !f.points || (f.points.includes(2 * i) && f.points.includes(2 * i + 1))))
}

async function runStep(call: EngineCall, s: Step, parts: Flat[], fonts: Record<string, string>, moved: Record<string, MovedFace>, gone: Set<string>): Promise<Flat[]> {
  const p = s.params
  const targets = s.part === -1 ? parts.map((_, i) => i) : [s.part]
  const out = parts.slice()
  const item = (f: Flat) => ({ mesh: meshOf(f), transform: s.transform })
  const local = (m: { positions: number[]; indices: number[] }, like: Pick<Flat, 'name' | 'slot'>): Flat => flat(bakeMesh({ ...like, ...m }, invert(s.transform)))
  const newBody = (p.op === 'shape.extrude' && (p.spec.operation ?? 'new') === 'new') || (p.op === 'sketch.revolve' && (p.operation ?? 'new') === 'new')
  if (p.op === 'parts.add') return [...out, ...p.parts.map(flat)]
  if (newBody) {
    const name = (p.op === 'shape.extrude' || p.op === 'sketch.revolve') && p.name ? p.name : 'Body'
    const req = p.op === 'shape.extrude' ? { frame: p.frame, shape: p.shape, placement: p.placement ?? {}, spec: p.spec, ...(p.font ? { fontBase64: font(p.font, fonts) } : {}) } : { frame: p.frame, loops: p.loops, axis: p.axis, angleDeg: p.angleDeg, operation: 'new' }
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
        const triangle = findTriangle(part, s.transform, p.at, p.normal)
        if (triangle < 0) throw new Broken('The face this step moved is gone.')
        const r = (await call('face.push', { mesh: item(part), triangle, at: p.at, distanceMm: p.distanceMm })) as { mesh: Flat; moved: MovedFace }
        moved[s.id] = r.moved
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
        // No face is left where it moved to: it went through the part, and the edges on it with it.
        const l = Math.hypot(...p.normal) || 1
        const cap: [number, number, number] = [p.at[0] + (p.normal[0] / l) * p.distanceMm, p.at[1] + (p.normal[1] / l) * p.distanceMm, p.at[2] + (p.normal[2] / l) * p.distanceMm]
        if (!hasFaceOn(out[i]!, s.transform, cap, p.normal)) gone.add(s.id)
        break
      }
      case 'shape.extrude':
      case 'sketch.revolve': {
        const req = p.op === 'shape.extrude' ? { frame: p.frame, shape: p.shape, placement: p.placement ?? {}, spec: p.spec, target: item(part), ...(p.font ? { fontBase64: font(p.font, fonts) } : {}) } : { frame: p.frame, loops: p.loops, axis: p.axis, angleDeg: p.angleDeg, operation: p.operation, target: item(part) }
        const r = (await call(p.op, req)) as { mesh: Flat; report: { touches: boolean } }
        if (!r.report.touches) throw new Broken('The shape no longer reaches the part.')
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
        break
      }
      case 'subtract': {
        const world = bakeMesh(part, s.transform)
        const r = (await call('subtract', { mesh: { positions: world.positions, indices: world.indices }, solids: p.solids })) as { mesh: Flat; removedVolumeMm3: number }
        if (!(r.removedVolumeMm3 > 0)) throw new Broken('The shape no longer reaches the part.')
        out[i] = local(r.mesh, part)
        break
      }
      case 'hollow':
      case 'repair':
      case 'simplify': {
        const options = p.op === 'hollow' ? { wallMm: p.wallMm } : p.op === 'simplify' ? { targetRatio: p.targetRatio } : {}
        const r = (await call(p.op, { mesh: meshOf(part), options })) as { mesh: Flat }
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
        break
      }
      case 'array.merged': {
        const r = (await call('array', { mesh: item(part), spec: p.spec, merge: true, options: {} })) as { mesh: Flat }
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
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
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
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
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
        break
      }
      case 'edge.fillet':
      case 'edge.chamfer': {
        const { op: _op, ...rest } = p
        const edges = keptEdges(s, p.edges, gone)
        if (!edges.length) break
        const r = (await call(p.op, { mesh: item(part), ...rest, edges })) as { mesh: Flat }
        out[i] = { ...part, positions: r.mesh.positions, indices: r.mesh.indices }
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
  // Pushes whose face went through the part.
  let gone = new Set<string>()
  // Keys after each step; a step's key covers everything that can change its result.
  const keys: string[] = []
  let k = meshHash(history.base)
  const baseKey = k
  const effective = steps.map((s) => followed(s, steps))
  for (const s of effective) {
    k = hash(k, s.suppressed ? `-${s.id}` : JSON.stringify([s.part, s.transform, s.params, s.params.op === 'shape.extrude' && s.params.font ? Boolean(req.fonts?.[s.params.font]) : 0, s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer' ? (s.follow ?? 0) : 0]))
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
      gone = new Set(goneAt.get(keys[i]!))
      break
    }
  }
  remember(baseKey, history.base.map(flat), new Set())
  const fonts = req.fonts ?? {}
  let before: Flat[] | undefined = req.before === 0 ? history.base.map(flat) : req.before !== undefined && req.before <= start && req.before > 0 ? recall(keys[req.before - 1]!) : undefined
  for (let i = 0; i < start; i++) if (!steps[i]!.suppressed) status[i] = { state: 'done' }
  for (let i = start; i < effective.length; i++) {
    if (req.before === i) before = parts
    const s = effective[i]!
    if (s.suppressed) {
      remember(keys[i]!, parts, gone)
      continue
    }
    if (o.yieldStep) await o.yieldStep()
    try {
      parts = await runStep(call, s, parts, fonts, moved, gone)
      status[i] = { state: 'done' }
      remember(keys[i]!, parts, gone)
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw e
      status[i] = { state: 'broken', message: e instanceof Error ? e.message : String(e) }
      if (req.before !== undefined && req.before > i) before = parts
      break
    }
  }
  return { parts, status, moved, ...(before ? { before } : {}) }
}
