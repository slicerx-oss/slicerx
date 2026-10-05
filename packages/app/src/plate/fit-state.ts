// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fit check results per object: warnings for the
// objects list and the gap lines the viewport draws. Outside the app store: derived from the
// plate, never persisted.
import { useSyncExternalStore } from 'react'
import type { FitGap } from '../geom/cad'

export interface ObjectFit {
  /** One sentence per gap, with the fix. */
  warnings: string[]
  gaps: FitGap[]
  /** The gap each part pair was checked against, per side. */
  limitMm: number
  verticalLimitMm: number
}

let fits: Readonly<Record<string, ObjectFit>> = {}
const listeners = new Set<() => void>()

function write(next: Readonly<Record<string, ObjectFit>>): void {
  fits = next
  for (const l of listeners) l()
}

export const fitOf = (objectId: string): ObjectFit | undefined => fits[objectId]
export const allFits = (): Readonly<Record<string, ObjectFit>> => fits

export function setFit(objectId: string, fit: ObjectFit | null): void {
  const next = { ...fits }
  if (fit && (fit.gaps.length || fit.warnings.length)) next[objectId] = fit
  else delete next[objectId]
  write(next)
}

/** Drops objects that left the plate. */
export function keepFits(ids: readonly string[]): void {
  const keep = new Set(ids)
  if (Object.keys(fits).every((id) => keep.has(id))) return
  write(Object.fromEntries(Object.entries(fits).filter(([id]) => keep.has(id))))
}

export function subscribeFits(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useFits(): Readonly<Record<string, ObjectFit>> {
  return useSyncExternalStore(subscribeFits, () => fits, () => fits)
}

/** The lines the viewport draws, every object together. */
export function fitLines(): { from: [number, number, number]; to: [number, number, number]; kind: FitGap['kind'] }[] {
  return Object.values(fits).flatMap((f) => f.gaps.map((g) => ({ from: g.from, to: g.to, kind: g.kind })))
}
