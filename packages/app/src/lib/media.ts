// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useSyncExternalStore } from 'react'
import { motionReduced } from '@slicerx/ui'

export function useMediaQuery(query: string): boolean {
  // Without matchMedia (a test DOM, an old embedded view) no query matches.
  const has = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  return useSyncExternalStore(
    (cb) => {
      if (!has) return () => {}
      const m = window.matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => has && window.matchMedia(query).matches,
    () => false,
  )
}

/** True when motion is reduced: the in-app Motion choice, which may follow the system. */
export function prefersReducedMotion(): boolean {
  return motionReduced()
}
