// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Show me for a check that blocks a print: Slice with the toolpaths, at the first layer where it goes wrong, and for
// a collision the moment and the spot it happens, as heimdall's own list jumps there.
import { get, set, showSliced } from '../state/store'
import type { PreflightSpot } from './preflight'

export async function showSpot(spot: PreflightSpot): Promise<void> {
  showSliced()
  if (spot.kind === 'collision') {
    const { jumpTo } = await import('./heimdall-jump')
    jumpTo(spot.index)
    return
  }
  const n = get().preview?.layerCount ?? 0
  if (n > 0) set({ layerLo: 1, layerHi: Math.min(n, spot.layer + 1), moveCut: 1 })
}
