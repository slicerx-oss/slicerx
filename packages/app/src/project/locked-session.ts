// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The key of the locked project that is open, so autosave and recovery write it sealed, never in the clear. Held
// in memory only (a non-extractable CryptoKey) and gone when the app closes or the plates are emptied.
import type { SxlockFileKey } from '@slicerx/embed/sxlock'

let open: SxlockFileKey | null = null

export function lockedSession(): SxlockFileKey | null {
  return open
}

export function setLockedSession(key: SxlockFileKey | null): void {
  open = key
}
