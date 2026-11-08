// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finished sketches: Finish sketch puts the sketch in the design timeline without making a solid, the way Fusion
// does. A finished sketch opens again from the strip or the tree to be changed, extruded or revolved; a feature
// made from it names it by id (cad-ops.ts LandIn), and changing the sketch replays the bodies that use it.
import { historyOf, stepId, withoutTaken, withSketch, type FaceFrame, type Projection, type SketchConstraint, type SketchItem, type SketchLoop, type Timeline } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'
import { brandAccent } from '../edition'
import { get, markStale, set, toast, type PlateEntry } from '../state/store'
import { colorsFor } from './commit'
import { cancelEdit, runReplay, toPart, withStatus } from './history/ops'
import { newStep, withLast, type UndoStep } from '../plate/history'
import { followBodies } from './project-sketch'

type Loader = { loadParts(name: string, parts: PlateEntry['parts']): Promise<MeshHandle> }

/** What a sketch is drawn on and what it holds. No frame is the bed. */
export interface SketchBody {
  frame?: FaceFrame | undefined
  loops: SketchLoop[]
  constraints?: SketchConstraint[] | undefined
  /** the body whose face it was drawn on */
  on?: { body: string; part: number } | undefined
  /** model geometry projected into it; their curves are the loops that name them. Absent keeps a sketch's own. */
  projections?: Projection[] | undefined
  /** how many projection ids it has handed out */
  nextProjection?: number | undefined
}

const body = (s: SketchBody) => ({ ...(s.frame ? { frame: s.frame } : {}), loops: s.loops, ...(s.constraints?.length ? { constraints: s.constraints } : {}), ...(s.on ? { on: s.on } : {}), ...(s.projections?.length ? { projections: s.projections } : {}), ...(s.nextProjection ? { nextProjection: s.nextProjection } : {}) })

/** Puts a finished sketch in the timeline at the marker and returns it. Undo takes it out again. */
export function finishSketch(s: SketchBody, id = `${stepId()}k`): SketchItem {
  const t = withSketch(get().timeline, { id, ...body(s) })
  set({ timeline: t })
  return t.items[t.marker - 1] as SketchItem
}

/**
 * Extrude or Revolve of a new sketch that holds projections: the solid names the sketch (a projection's source stays
 * on the sketch item), so the sketch goes in the timeline as the solid lands, in the same undo step, as a plain
 * extrude and its sketch do. `apply` hands `step` to the write that lands the solid and `sketch`, the new sketch's id,
 * to the step it records; nothing else joins the step or takes the id, so an edit or another tool's solid made while
 * the engine works keeps its own. When nothing lands (the engine refuses, or a join misses the
 * body), the sketch never went in, so there is nothing to take back and the undo history is as it was.
 */
export async function solidOnNewSketch<T>(s: SketchBody, apply: (step: UndoStep, sketch: string) => Promise<T>): Promise<T> {
  const id = `${stepId()}k`
  return apply(newStep(() => void finishSketch(s, id)), id)
}

/**
 * Runs one press at a time: a second Enter in Distance or Angle while Extrude still works does nothing, where state
 * set for the button would only apply after the next render. Resolves undefined for a press it skipped.
 */
export function oneAtATime(): <T>(run: () => Promise<T>) => Promise<T | undefined> {
  let busy = false
  return async (run) => {
    if (busy) return undefined
    busy = true
    try {
      return await run()
    } finally {
      busy = false
    }
  }
}

/**
 * What the sketch editor does with an Extrude or Revolve that went through: one that changed nothing (a join that
 * misses the body) keeps the editor and the drawing open with why as its note, as a refusal does, so the distance
 * or direction can be fixed and pressed again; one that landed closes the editor with a toast. A miss after the
 * editor closed (the person left it while the engine worked) has no note to land in, so it says why in a toast.
 */
export function afterSolid(r: { message: string; warn: boolean; missed?: true | undefined }, note: (text: string) => void): void {
  if (r.missed) {
    if (get().objectTool === 'sketch') return note(r.message)
    return toast(r.message, 'warn')
  }
  toast(r.message, r.warn ? 'warn' : 'ok')
  set({ objectTool: null })
}

/** The sketch with this id, or null. */
export function sketchById(t: Timeline, id: string): SketchItem | null {
  const k = t.items.find((i) => i.kind === 'sketch' && i.id === id)
  return k?.kind === 'sketch' ? k : null
}

/** The body Join and Cut work on by default: the one the sketch sits on, else the only body. Null when it is not plain. */
export function defaultTarget(k: SketchItem, plate: readonly Pick<PlateEntry, 'id'>[]): { objectId: string; partIndex: number } | null {
  if (k.on && plate.some((e) => e.id === k.on!.body)) return { objectId: k.on.body, partIndex: k.on.part }
  return plate.length === 1 ? { objectId: plate[0]!.id, partIndex: 0 } : null
}

/** The bodies with a live feature drawn on the sketch. */
export function usersOf(t: Timeline, id: string): string[] {
  return [...new Set(t.items.slice(0, t.marker).flatMap((i) => (i.kind === 'feature' && i.sketch === id ? [i.body] : [])))]
}

/**
 * Changes a finished sketch; every body with a live feature on it replays, and the projections from those bodies
 * follow. With `join`, the change is part of the last undo step (a projection following its source).
 */
