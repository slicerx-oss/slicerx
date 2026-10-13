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
function split(s: Step, body: string, name: string, items: readonly Item[] = []): [SketchItem, FeatureItem] {
  // a pasted copy keeps its original's step ids, so its sketches take the next free id
  let id = `${s.id}k`
  for (let n = 2; items.some((i) => i.kind === 'sketch' && i.id === id); n++) id = `${s.id}k${n}`
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

/** A step as a feature on `body`; with a sketch id, its plane and loops are left to that sketch. */
export function featureOf(s: Step, body: string, sketch?: string): FeatureItem {
  if (sketch === undefined || !isSketch(s.params)) return { ...s, kind: 'feature', body }
  return { ...split(s, body, '')[1], sketch }
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
    if (isSketch(s.params)) items.push(...split(s, o.id, `Sketch ${++sketches}`, items))
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
    const { kind: _k, body: _b, ...step } = i
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

/** The next free Sketch N name. */
function nextName(items: readonly Item[]): string {
  let n = 0
  for (const i of items) if (i.kind === 'sketch') n = Math.max(n, Number(/^Sketch (\d+)$/.exec(i.name)?.[1] ?? 0))
  return `Sketch ${n + 1}`
}

/**
 * The timeline after a tool changed one body's history (the tools still record per object): a step kept stays where
 * it is, a step edited in place keeps its sketch (which takes the new plane and loops), a removed step goes (its
 * sketch stays, as in Fusion; one past the marker is only rolled back and stays). A new last step goes in at the
 * marker, as a new feature does in Fusion; one put in between goes right after the body's step before it.
 */
export function withHistory(t: Timeline, body: string, h: History): Timeline {
  const next = new Map(h.steps.map((s) => [s.id, s]))
  const items: Item[] = []
  const atEnd = t.marker >= t.items.length
  let marker = 0
  const sketchAt = new Map<string, number>()
  const place = new Map<string, number>()
  t.items.forEach((it, i) => {
    if (it.kind === 'feature' && it.body === body) {
      const s = next.get(it.id)
      // a step past the marker is rolled back, not removed: a tool working at the marker never sees it
      if (!s && i >= t.marker) {
        items.push(it)
        place.set(it.id, items.length - 1)
      } else if (s) {
        if (isSketch(s.params)) {
          const [k, f] = split(s, body, '', [...t.items, ...items])
          const own = it.sketch !== undefined ? sketchAt.get(it.sketch) : undefined
          if (own !== undefined) {
            const old = items[own] as SketchItem
            const { frame: _f, constraints: _c, ...keep } = old
            items[own] = { ...keep, loops: k.loops, ...(k.frame ? { frame: k.frame } : {}), ...(k.constraints ? { constraints: k.constraints } : {}) }
            items.push({ ...f, sketch: old.id })
          } else items.push({ ...k, name: nextName(items) }, f)
        } else items.push({ ...s, kind: 'feature', body })
        place.set(s.id, items.length - 1)
      }
    } else {
      if (it.kind === 'sketch') sketchAt.set(it.id, items.length)
      items.push(it)
    }
    if (i < t.marker) marker = items.length
  })
  h.steps.forEach((s, k) => {
    if (place.has(s.id)) return
    // drawn on a sketch the timeline has (a finished sketch): the feature names it, and the sketch takes the plane and loops
    // a pasted copy's step keeps its original's id: the copy gets a sketch of its own, not a share of the original's
    const copy = t.items.some((i) => i.kind === 'feature' && i.id === s.id && i.body !== body)
    const on = isSketch(s.params) && s.sketch !== undefined && !copy ? items.findIndex((i) => i.kind === 'sketch' && i.id === s.sketch) : -1
    const before = h.steps[k - 1]
    const after = before ? place.get(before.id) : undefined
    const later = h.steps.slice(k + 1).map((x) => place.get(x.id)).find((p) => p !== undefined)
    let at = atEnd ? items.length : marker
    if (later !== undefined && after !== undefined) at = after + 1
    else if (later !== undefined) {
      // first of the body: before the next step and its sketch
      const f = items[later] as FeatureItem
      at = f.sketch !== undefined && items[later - 1]?.kind === 'sketch' && items[later - 1]!.id === f.sketch ? later - 1 : later
    }
    if (on >= 0) {
      const [k] = split(s, body, '', items)
      const { frame: _f, constraints: _c, ...keep } = items[on] as SketchItem
      items[on] = { ...keep, loops: k.loops, ...(k.frame ? { frame: k.frame } : {}), ...(k.constraints ? { constraints: k.constraints } : {}) }
      if (at <= on) at = on + 1
    }
    const add: Item[] = on >= 0 ? [featureOf(s, body, s.sketch)] : isSketch(s.params) ? split(s, body, nextName(items), items) : [{ ...s, kind: 'feature', body }]
    items.splice(at, 0, ...add)
    for (const [id, p] of place) if (p >= at) place.set(id, p + add.length)
    place.set(s.id, at + add.length - 1)
    if (at < marker || (!atEnd && at === marker)) marker += add.length
  })
  const b: Body = { id: body, base: h.base, ...(h.ended ? { ended: h.ended } : {}) }
  const bodies = t.bodies.some((x) => x.id === body) ? t.bodies.map((x) => (x.id === body ? b : x)) : [...t.bodies, b]
  return { bodies, items, marker: atEnd ? items.length : marker }
}

/** The timeline with a finished sketch put in at the marker, named the next Sketch N; a feature can draw on it later. */
export function withSketch(t: Timeline, sketch: Omit<SketchItem, 'kind' | 'name'>): Timeline {
  const at = Math.min(t.marker, t.items.length)
  const k: SketchItem = { kind: 'sketch', ...sketch, name: nextName(t.items) }
  return { ...t, items: [...t.items.slice(0, at), k, ...t.items.slice(at)], marker: at + 1 }
}

/** The timeline without a body that left the plate: its features go, and so do sketches only they used. */
export function withoutBody(t: Timeline, body: string): Timeline {
  if (!t.bodies.some((b) => b.id === body)) return t
  const used = new Set(t.items.flatMap((i) => (i.kind === 'feature' && i.body !== body && i.sketch !== undefined ? [i.sketch] : [])))
  const mine = new Set(t.items.flatMap((i) => (i.kind === 'feature' && i.body === body && i.sketch !== undefined ? [i.sketch] : [])))
  const gone = (i: Item) => (i.kind === 'feature' ? i.body === body : mine.has(i.id) && !used.has(i.id))
  const marker = t.items.slice(0, t.marker).filter((i) => !gone(i)).length
  return { bodies: t.bodies.filter((b) => b.id !== body), items: t.items.filter((i) => !gone(i)), marker }
}

/** An object on a plate as the timeline sees it. */
type Obj = { id: string; history?: History | undefined; instanceOf?: string | undefined }

/** The objects with a history of their own: a copy placed twice shares its source's. */
function bodiesOf<O extends Obj>(objects: readonly O[]): O[] {
  const ids = new Set(objects.map((o) => o.id))
  return objects.filter((o) => o.history && !(o.instanceOf && ids.has(o.instanceOf)))
}

/**
 * The timeline with every object's history folded in, and without bodies no object has now. With no bodies yet, the
 * objects' histories are merged by when each step was made, as an older file opens.
 */
export function syncTimeline(t: Timeline, objects: readonly Obj[], seen?: WeakSet<History>): Timeline {
  const bodies = bodiesOf(objects)
  if (!t.bodies.length && !t.items.length && bodies.length) {
    for (const o of bodies) seen?.add(o.history!)
    return timelineOf(bodies.map((o) => ({ id: o.id, history: o.history! })))
  }
  const here = new Set(bodies.map((o) => o.id))
  let out = t
  for (const b of t.bodies) if (!here.has(b.id)) out = withoutBody(out, b.id)
  for (const o of bodies) {
    const h = o.history!
    if (seen?.has(h) && out.bodies.some((b) => b.id === o.id)) continue
    out = withHistory(out, o.id, h)
    seen?.add(h)
  }
  return out
}

/**
 * One timeline after another, `b` going in at `a`'s marker: a project opened onto a plate joins its design there.
 * A sketch id `a` already has is renamed in `b`, with the features that use it.
 */
export function joinTimelines(a: Timeline, b: Timeline): Timeline {
  if (!b.items.length && !b.bodies.length) return a
  const taken = new Set(a.items.filter((i) => i.kind === 'sketch').map((i) => i.id))
  const rename = new Map<string, string>()
  for (const i of b.items) {
    if (i.kind !== 'sketch' || !taken.has(i.id)) continue
    let id = `${i.id}2`
    for (let n = 3; taken.has(id); n++) id = `${i.id}${n}`
    taken.add(id)
    rename.set(i.id, id)
  }
  const items: Item[] = b.items.map((i) => {
    if (i.kind === 'sketch') return rename.has(i.id) ? { ...i, id: rename.get(i.id)! } : i
    return i.sketch !== undefined && rename.has(i.sketch) ? { ...i, sketch: rename.get(i.sketch)! } : i
  })
  const at = Math.min(a.marker, a.items.length)
  return { bodies: [...a.bodies, ...b.bodies.filter((x) => !a.bodies.some((y) => y.id === x.id))], items: [...a.items.slice(0, at), ...items, ...a.items.slice(at)], marker: at + b.marker }
}

/** The timeline with its bodies renamed, say from a file's object ids to the plate's; a body with no new id goes. */
export function withBodyIds(t: Timeline, id: (old: string) => string | undefined): Timeline {
  let out = t
  for (const b of t.bodies) if (id(b.id) === undefined) out = withoutBody(out, b.id)
  return {
    bodies: out.bodies.map((b) => ({ ...b, id: id(b.id)! })),
    items: out.items.map((i) => (i.kind === 'feature' ? { ...i, body: id(i.body)! } : i)),
    marker: out.marker,
  }
}

/** The timeline as an agent reads it: the marker, the bodies and each item in order, without loops or meshes. */
export function timelineSummary(t: Timeline): { marker: number; end: number; bodies: string[]; items: Record<string, unknown>[] } {
  return {
    marker: t.marker,
    end: t.items.length,
    bodies: t.bodies.map((b) => b.id),
    items: t.items.map((i) =>
      i.kind === 'sketch'
        ? { kind: 'sketch', id: i.id, name: i.name, loops: i.loops.length }
        : { kind: 'feature', id: i.id, body: i.body, op: i.params.op, ...(i.sketch ? { sketch: i.sketch } : {}), ...(i.label ? { label: i.label } : {}), ...(i.suppressed ? { suppressed: true } : {}) },
    ),
  }
}
