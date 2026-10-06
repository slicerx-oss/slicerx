// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the tools write history: the object's history with one more step, built from the entry as it
// was before the tool changed it, for the tool's own store update. Ending a history (a split) keeps a
// note and makes the new parts the base. No engine calls in here.
import { setKeySalt } from '../../geom/client'
import { stepSalt } from './salt'
import type { MeshPart } from '@slicerx/contracts'
import type { PlateEntry } from '../../state/store'
import { bindFor } from '../values'
import { currentValues } from '../value-table'
import { direction, followed, followField, followFor, followsOf, HISTORY_VERSION, invert, mainNumber, multiply, onFlatFace, point, refPoints, stepId, type FlatFace, type Follow, type History, type Step, type StepParams } from './model'

// Fonts loaded this session, by name, for text steps that use one. Fonts are not saved in projects.
const fonts = new Map<string, string>()
export function rememberFont(name: string, base64: string): void {
  fonts.set(name, base64)
}
export function sessionFonts(): Record<string, string> {
  return Object.fromEntries(fonts)
}

// The id of the step a tool is about to record, reserved before its engine calls so the faces they make get the
// step's keys (salt.ts); used once by the next recorded step.
let reserved: string | null = null

/** Reserves the id of the next step this tool records, and gives the engine its salt until then. */
export function reserveStepId(): string {
  reserved = stepId()
  setKeySalt(stepSalt(reserved))
  return reserved
}

function takeId(): string {
  const id = reserved ?? stepId()
  reserved = null
  setKeySalt(null)
  return id
}

// What the person typed for the main number of the step a tool is about to record (bindNext), used once.
let pending: string | null = null

/** The text typed for the main number of the next step a tool records, so the step can follow a named value. */
export function bindNext(text: string | undefined): void {
  pending = text?.trim() || null
}

/** The binding for `params` from what was typed (bindNext), if it uses a name and gives the main number. */
export function takeBind(params: StepParams): { bind?: string } {
  const t = pending
  pending = null
  const n = mainNumber(params)
  const bind = t && n ? bindFor(t, n.value, currentValues()) : undefined
  return bind ? { bind } : {}
}

/** The entry's history, or a new one whose base is the entry's parts now. */
export function historyOf(e: Pick<PlateEntry, 'parts' | 'history'>): History {
  return e.history ?? { version: HISTORY_VERSION, base: e.parts, steps: [] }
}

/** Steps that broke, and everything after the first one, did not run; a new step after them suppresses them so the history matches the mesh. */
export function settle(steps: readonly Step[]): Step[] {
  const first = steps.findIndex((s) => s.broken !== undefined && !s.suppressed)
  return first < 0 ? [...steps] : steps.map((s, i) => (i >= first && !s.suppressed ? { ...s, suppressed: true } : s))
}

/**
 * The history after a tool ran `params` on part `part` (-1 for every part) of `before`, the entry
 * as it was. `transform` is the object's transform the params were given in (world values).
 */
export function withStep(before: Pick<PlateEntry, 'parts' | 'history' | 'transform'>, part: number, params: StepParams, transform: number[] = before.transform): History {
  const h = historyOf(before)
  const steps = settle(h.steps)
  const step: Step = { id: takeId(), part, transform: [...transform], params, ...takeBind(params) }
  const follow = followFor(steps, step)
  return { ...h, steps: [...steps, follow ? { ...step, follow } : step] }
}

/** A new body made by a step: empty base, the step first. `transform` is the new object's transform. */
export function bodyHistory(params: StepParams, transform: number[]): History {
  return { version: HISTORY_VERSION, base: [], steps: [{ id: takeId(), part: 0, transform: [...transform], params, ...takeBind(params) }] }
}

/** After an edit that is not a step: no history, or a fresh one starting from `parts` with the reason shown. */
export function endHistory(before: Pick<PlateEntry, 'history'>, parts: MeshPart[], why: string): History | undefined {
  if (!before.history) return undefined
  return { version: HISTORY_VERSION, base: parts, steps: [], ended: `History ends here: ${why}` }
}

/** The entry without a history field when it has none, for spreading into a store update. */
export function historyField(h: History | undefined): { history?: History } {
  return h ? { history: h } : {}
}

type PushParams = Extract<StepParams, { op: 'face.push' }>

const unit = (v: readonly number[]): [number, number, number] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

/** The direction of the end face a step leaves, in the part's frame; null for a step that leaves none. */
function capNormal(s: Step | undefined): [number, number, number] | null {
  const p = s?.params
  if (!s || !p) return null
  if (p.op === 'face.push') return unit(direction(invert(s.transform), p.normal))
  if (p.op === 'shape.extrude' && p.frame) return unit(direction(invert(s.transform), p.frame.normal))
  return null
}

/**
 * A later step whose references sat on the pushed face, as it was before the push (`face`, world at
 * `transform`), follows the push from distance 0: its references move as far as the face did. An end
 * face of an earlier step in the same direction gives way for those references (the push follows that
 * one itself); one of a step after the push keeps them.
 */
function onPushed(s: Step, push: Step & { params: PushParams }, face: FlatFace, transform: number[], steps: readonly Step[], head: ReadonlySet<string>): Step {
  if (s.part !== push.part && s.part !== -1 && push.part !== -1) return s
  const pts = refPoints(followed(s, steps).params)
  const now = multiply(transform, invert(s.transform))
  let on = pts.flatMap((q, k) => (onFlatFace(point(now, q), face).inside ? [k] : []))
  const edges = s.params.op === 'edge.fillet' || s.params.op === 'edge.chamfer'
  const n = capNormal(push)!
  const same = (f: Follow) => {
    const ln = capNormal(steps.find((x) => x.id === f.step))
    return ln !== null && Math.abs(ln[0] * n[0] + ln[1] * n[1] + ln[2] * n[2]) > 0.999
  }
  for (const f of followsOf(s)) if (same(f) && !head.has(f.step)) on = on.filter((k) => f.points && !f.points.includes(k))
  if (!on.length || (!edges && on.length < pts.length)) return s
  const list: Follow[] = []
  for (const f of followsOf(s)) {
    if (!same(f) || !head.has(f.step)) {
      list.push(f)
      continue
    }
    const left = (f.points ?? pts.map((_, k) => k)).filter((k) => !on.includes(k))
    if (left.length) list.push({ ...f, points: left })
  }
  list.push(on.length === pts.length ? { step: push.id, distanceMm: 0 } : { step: push.id, distanceMm: 0, points: on })
  const { follow: _f, ...rest } = s
  return { ...rest, ...followField(list) }
}

/**
 * The history with a push placed before step `index` rather than at the end: the push of a face whose
 * edge a fillet or chamfer from that step on rounds. The push runs on the body as it was before the
 * round, and the round runs again on the moved edge, so nothing of the old round is left standing.
 * `face` is the pushed face as it was before step `index` (world at `transform`); the references of
 * the later steps on it follow the push.
 */
export function withPushBefore(before: Pick<PlateEntry, 'parts' | 'history' | 'transform'>, part: number, params: PushParams, index: number, face: FlatFace, transform: number[] = before.transform): History {
  const h = historyOf(before)
  const steps = settle(h.steps)
  const head = steps.slice(0, index)
  const step = { id: stepId(), part, transform: [...transform], params }
  const follow = followFor(head, step)
  const push = follow ? { ...step, follow } : step
  const ids = new Set(head.map((s) => s.id))
  return { ...h, steps: [...head, push, ...steps.slice(index).map((s) => onPushed(s, push, face, transform, steps, ids))] }
}
