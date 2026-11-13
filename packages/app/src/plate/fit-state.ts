// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fit check results: tight gaps inside each object, and separate objects that touch. The objects
// list reads them for its notes, the viewport for its gap lines. Outside the app store: derived from
// the plate, never persisted. The check runs after every plate edit, but its gap lines draw only for the objects someone
// asked about: the person opened a fit note, or a tool checked the gaps. They go at the next plate edit.
import { useSyncExternalStore } from 'react'
import type { FitGap } from '../geom/cad'

export interface ObjectFit {
  /** Pairs of parts closer than the printer keeps open. Touching parts are one piece and never here. */
  gaps: FitGap[]
  /** Part names, by the index a gap uses. */
  names: string[]
  /** The gap each part pair was checked against, per side. */
  limitMm: number
  verticalLimitMm: number
  /** The object's transform when it was checked: its gap lines follow the object from there. */
  transform: number[]
}

/** Two separate objects that touch or sit closer than the printer keeps open, so they print as one piece. */
export interface Touch {
  ids: [string, string]
  /** Each object's transform when it was checked. */
  transforms: [number[], number[]]
  gapMm: number
  from: [number, number, number]
  to: [number, number, number]
}

let fits: Readonly<Record<string, ObjectFit>> = {}
let touches: readonly Touch[] = []
let version = 0
const listeners = new Set<() => void>()
/** The objects whose gap lines the viewport draws now. The automatic check alone adds none. */
let shown: ReadonlySet<string> = new Set()
/** The plate as last edited, while its check has not run to its end: lines measured on the plate before stay hidden. */
let editedPlate: unknown = null

function changed(): void {
  version++
  for (const l of listeners) l()
}

export const objectFit = (objectId: string): ObjectFit | undefined => fits[objectId]

/** Draws an object's gap lines: the person opened its fit note, or a tool checked its gaps. */
export function showMarkers(objectId: string): void {
  if (shown.has(objectId)) return
  shown = new Set([...shown, objectId])
  changed()
}

/** Takes the gap lines away: one object's (its fit note closed), or every object's. */
export function hideMarkers(objectId?: string): void {
  if (objectId === undefined ? shown.size === 0 : !shown.has(objectId)) return
  shown = objectId === undefined ? new Set() : new Set([...shown].filter((id) => id !== objectId))
  changed()
}

export const markersShown = (objectId: string): boolean => shown.has(objectId)

/** The plate changed: every gap line goes, and none draws again until this plate's check is over. */
export function plateEdited(plate: unknown): void {
  editedPlate = plate
  hideMarkers()
}
export const allTouches = (): readonly Touch[] => touches

export function setFit(objectId: string, fit: ObjectFit | null): void {
  if (!fit?.gaps.length && !fits[objectId]) return
  const next = { ...fits }
  if (fit?.gaps.length) next[objectId] = fit
  else delete next[objectId]
  fits = next
  changed()
}

export function setTouches(next: readonly Touch[]): void {
  if (next.length === 0 && touches.length === 0) return
  touches = next
  changed()
}

/** Drops objects that left the plate. */
export function keepFits(ids: readonly string[]): void {
  const keep = new Set(ids)
  const gone = Object.keys(fits).some((id) => !keep.has(id))
  const lost = touches.some((t) => !keep.has(t.ids[0]) || !keep.has(t.ids[1]))
  if (!gone && !lost) return
  fits = Object.fromEntries(Object.entries(fits).filter(([id]) => keep.has(id)))
  touches = touches.filter((t) => keep.has(t.ids[0]) && keep.has(t.ids[1]))
  changed()
}

/** The plate (the store's plate array) whose fit check last ran to its end, or needed none. */
let settledPlate: unknown = null
const settleListeners = new Set<() => void>()

/**
 * The fit check of this plate is over (or it needed none): its copies of the meshes are gone from the geometry worker's
 * queue. Auto slice holds a big slice until then (auto-slice.ts).
 */
export function fitSettled(plate: unknown): void {
  settledPlate = plate
  if (plate === editedPlate) editedPlate = null
  // lines asked for while the check ran draw now
  if (shown.size) changed()
  for (const l of [...settleListeners]) l()
}

/** Whether the fit check of this plate is over. */
export const fitSettledFor = (plate: unknown): boolean => settledPlate === plate

/** Calls back each time a plate's fit check is over. Returns the unsubscribe function. */
export function onFitSettled(cb: () => void): () => void {
  settleListeners.add(cb)
  return () => settleListeners.delete(cb)
}

export function subscribeFits(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Re-renders on any change; read fitOf and allTouches inside. */
export function useFits(): number {
  return useSyncExternalStore(subscribeFits, () => version, () => version)
}

export interface FitLine {
  from: [number, number, number]
  to: [number, number, number]
  kind: FitGap['kind']
  /** The objects the line was measured on, with their transforms then. */
  on: { id: string; transform: number[] }[]
}

/** The lines the viewport draws: those of the objects someone asked about, measured on the plate as it is. */
export function fitLines(): FitLine[] {
  if (shown.size === 0 || editedPlate !== null) return []
  return [
    ...Object.entries(fits)
      .filter(([id]) => shown.has(id))
      .flatMap(([id, f]) => f.gaps.map((g) => ({ from: g.from, to: g.to, kind: g.kind, on: [{ id, transform: f.transform }] }))),
    ...touches
      .filter((t) => shown.has(t.ids[0]) || shown.has(t.ids[1]))
      .map((t) => ({ from: t.from, to: t.to, kind: 'fused' as const, on: [{ id: t.ids[0], transform: t.transforms[0] }, { id: t.ids[1], transform: t.transforms[1] }] })),
  ]
}

/**
 * A tool (mimir, or an agent over the app link) ran: geom.fit_check, or design.check with a gaps or loose parts item,
 * shows that object's gap lines. A design's id is its object's id on the plate. A refused run shows nothing.
 */
export function fitToolRan(tool: string, input: unknown, output: unknown): void {
  const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined)
  if (tool === 'geom.fit_check') {
    const id = field(input, 'design')
    if (typeof id === 'string') showMarkers(id)
    return
  }
  if (tool !== 'design.check') return
  const id = field(output, 'design')
  const items = field(output, 'items')
  const fitItem = Array.isArray(items) && items.some((x) => ['gaps', 'loose parts'].includes(String(field(x, 'name'))))
  if (typeof id === 'string' && fitItem) showMarkers(id)
}
