// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Picking finished sketches for a tool that takes them (Loft, Sweep): the open panel says it takes sketch picks and
// which sketches are picked, with the mark each shows (its number in a loft, or Profile and Path). The view then
// highlights a sketch under the pointer and draws the marks, and a click on a sketch in the view or in the tree goes to
// the panel. One picker at a time; none while no such panel is open.
import { useSyncExternalStore } from 'react'

export interface SketchPicker {
  /** A sketch was clicked, in the view or the tree. */
  pick(id: string): void
  /** The picked sketches, each with the mark it shows beside it. */
  marks: ReadonlyMap<string, string>
}

let current: SketchPicker | null = null
const listeners = new Set<() => void>()

/** Opens (or updates) the picker; null closes it. */
export function setSketchPicker(p: SketchPicker | null): void {
  if (p === current) return
  current = p
  for (const l of listeners) l()
}

export function sketchPicker(): SketchPicker | null {
  return current
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The open picker, for the tree and the view. */
export function useSketchPicker(): SketchPicker | null {
  return useSyncExternalStore(subscribe, sketchPicker, sketchPicker)
}

/** Hands a sketch click to the open picker; false when no tool takes sketch picks. */
export function pickSketch(id: string): boolean {
  if (!current) return false
  current.pick(id)
  return true
}
