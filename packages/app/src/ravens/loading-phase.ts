// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The wait over the plate while a model opens, in two phases. Before its first frame the ravens keep company (once the
// wait has run past about 1.2 s). Once the model is drawn they leave, and an accent wisp runs the plate edge until the
// import, repair and loading finish; the status line names the step.
import type { OpenStage } from '../lib/open-timing'

export type LoadingPhase = 'off' | 'quiet' | 'ravens' | 'wisp'

export interface LoadingInput {
  /** The plate is loading (AppState.plateLoading). */
  loading: boolean
  /** The wait has run past about 1.2 s. */
  long: boolean
  /** The stages the open has passed. */
  stages: ReadonlySet<OpenStage>
}

/** Which wait shows: nothing, nothing yet (a short wait), the ravens before the first frame, the wisp after it. */
export function loadingPhase({ loading, long, stages }: LoadingInput): LoadingPhase {
  if (!loading) return 'off'
  if (stages.has('drawn')) return 'wisp'
  return long ? 'ravens' : 'quiet'
}

/** The status line's words for the step a loading open is in. Stages only add up, so the words only move forward. */
export function loadingWords(stages: ReadonlySet<OpenStage>): string {
  if (!stages.has('read')) return 'Reading the file'
  if (!stages.has('drawn')) return 'Loading the model'
  // a mesh file goes through the engine's repair; a project (unzipped) has its settings checked
  if (!stages.has('repair') && !stages.has('settings')) return stages.has('unzip') ? 'Checking the project' : 'Repairing the model'
  if (!stages.has('settings')) return 'Placing the model'
  return 'Finishing the project'
}
