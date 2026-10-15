// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The live view's small read-back, without loading the renderer or keeping frame samples in app state.
import type { ViewportStats } from '@slicerx/viewport'

export type ViewportTelemetry = Pick<ViewportStats, 'pixelRatio' | 'motionScale' | 'motionFull' | 'degrade'>
let source: (() => ViewportTelemetry | null) | null = null

export function viewportStatsFrom(read: () => ViewportTelemetry | null): () => void {
  source = read
  return () => {
    if (source === read) source = null
  }
}

/** Null before a GPU view mounts, in the 2D fallback, and after the view unmounts. */
export function readViewportStats(): ViewportTelemetry | null {
  const stats = source?.()
  return stats ? { pixelRatio: stats.pixelRatio, motionScale: stats.motionScale, motionFull: stats.motionFull, degrade: { ...stats.degrade } } : null
}
