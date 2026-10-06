// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// History edits on the plate: replay an object's changed history and land the result in one store
// update (one undo step), with kept dimensions following; open a step for editing (the view rolls
// back to the result before it, quietly, outside undo and saves) and save or cancel that edit; look at
// the part as it was after any step the same way; move a step earlier or later.
// Replays run in the geometry worker; a newer edit of the same object cancels the one running.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { evaluateDimensions, type Dimension, type FaceFrame, type MovedFace } from '../../geom/cad'
import { geom, usesWorker } from '../../geom/client'
import { quietly } from '../../plate/history'
import { get, markStale, set, type CadTool, type PlateEntry } from '../../state/store'
import { objectsFor } from '../dimensions'
import { direction, followField, followFor, followsOf, invert, multiply, point, type History, type HistoryMesh, type ReplayResult, type Step, type StepParams, type StepStatus } from './model'
import { sessionFonts } from './record'
import { replayHistory, type ReplayRequest } from './replay'
import { brandAccent } from '../../edition'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

const abortError = () => Object.assign(new Error('Canceled'), { name: 'AbortError' })

/** Replays in the worker, or with the installed engine when the host gives its own (tests). */
export async function runReplay(req: ReplayRequest, signal?: AbortSignal): Promise<ReplayResult & { before?: HistoryMesh[] }> {
  const full: ReplayRequest = { ...req, fonts: { ...sessionFonts(), ...req.fonts } }
  if (usesWorker()) return geom().call('history.replay', full, signal)
  return replayHistory((op, r) => geom().call(op, r, signal), full, {
    yieldStep: async () => {
      if (signal?.aborted) throw abortError()
    },
  })
}

const toPart = (m: HistoryMesh): MeshPart => ({ name: m.name, slot: m.slot, positions: m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions), indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices) })

/** The steps with each one's broken message from a replay, kept so the list shows it after a reload. */
export function withStatus(steps: readonly Step[], status: readonly StepStatus[]): Step[] {
  return steps.map((s, i) => {
    const st = status[i]
    const { broken: _b, ...rest } = s
    return st?.state === 'broken' ? { ...rest, broken: st.message ?? 'This step failed.' } : rest
  })
}

/**
 * Which push steps changed distance, as moves for dimension.evaluate in the object's world now. A push
 * new to the history (placed before a fillet on its face) moves from where the face was.
 */
function pushMoves(before: History | undefined, after: History, moved: Record<string, MovedFace>, t: number[]): MovedFace[] {
  const out: MovedFace[] = []
  for (const s of after.steps) {
    const was = before?.steps.find((x) => x.id === s.id)
    const m = moved[s.id]
    const from = !before ? null : !was ? 0 : was.params.op === 'face.push' ? was.params.distanceMm : null
    if (s.params.op !== 'face.push' || from === null || !m || from === s.params.distanceMm || s.suppressed) continue
    // From the step's frame into the object's frame now.
    const map = multiply(t, invert(s.transform))
    const n = m.frame.normal
    const at = point(map, [m.frame.origin[0] + n[0] * from, m.frame.origin[1] + n[1] * from, m.frame.origin[2] + n[2] * from])
    const unit = (v: [number, number, number]): [number, number, number] => {
      const l = Math.hypot(...v) || 1
      return [v[0] / l, v[1] / l, v[2] / l]
    }
    out.push({ frame: { origin: at, normal: unit(direction(map, n)), u: unit(direction(map, m.frame.u)), v: unit(direction(map, m.frame.v)) }, outline: m.outline, distanceMm: s.params.distanceMm - from })
  }
  return out
}

const running = new Map<string, AbortController>()

/**
 * Replays `next` on the object and lands it in one store update: parts, the history with broken
 * marks, kept dimensions found again. Throws the broken step's sentence when nothing is left to
 * show (a body whose only step fails), or when the step `need` (a new step) does not go through.
 * A newer call for the same object cancels this one.
 */
