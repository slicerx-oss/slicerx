// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice's three choices. Auto (the default) slices in the background only when the slice is expected to be short
// (slice-estimate.ts); a big plate waits for Slice, with a quiet note. Always slices after every edit, whatever the
// size; Off slices only when Slice is pressed. The store keeps them as two flags: `autoSlice` (background slicing on or
// off, as before) and `autoSliceBySize` (on: Auto, off: Always), so a saved on/off from before reads as Auto or Off.
import type { AppState } from './store'

export type AutoSliceMode = 'auto' | 'always' | 'off'

export const AUTO_SLICE_MODES: readonly { value: AutoSliceMode; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Slice in the background when the slice is quick; a big plate waits for Slice' },
  { value: 'always', label: 'Always', title: 'Slice in the background after every edit, whatever the size' },
  { value: 'off', label: 'Off', title: 'Slice only when you press Slice' },
]

/** One line for every choice, so the row keeps its height whichever is picked. */
export const AUTO_SLICE_DETAIL = 'Auto slices in the background when the slice is quick, and a big plate waits for Slice. Always slices after every edit; Off only when you press Slice.'

export function autoSliceMode(s: Pick<AppState, 'autoSlice' | 'autoSliceBySize'>): AutoSliceMode {
  return !s.autoSlice ? 'off' : s.autoSliceBySize ? 'auto' : 'always'
}

/** The store fields for a mode. */
export function autoSliceFields(mode: AutoSliceMode): Pick<AppState, 'autoSlice' | 'autoSliceBySize'> {
  return { autoSlice: mode !== 'off', autoSliceBySize: mode !== 'always' }
}