export async function updateSketch(host: Loader, id: string, s: SketchBody, o: { join?: boolean } = {}): Promise<{ replayed: number }> {
  const t0 = get().timeline
  const old = sketchById(t0, id)
  if (!old) throw new Error('That sketch is no longer in the timeline.')
  const { frame: _f, constraints: _c, ...kept } = old
  // given projections replace the sketch's; none given keeps them. The id count never goes down, and features stop
  // naming a projection that is gone, so its id is never taken by a later one
  const { projections: _p, ...bare } = kept
  const keep = s.projections ? bare : kept
  const n = Math.max(old.nextProjection ?? 0, s.nextProjection ?? 0)
  const next: SketchItem = { ...keep, ...body(s), ...(n ? { nextProjection: n } : {}) }
  const items = t0.items.map((i) => (i === old ? next : i))
  const t: Timeline = { ...t0, items: s.projections ? withoutTaken(items, id, new Set(s.projections.map((p) => p.id))) : items }
  const views = new Map<string, PlateEntry>()
  for (const b of usersOf(t, id)) {
    const entry = get().plate.find((e) => e.id === b)
    const h = historyOf(t, b)
    // a body whose steps take nothing that changed (a projection made after them) stays as it is
    if (!entry || !h || JSON.stringify(h.steps) === JSON.stringify(historyOf(t0, b)?.steps)) continue
    const r = await runReplay({ history: h })
    if (!r.parts.length) throw new Error(`${entry.name} would have no solid left with this sketch.`)
    const parts = r.parts.map(toPart)
    const handle = await host.loadParts(entry.name, parts)
    views.set(b, { ...entry, handle, parts, colors: colorsFor(parts.length, entry.colors, brandAccent()), history: { ...h, steps: withStatus(h.steps, r.status, r.found) } })
  }
  const commit = () => set((st) => ({ timeline: t, plate: st.plate.map((e) => views.get(e.id) ?? e) }))
  if (o.join) withLast(commit)
  else commit()
  if (views.size) markStale()
  await followBodies(host, views.keys())
  return { replayed: views.size }
}

/** How a finished sketch opens in the sketch tool: to change it, or to extrude or revolve it. */
export type SketchOpen = { id: string; mode: 'edit' | 'extrude' | 'revolve' }

let request: SketchOpen | null = null

/** Opens a finished sketch in the sketch tool. */
export function openSketch(open: SketchOpen): void {
  request = open
  cancelEdit()
  // an open sketch tool closes first, so the new one starts from the request
  if (get().objectTool !== 'sketch') return set({ objectTool: 'sketch' })
  set({ objectTool: null })
  setTimeout(() => set({ objectTool: 'sketch' }), 0)
}

/** The open request for the sketch tool that is starting, used once. */
export function takeSketchOpen(): SketchOpen | null {
  const r = request
  request = null
  return r
}

// The open sketch editor's Finish sketch, for the shelf's button and Enter.
let finisher: (() => void) | null = null
const listeners = new Set<() => void>()

/** Registers the open editor's Finish sketch; returns the unregister. */
export function provideFinish(fn: () => void): () => void {
  finisher = fn
  for (const l of listeners) l()
  return () => {
    if (finisher !== fn) return
    finisher = null
    for (const l of listeners) l()
  }
}

/** Finish sketch on the open editor, if one is open. */
export function requestFinish(): void {
  finisher?.()
}

/** Whether a sketch editor that can finish is open. */
export function useCanFinish(): boolean {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => finisher !== null,
  )
}

// The finished sketch an Extrude or Revolve from its menu is using: the tree marks it, the shelf's Sketch stays up.
let inUse: string | null = null
const useListeners = new Set<() => void>()

/** Marks a finished sketch as in use; returns the unmark. */
export function provideInUse(id: string): () => void {
  inUse = id
  for (const l of useListeners) l()
  return () => {
    if (inUse !== id) return
    inUse = null
    for (const l of useListeners) l()
  }
}

/** The finished sketch a feature from its menu is using, or null. */
export function useSketchInUse(): string | null {
  return useSyncExternalStore(
    (l) => (useListeners.add(l), () => void useListeners.delete(l)),
    () => inUse,
  )
}

/** The open sketch editor's drawing tools, for the ribbon's Sketch tab: the family in use, and what its buttons do. */
export interface SketchDraw {
  /** The draw family in use: select, line, rect, circle, arc, polygon, slot, trim or dimension. */
  family: string
  pick(family: string): void
  look(): void
  /** Mirror for the selected loop; null when no loop is selected. */
  mirror: (() => void) | null
  mirroring: boolean
  /** A valid profile can make the solid: Extrude is the panel's primary, so Finish sketch is a plain button. */
  ready: boolean
}

let draw: SketchDraw | null = null
const drawListeners = new Set<() => void>()

/** Registers the open editor's drawing tools; returns the unregister. */
export function provideDraw(d: SketchDraw): () => void {
  draw = d
  for (const l of drawListeners) l()
  return () => {
    if (draw !== d) return
    draw = null
    for (const l of drawListeners) l()
  }
}

/** The open sketch editor's drawing tools, or null while nobody is sketching. */
export function useSketchDraw(): SketchDraw | null {
  return useSyncExternalStore(
    (l) => (drawListeners.add(l), () => void drawListeners.delete(l)),
    () => draw,
  )
}
