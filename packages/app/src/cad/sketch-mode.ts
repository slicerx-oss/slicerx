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
  /** What the drawing is as a profile (see `profileState`); absent until the panel has checked it. */
  profile?: ProfileState
  /** The solver's degrees of freedom left, 0 when fully defined; null until it has run. */
  dof?: number | null
  /** Extrude or Revolve can run now; when false, `reason` says why in the panel's words. */
  ready?: boolean
  reason?: string | null
  /** The drawn loops in the sketch plane, mm, for clients to check what was drawn. */
  loops?: unknown
}

let mode: SketchMode | null = null
let look: (() => void) | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

/** The open sketch, or null when none is. */
export const sketchMode = (): SketchMode | null => mode

/** Sets what the open sketch shows; null when it closes. */
export function setSketchMode(next: SketchMode | null): void {
  if (next === mode || (next && mode && JSON.stringify(next) === JSON.stringify(mode))) return
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

/**
 * What the drawing is as a profile, from the engine's check: nothing drawn, open (no closed loop yet), invalid (a closed
 * loop the check finds wrong, such as one crossing itself), or valid. Closed says nothing of how defined the sketch is;
 * the solver's dof says that.
 */
export type ProfileState = 'none' | 'open' | 'invalid' | 'valid'

export function profileState(s: { drawn: boolean; closedProfiles: number; checked: boolean; ok: boolean; issues: readonly unknown[] }): ProfileState {
  if (!s.drawn) return 'none'
  if (s.closedProfiles === 0) return 'open'
  if (s.issues.length || (s.checked && !s.ok)) return 'invalid'
  return 'valid'
}

/**
 * Why Extrude or Revolve can't run yet, in one line for under the button, or null when it can. The first thing to
 * fix comes first: the shape being drawn, then the profile, then what the operation itself needs.
 */
export function applyReason(s: {
  profile: ProfileState
  drawing: boolean
  checked: boolean
  firstIssue?: string
  finish: 'extrude' | 'revolve'
  axis: boolean
  op: 'new' | 'join' | 'cut'
  target: boolean
}): string | null {
  if (s.drawing) return 'End the shape being drawn first (Esc or a right click).'
  if (s.profile === 'none') return 'Draw a closed outline to make a solid.'
  if (s.profile === 'open') return 'Close the outline to make a solid.'
  if (s.profile === 'invalid') return s.firstIssue ?? 'The outline needs fixing before it can make a solid.'
  if (!s.checked) return 'Checking the sketch.'
  if (s.finish === 'revolve' && !s.axis) return 'Pick a straight line of the sketch as the axis.'
  if (s.op !== 'new' && !s.target) return s.op === 'join' ? 'Pick a body to join to.' : 'Pick a body to cut from.'
  return null
}

// Test hook: with localStorage 'slicerx.debug' set (as for window.__sx), scripts read the open sketch as app_state's
// `sketch` is built from it.
try {
  if (typeof window !== 'undefined' && localStorage.getItem('slicerx.debug')) Object.assign(window, { __sketch: sketchMode })
} catch {
  // storage blocked: no hook
}
