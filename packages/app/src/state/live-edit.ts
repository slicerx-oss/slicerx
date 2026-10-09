// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A live edit is a drag that changes the plate or a setting on every move (a scrub handle, a slider). Auto slice waits
// for its release instead of slicing whenever the pointer pauses, then slices once.
import { get, set } from './store'

const end = (): void => endLiveEdit()

/** A drag that edits the print started. Ends on the next pointer release anywhere, so a lost release never holds slicing. */
export function beginLiveEdit(): void {
  if (get().liveEdit) return
  set({ liveEdit: true })
  if (typeof window === 'undefined') return
  window.addEventListener('pointerup', end, { once: true, capture: true })
  window.addEventListener('pointercancel', end, { once: true, capture: true })
}

/** The drag ended: Auto slice slices what it left. */
export function endLiveEdit(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerup', end, { capture: true })
    window.removeEventListener('pointercancel', end, { capture: true })
  }
  if (get().liveEdit) set({ liveEdit: false })
}