export async function applyHistory(host: Loader, objectId: string, next: History, need?: string): Promise<{ status: StepStatus[]; moved: Record<string, MovedFace> }> {
  running.get(objectId)?.abort()
  const ac = new AbortController()
  running.set(objectId, ac)
  try {
    const open = get().historyEdit
    const current = open?.objectId === objectId ? open.original : get().plate.find((p) => p.id === objectId)
    if (!current) throw new Error('That object is gone.')
    const r = await runReplay({ history: next }, ac.signal)
    if (ac.signal.aborted) throw abortError()
    if (r.parts.length === 0) throw new Error(r.status.find((s) => s.state === 'broken')?.message ?? 'Nothing is left of this object.')
    const k = need === undefined ? -1 : next.steps.findIndex((s) => s.id === need)
    if (k >= 0 && r.status[k]?.state !== 'done') throw new Error(r.status[k]?.message ?? 'That did not go through.')
    const parts = r.parts.map(toPart)
    const handle = await host.loadParts(current.name, parts)
    if (ac.signal.aborted) throw abortError()
    const history: History = { ...next, steps: withStatus(next.steps, r.status) }
    const { instanceOf: _was, paint: _paint, ...rest } = current
    const colors = parts.map((_, i) => current.colors[i] ?? current.colors[current.colors.length - 1] ?? brandAccent())
    let entry: PlateEntry = { ...rest, handle, parts, colors, history }
    entry = { ...entry, ...(await followDimensions(entry, pushMoves(current.history, history, r.moved, current.transform))) }
    if (ac.signal.aborted) throw abortError()
    // A step open for editing closes: the rollback goes away outside undo, the result is the edit.
    const still = get().historyEdit
    if (still?.objectId === objectId) quietly(() => set((s) => ({ plate: s.plate.map((e) => (e.id === objectId ? still.original : e)), historyEdit: null })))
    set((s) => ({ plate: s.plate.map((e) => (e.id === objectId ? entry : e)) }))
    markStale()
    return { status: r.status, moved: r.moved }
  } finally {
    if (running.get(objectId) === ac) running.delete(objectId)
  }
}

async function followDimensions(e: PlateEntry, moves: MovedFace[]): Promise<Pick<PlateEntry, 'dimensions'>> {
  const dims = (e.dimensions ?? []).filter((d) => d.a.object === e.id && (!d.b || d.b.object === e.id))
  if (!dims.length) return {}
  try {
    const plate = get().plate.map((p) => (p.id === e.id ? e : p))
    const ev = await evaluateDimensions(dims, objectsFor(plate, dims), moves.map((m) => ({ ...m, object: e.id })))
    const next = new Map(ev.map((r, i) => [dims[i]!.id, { ...dims[i]!, a: r.a, ...(r.b ? { b: r.b } : {}), ...(r.status === 'ok' && r.value !== undefined ? { value: r.value } : {}) } as Dimension]))
    return { dimensions: (e.dimensions ?? []).map((d) => next.get(d.id) ?? d) }
  } catch {
    return {}
  }
}

/** The tool panel that edits a step, or null when the list edits it in place. */
export function toolFor(p: StepParams): CadTool | null {
  if (p.op === 'face.push') return 'push'
  if (p.op === 'sketch.revolve') return 'sketch'
  if (p.op === 'shape.extrude') return p.shape.type === 'sketch' ? 'sketch' : p.shape.type === 'text' ? 'facetext' : p.shape.type === 'svg' ? 'facesvg' : 'shape'
  if (p.op === 'edge.fillet' || p.op === 'edge.chamfer') return 'fillet'
  if (p.op === 'hole.apply') return 'holefit'
  if (p.op === 'thread.apply') return 'thread'
  return null
}

/** Rolls the object back to the result before step `index` and opens the step's tool to edit it. */
export async function beginEdit(host: Loader, objectId: string, index: number): Promise<void> {
  cancelEdit()
  const e = get().plate.find((p) => p.id === objectId)
  const step = e?.history?.steps[index]
  if (!e?.history || !step) throw new Error('That step is gone.')
  const r = await runReplay({ history: e.history, before: index })
  if (!r.before || r.before.length === 0) {
    // A body made by this step has nothing before it: edit on the bed with the object hidden.
    quietly(() => set((s) => ({ historyEdit: { objectId, index, original: e }, plate: s.plate.filter((p) => p.id !== objectId), objectTool: toolFor(step.params) })))
    return
  }
  const parts = r.before.map(toPart)
  const handle = await host.loadParts(e.name, parts)
  const { paint: _p, ...rest } = e
  quietly(() => set((s) => ({ historyEdit: { objectId, index, original: e }, plate: s.plate.map((p) => (p.id === objectId ? { ...rest, parts, handle } : p)), objectTool: toolFor(step.params) })))
}

/**
 * Shows the object as it was right after step `index`, the same quiet way an edit rolls it back, with no
 * tool open. Back to the latest (or any edit) puts it back. The last step is the part as it is now.
 */
export async function viewStep(host: Loader, objectId: string, index: number): Promise<void> {
  cancelEdit()
  const e = get().plate.find((p) => p.id === objectId)
  const h = e?.history
  if (!e || !h || !h.steps[index]) throw new Error('That step is gone.')
  if (index >= h.steps.length - 1) return
  const r = await runReplay({ history: h, before: index + 1 })
  if (!r.before || r.before.length === 0) throw new Error('Nothing of this object is left after that step.')
  const parts = r.before.map(toPart)
  const handle = await host.loadParts(e.name, parts)
  const { paint: _p, ...rest } = e
  quietly(() => set((s) => ({ historyEdit: { objectId, index, original: e, view: true }, plate: s.plate.map((p) => (p.id === objectId ? { ...rest, parts, handle } : p)) })))
}

