// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One design timeline for the plate (docs/cad-history.md, "Timeline"), the way Fusion keeps one: sketches and
// features in the order they were made, across every body, and a marker that rolls it back. A feature names its
// sketch by id instead of holding a copy. An object's own history is a view of it, filtered by body, so replay
// and the app's per-object tools work unchanged.
import type { History, HistoryMesh, Step, StepParams } from './model'
import type { FaceFrame, SketchLoop } from './types'

/** A sketch on a plane: the bed when frame is absent. Constraints ride as the solver keeps them (sketch.solve). */
export interface SketchItem {
  kind: 'sketch'
  id: string
  name: string
  frame?: FaceFrame
  loops: SketchLoop[]
  constraints?: unknown[]
}

type Extrude = Extract<StepParams, { op: 'shape.extrude' }>
type Revolve = Extract<StepParams, { op: 'sketch.revolve' }>

/** An extrude or revolve of a sketch item, with its plane and loops left to the sketch. */
export type SketchUse = Omit<Extrude, 'frame' | 'shape'> | Omit<Revolve, 'frame' | 'loops'>

/** A step on one body. With `sketch` set, params are a SketchUse and the sketch gives the rest. */
export interface FeatureItem extends Omit<Step, 'params'> {
  kind: 'feature'
  body: string
  sketch?: string
  params: StepParams | SketchUse
}

export type Item = SketchItem | FeatureItem

/** A body: the object it prints as, the parts it started from (none for one a feature made). */
export interface Body {
  id: string
  base: HistoryMesh[]
  ended?: string
}

export interface Timeline {
  bodies: Body[]
  items: Item[]
  /** Items before it are live; dragging it back rolls the design back. */
  marker: number
}

/** When a step was made, from its id (`stepId`: s, 8 base 36 digits of Date.now, then a counter). Null for other ids. */
export function madeAt(id: string): { time: number; seq: number } | null {
  const m = /^s([0-9a-z]{8})([0-9a-z]+)$/.exec(id)
  if (!m) return null
  return { time: parseInt(m[1]!, 36), seq: parseInt(m[2]!, 36) }
}

const isSketch = (p: StepParams): p is (Extrude & { shape: { type: 'sketch' } }) | Revolve => (p.op === 'shape.extrude' && p.shape.type === 'sketch') || p.op === 'sketch.revolve'

/** The sketch a step drew on, and the step left naming it. */
function split(s: Step, body: string, name: string): [SketchItem, FeatureItem] {
  const id = `${s.id}k`
  const p = s.params as (Extrude & { shape: { type: 'sketch'; loops: SketchLoop[]; constraints?: unknown[] } }) | (Revolve & { constraints?: unknown[] })
  const loops = p.op === 'shape.extrude' ? p.shape.loops : p.loops
  const constraints = p.op === 'shape.extrude' ? p.shape.constraints : p.constraints
  const sketch: SketchItem = { kind: 'sketch', id, name, ...(p.frame ? { frame: p.frame } : {}), loops, ...(constraints ? { constraints } : {}) }
  let use: SketchUse
  if (p.op === 'shape.extrude') {
    const { frame: _f, shape: _s, ...rest } = p
    use = rest
  } else {
    const { frame: _f, loops: _l, constraints: _c, ...rest } = p
    use = rest
  }
  return [sketch, { ...s, kind: 'feature', body, sketch: id, params: use }]
}

/**
 * The design of a plate whose objects each kept their own history (files before version 3): every step merged into
 * one timeline by when it was made, each object's steps staying in their own order, and every sketch an extrude or
 * revolve drew on made its own item, named Sketch 1, Sketch 2 and on in timeline order.
 */
export function timelineOf(objects: readonly { id: string; history: History }[]): Timeline {
  const lists = objects.map((o) => {
    // a step without a readable time sorts right after the one before it
    let last = { time: -Infinity, seq: 0 }
    return o.history.steps.map((s) => (last = madeAt(s.id) ?? last))
  })
  const at = objects.map(() => 0)
  const items: Item[] = []
  let sketches = 0
  for (;;) {
    let pick = -1
    for (let i = 0; i < objects.length; i++) {
      if (at[i]! >= objects[i]!.history.steps.length) continue
      if (pick < 0) {
        pick = i
        continue
      }
      const a = lists[i]![at[i]!]!
      const b = lists[pick]![at[pick]!]!
      if (a.time < b.time || (a.time === b.time && a.seq < b.seq)) pick = i
    }
    if (pick < 0) break
    const o = objects[pick]!
    const s = o.history.steps[at[pick]!++]!
    if (isSketch(s.params)) items.push(...split(s, o.id, `Sketch ${++sketches}`))
    else items.push({ ...s, kind: 'feature', body: o.id })
  }
  const bodies = objects.map((o) => ({ id: o.id, base: o.history.base, ...(o.history.ended ? { ended: o.history.ended } : {}) }))
  return { bodies, items, marker: items.length }
}

/** A feature's params with its sketch put back in, as the engine and replay take them. Null when the sketch is gone. */
export function featureParams(f: FeatureItem, sketches: ReadonlyMap<string, SketchItem>): StepParams | null {
  if (!f.sketch) return f.params as StepParams
  const k = sketches.get(f.sketch)
  if (!k) return null
  const frame = k.frame ? { frame: k.frame } : {}
  const p = f.params as SketchUse
  if (p.op === 'shape.extrude') return { ...p, ...frame, shape: { type: 'sketch', loops: k.loops, ...(k.constraints ? { constraints: k.constraints } : {}) } } as Extrude
  return { ...p, ...frame, loops: k.loops, ...(k.constraints ? { constraints: k.constraints } : {}) } as Revolve
}

/** A body's history as its object keeps it: the live features on it, in timeline order, with their sketches in. */
export function historyOf(d: Timeline, body: string): History | null {
  const b = d.bodies.find((x) => x.id === body)
  if (!b) return null
  const live = d.items.slice(0, d.marker)
  const sketches = new Map(live.filter((i): i is SketchItem => i.kind === 'sketch').map((k) => [k.id, k]))
  const steps: Step[] = []
  for (const i of live) {
    if (i.kind !== 'feature' || i.body !== body) continue
    const params = featureParams(i, sketches)
    if (!params) return null
    const { kind: _k, body: _b, sketch: _s, ...step } = i
    steps.push({ ...step, params })
  }
  return { version: 1, base: b.base, steps, ...(b.ended ? { ended: b.ended } : {}) }
}

/** Every body's history, by body id. */
export function historiesOf(d: Timeline): Map<string, History> {
  const out = new Map<string, History>()
  for (const b of d.bodies) {
    const h = historyOf(d, b.id)
    if (h) out.set(b.id, h)
  }
  return out
}
