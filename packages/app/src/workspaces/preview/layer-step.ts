// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps the top layer by key. The step starts from the store, not from the last render: two presses that land
// before React draws (a heavy plate redrawing) each count, where a render's value would make them both the same step.
import { get, set } from '../../state/store'

/** The layers in the shown preview, or 0 with none. */
export function layerCountNow(): number {
  const s = get()
  return s.preview?.layerCount ?? (s.slice.status === 'done' ? s.slice.result.layerZ.length : 0)
}

/** Moves the top layer by `by` (or to `to`), clamped to the stack. Returns the layer now on top. */
export function stepLayer(by: number, to?: number): number {
  const n = layerCountNow()
  if (n < 1) return 0
  const s = get()
  const cur = Math.max(1, Math.min(s.layerHi, n))
  const next = Math.max(1, Math.min(n, to ?? cur + by))
  if (next !== s.layerHi || s.moveCut !== 1) set({ layerHi: next, layerLo: Math.min(s.layerLo, next), moveCut: 1, toolChange: null })
  return next
}

/** The layer step a key stands for: 1 for an arrow, 10 for a page key, 0 for any other key. */
export function layerKeyStep(key: string): number {
  return ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 } as Record<string, number>)[key] ?? 0
}
