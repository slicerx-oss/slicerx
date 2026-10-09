// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When Model plays the plate reveal: the first time it opens in a session, and when a job opens while it shows.
// Switching tabs back and forth never replays it, and reduced motion never plays it.

export interface RevealInput {
  /** The Model tab is showing. */
  model: boolean
  /** The store's count of jobs opened (AppState.jobSeq). */
  jobSeq: number
}

export interface RevealMemory {
  /** Model has opened, or the window's first reveal already played on it, this session. */
  modelSeen: boolean
}

/**
 * Whether to play the reveal for this change. `prev` is the last state seen, null on the view's first one: a view that
 * starts on Model plays the window's own first reveal, so that open counts as seen.
 */
export function modelReveal(prev: RevealInput | null, now: RevealInput, memory: RevealMemory, reducedMotion: boolean): boolean {
  if (!now.model) return false
  const first = !memory.modelSeen
  memory.modelSeen = true
  if (prev === null || reducedMotion) return false
  if (!prev.model) return first
  return now.jobSeq !== prev.jobSeq
}