/**
 * The steps with one moved from `from` to `to`, everything else in order. A step that followed the end
 * face of a step it now comes before keeps its place as it is now (as when that step is deleted).
 */
export function movedSteps(steps: readonly Step[], from: number, to: number): Step[] {
  const out = [...steps]
  const [s] = out.splice(from, 1)
  if (!s) return [...steps]
  out.splice(Math.max(0, Math.min(to, out.length)), 0, s)
  return out.map((x, i) => {
    const keep = followsOf(x).filter((f) => out.findIndex((y) => y.id === f.step) < i)
    if (keep.length === followsOf(x).length) return x
    const { follow: _f, ...r } = x
    return { ...r, ...followField(keep) }
  })
}

/** Moves a step earlier or later and runs the history again; a step that no longer works there says why. */
export function moveStep(host: Loader, objectId: string, from: number, to: number): Promise<{ status: StepStatus[] }> {
  const h = need(objectId)
  return applyHistory(host, objectId, { ...h, steps: movedSteps(h.steps, from, to) })
}

/** Puts the object back as it is and closes the edit. */
export function cancelEdit(): void {
  const open = get().historyEdit
  if (!open) return
  quietly(() =>
    set((s) => {
      const has = s.plate.some((e) => e.id === open.objectId)
      return { plate: has ? s.plate.map((e) => (e.id === open.objectId ? open.original : e)) : [...s.plate, open.original], historyEdit: null }
    }),
  )
}

/** The step open for editing, with its object as it is, or null. */
export function editing(): { entry: PlateEntry; step: Step; index: number } | null {
  const open = get().historyEdit
  const step = open?.original.history?.steps[open.index]
  return open && step ? { entry: open.original, step, index: open.index } : null
}

/**
 * Saves the open step with new params, given in the object's world now, and replays the steps after
 * it. The step keeps its place and id; it is no longer suppressed.
 */
export async function saveEdit(host: Loader, params: StepParams): Promise<{ status: StepStatus[] }> {
  const ed = editing()
  if (!ed) throw new Error('No step is open for editing.')
  const h = ed.entry.history!
  const before = h.steps.slice(0, ed.index)
  const { broken: _b, suppressed: _s, follow: _f, ...keep } = ed.step
  const step: Step = { ...keep, params, transform: [...ed.entry.transform] }
  const follow = followFor(before, step)
  const steps = h.steps.map((s, i) => (i === ed.index ? (follow ? { ...step, follow } : step) : s))
  // A body that was hidden while its step was open comes back for the replay.
  if (!get().plate.some((e) => e.id === ed.entry.id)) quietly(() => set((s) => ({ plate: [...s.plate, ed.entry] })))
  return applyHistory(host, ed.entry.id, { ...h, steps })
}

export function setSuppressed(host: Loader, objectId: string, index: number, suppressed: boolean): Promise<{ status: StepStatus[] }> {
  const h = need(objectId)
  return applyHistory(host, objectId, { ...h, steps: h.steps.map((s, i) => (i === index ? { ...s, suppressed } : s)) })
}

export function deleteStep(host: Loader, objectId: string, index: number): Promise<{ status: StepStatus[] }> {
  const h = need(objectId)
  const gone = h.steps[index]
  // Steps that followed the deleted one's end face keep their place as it is now.
  const without = (s: Step): Step => {
    const keep = followsOf(s).filter((f) => f.step !== gone?.id)
    if (keep.length === followsOf(s).length) return s
    const { follow: _f, ...r } = s
    return { ...r, ...followField(keep) }
  }
  return applyHistory(host, objectId, { ...h, steps: h.steps.filter((_, i) => i !== index).map(without) })
}

export function setParams(host: Loader, objectId: string, index: number, params: StepParams): Promise<{ status: StepStatus[] }> {
  const h = need(objectId)
  return applyHistory(host, objectId, { ...h, steps: h.steps.map((s, i) => (i === index ? { ...s, params } : s)) })
}

function need(objectId: string): History {
  const h = get().plate.find((p) => p.id === objectId)?.history
  if (!h) throw new Error('This object has no history.')
  return h
}

type V3 = [number, number, number]
const unit3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** From a step's world (its transform then) into the object's world now. */
export function nowOf(step: Pick<Step, 'transform'>, transform: number[]): { point: (p: V3) => V3; dir: (d: V3) => V3; frame: (f: FaceFrame) => FaceFrame } {
  const m = multiply(transform, invert(step.transform))
  return {
    point: (p) => point(m, p),
    dir: (d) => unit3(direction(m, d)),
    frame: (f) => ({ origin: point(m, f.origin), normal: unit3(direction(m, f.normal)), u: unit3(direction(m, f.u)), v: unit3(direction(m, f.v)) }),
  }
}
