// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Adding a step to a history, the same way for a person's tools and for a client's: steps that broke are suppressed
// first so the history matches the mesh, and the new step follows the end faces its references sit on.
import { followFor, type History, type Step } from './model'

/** Steps that broke, and everything after the first one, did not run; a new step after them suppresses them so the history matches the mesh. */
export function settle(steps: readonly Step[]): Step[] {
  const first = steps.findIndex((s) => s.broken !== undefined && !s.suppressed)
  return first < 0 ? [...steps] : steps.map((s, i) => (i >= first && !s.suppressed ? { ...s, suppressed: true } : s))
}

/** The history with `step` added at the end. */
export function appendStep(h: History, step: Step): History {
  const steps = settle(h.steps)
  const follow = followFor(steps, step)
  return { ...h, steps: [...steps, follow ? { ...step, follow } : step] }
}
