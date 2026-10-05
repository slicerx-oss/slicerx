// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where slicing happens, as the Slice panel says it. A feature that routes
// slices elsewhere (cloud slicing) registers a note here.
import { useSyncExternalStore } from 'react'

let note: string | null = null
const listeners = new Set<() => void>()

/** Sets the Slice panel's note, or null to fall back to the host's own. */
export function setSliceNote(text: string | null): void {
  note = text
  for (const l of listeners) l()
}

export function useSliceNote(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => note,
    () => note,
  )
}
