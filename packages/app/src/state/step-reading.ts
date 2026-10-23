// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The STEP file being read right now, for the bar over the plate that names it and offers Cancel. Kept apart from
// import-step.ts so the bar never loads the reader's plumbing; the reader sets it and hands over its cancel.

export interface StepReading {
  name: string
  startedAt: number
}

let shown: StepReading | null = null
let cancel: (() => void) | null = null
const listeners = new Set<() => void>()

/** Called by the reader: the file it is reading and how to stop it, or null when nothing is being read. */
export function setStepReading(next: StepReading | null, stop: (() => void) | null = null): void {
  shown = next
  cancel = next ? stop : null
  for (const l of listeners) l()
}

/** The file being read, or null. */
export function stepReading(): StepReading | null {
  return shown
}

/** Stops the read under way, if there is one. The open then says it was canceled. */
export function cancelStepRead(): void {
  cancel?.()
}

export function onStepReading(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
