// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The purges Preview plays (purge-data.ts reads them from the G-code) and the playback bar's readout of them.
import { flushedShare, type PurgePlan, type PurgeWindow } from '@slicerx/viewport'
import { createStore, useStore } from 'zustand'
import type { Timeline } from '../../lib/preview-timeline'

export interface PlayPurge extends PurgePlan {
  /** When the flush runs inside its change. */
  window: PurgeWindow
  /** Grams purged by the changes before this one. */
  before: number
}

interface PurgeState {
  /** The playback timeline the plans belong to (one per preview and tool changer). */
  timeline: Timeline | null
  plans: PlayPurge[]
}

export const purgeView = createStore<PurgeState>()(() => ({ timeline: null, plans: [] }))

export function usePurgeView<T>(pick: (s: PurgeState) => T): T {
  return useStore(purgeView, pick)
}

/** Grams purged in the change at `segment`, `seconds` into it, and for the print so far; null outside a purge. */
export function purgeReadout(plans: readonly PlayPurge[], change: { segment: number; seconds: number } | null): { now: number; total: number } | null {
  if (!change) return null
  let lo = 0
  let hi = plans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const pl = plans[mid]!
    if (pl.segment === change.segment) {
      if (change.seconds < pl.window.start) return null
      const now = pl.grams * flushedShare(pl, pl.window, change.seconds)
      return { now, total: pl.before + now }
    }
    if (pl.segment < change.segment) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

