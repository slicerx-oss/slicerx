// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The loading wait's phase and words, live (loading-phase.ts).
import { useSyncExternalStore } from 'react'
import { onOpenStage, openStagesPassed } from '../lib/open-mark'
import { useWaited } from '../lib/waited'
import { useApp } from '../state/store'
import { loadingPhase, loadingWords, type LoadingPhase } from './loading-phase'

export function useLoading(): { phase: LoadingPhase; words: string } {
  const loading = useApp((s) => s.plateLoading)
  const long = useWaited(loading)
  const stages = useSyncExternalStore(onOpenStage, openStagesPassed, openStagesPassed)
  return { phase: loadingPhase({ loading, long, stages }), words: loadingWords(stages) }
}
