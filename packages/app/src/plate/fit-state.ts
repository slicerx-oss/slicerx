// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fit check results: tight gaps inside each object, and separate objects that touch. The objects
// list reads them for its notes, the viewport for its gap lines. Outside the app store: derived from
// the plate, never persisted.
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

function changed(): void {
  version++
  for (const l of listeners) l()
}

export const objectFit = (objectId: string): ObjectFit | undefined => fits[objectId]
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

/** The lines the viewport draws, every object together. */
export function fitLines(): FitLine[] {
  return [
    ...Object.entries(fits).flatMap(([id, f]) => f.gaps.map((g) => ({ from: g.from, to: g.to, kind: g.kind, on: [{ id, transform: f.transform }] }))),
    ...touches.map((t) => ({ from: t.from, to: t.to, kind: 'fused' as const, on: [{ id: t.ids[0], transform: t.transforms[0] }, { id: t.ids[1], transform: t.transforms[1] }] })),
  ]
}
