// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the open sketch tells the rest of the studio: where it is drawn and with which tool, for the view's mode pill
// ("Sketching on a face · Line") and the app's read-back, and the camera button that turns the view square onto the
// sketch. The sketch panel sets it while a sketch is open and clears it on close. The rules for the panel's solid card
// live here too, kept free of React so they can be tested alone.
import { useSyncExternalStore } from 'react'

/** Where a sketch is drawn. */
export type SketchSurface = 'face' | 'bed' | 'plane' | 'sketch'

export interface SketchMode {
  /** A face of a body, the bed, an origin plane, or a finished sketch or step opened again. */
  on: SketchSurface
  /** The panel's own words for where: "A face of Box", "The bed", "The XY plane". */
  label: string
  /** The drawing tool's name as its button shows it: "Line", "Rectangle", "Select". */
  tool: string
}

let mode: SketchMode | null = null
let look: (() => void) | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

/** The open sketch, or null when none is. */
export const sketchMode = (): SketchMode | null => mode

/** Sets what the open sketch shows; null when it closes. */
export function setSketchMode(next: SketchMode | null): void {
  if (next === mode || (next && mode && next.on === mode.on && next.label === mode.label && next.tool === mode.tool)) return
  mode = next
  emit()
}

/** The open sketch's Look at the sketch, for the view's camera buttons. Returns the release. */
export function provideSketchLook(fn: () => void): () => void {
  look = fn
  emit()
  return () => {
    if (look !== fn) return
    look = null
    emit()
  }
}

/** Turns the view square onto the open sketch; false when no sketch is open. */
export function lookAtSketch(): boolean {
  if (!look) return false
  look()
  return true
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}

export function useSketchMode(): SketchMode | null {
  return useSyncExternalStore(subscribe, sketchMode, sketchMode)
}

export function useSketchLook(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => look !== null,
    () => false,
  )
}

const ON: Record<Exclude<SketchSurface, 'sketch'>, string> = { face: 'on a face', bed: 'on the bed', plane: 'on a plane' }

/** The view's mode pill while a sketch is open: "Sketching on a face · Line". */
export function sketchModeText(m: SketchMode): string {
  return `${m.on === 'sketch' ? 'Sketching' : `Sketching ${ON[m.on]}`} · ${m.tool}`
}

/** The surface a sketch plane's label names. */
export function surfaceOf(plane: { target?: unknown; label: string }, opened: boolean): SketchSurface {
  if (opened) return 'sketch'
  if (plane.target) return 'face'
  return plane.label === 'The bed' ? 'bed' : 'plane'
}

/** The solid card: open with its settings, or folded to its header with the reason it can't make a solid yet. */
export interface SolidCard {
  open: boolean
  /** One line for a folded card: the first problem the check found, or what's still missing. Null when open. */
  reason: string | null
}

/**
 * The solid card's state. It opens once the sketch has a closed profile (a closed loop that isn't construction), and
 * stays open after that while more is drawn, so the card never folds and opens again under the pointer. Extrude or
 * Revolve from a finished sketch has no drawing, so its card is always open.
 */
export function solidCard(s: { featureOnly: boolean; closedProfiles: number; issues: readonly { message: string }[]; drawn: boolean }): SolidCard {
  if (s.featureOnly || s.closedProfiles > 0) return { open: true, reason: null }
  const first = s.issues[0]?.message
  if (first) return { open: false, reason: first }
  return { open: false, reason: s.drawn ? 'Close the outline to make a solid.' : 'Draw a closed outline to make a solid.' }
}
