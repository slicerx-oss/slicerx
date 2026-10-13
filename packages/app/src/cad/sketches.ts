// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finished sketches: Finish Sketch puts the sketch in the design timeline without making a solid, the way Fusion
// does. A finished sketch opens again from the strip or the tree to be changed, extruded or revolved; a feature
// made from it names it by id (record.ts sketchNext), and changing the sketch replays the bodies that use it.
import { historyOf, stepId, withSketch, type FaceFrame, type SketchConstraint, type SketchItem, type SketchLoop, type Timeline } from '@slicerx/cad-history'
import type { MeshHandle } from '@slicerx/contracts'
import { useSyncExternalStore } from 'react'
import { brandAccent } from '../edition'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { colorsFor } from './commit'
import { cancelEdit, runReplay, toPart, withStatus } from './history/ops'

type Loader = { loadParts(name: string, parts: PlateEntry['parts']): Promise<MeshHandle> }

/** What a sketch is drawn on and what it holds. No frame is the bed. */
export interface SketchBody {
  frame?: FaceFrame | undefined
  loops: SketchLoop[]
  constraints?: SketchConstraint[] | undefined
}

const body = (s: SketchBody) => ({ ...(s.frame ? { frame: s.frame } : {}), loops: s.loops, ...(s.constraints?.length ? { constraints: s.constraints } : {}) })

/** Puts a finished sketch in the timeline at the marker and returns it. Undo takes it out again. */
export function finishSketch(s: SketchBody): SketchItem {
  const t = withSketch(get().timeline, { id: `${stepId()}k`, ...body(s) })
  set({ timeline: t })
  return t.items[t.marker - 1] as SketchItem
}

/** The sketch with this id, or null. */
export function sketchById(t: Timeline, id: string): SketchItem | null {
  const k = t.items.find((i) => i.kind === 'sketch' && i.id === id)
  return k?.kind === 'sketch' ? k : null
}

/** The bodies with a live feature drawn on the sketch. */
export function usersOf(t: Timeline, id: string): string[] {
  return [...new Set(t.items.slice(0, t.marker).flatMap((i) => (i.kind === 'feature' && i.sketch === id ? [i.body] : [])))]
}

/** Changes a finished sketch; every body with a live feature on it replays. */
export async function updateSketch(host: Loader, id: string, s: SketchBody): Promise<{ replayed: number }> {
  const t0 = get().timeline
  const old = sketchById(t0, id)
  if (!old) throw new Error('That sketch is no longer in the timeline.')
  const { frame: _f, constraints: _c, ...keep } = old
  const t: Timeline = { ...t0, items: t0.items.map((i) => (i === old ? { ...keep, ...body(s) } : i)) }
  const views = new Map<string, PlateEntry>()
  for (const b of usersOf(t, id)) {
    const entry = get().plate.find((e) => e.id === b)
    const h = historyOf(t, b)
    if (!entry || !h) continue
    const r = await runReplay({ history: h })
    if (!r.parts.length) throw new Error(`${entry.name} would have no solid left with this sketch.`)
    const parts = r.parts.map(toPart)
    const handle = await host.loadParts(entry.name, parts)
    views.set(b, { ...entry, handle, parts, colors: colorsFor(parts.length, entry.colors, brandAccent()), history: { ...h, steps: withStatus(h.steps, r.status, r.found) } })
  }
  set((st) => ({ timeline: t, plate: st.plate.map((e) => views.get(e.id) ?? e) }))
  if (views.size) markStale()
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

// The open sketch editor's Finish Sketch, for the shelf's button and Enter.
let finisher: (() => void) | null = null
const listeners = new Set<() => void>()

/** Registers the open editor's Finish Sketch; returns the unregister. */
export function provideFinish(fn: () => void): () => void {
  finisher = fn
  for (const l of listeners) l()
  return () => {
    if (finisher !== fn) return
    finisher = null
    for (const l of listeners) l()
  }
}

/** Finish Sketch on the open editor, if one is open. */
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
