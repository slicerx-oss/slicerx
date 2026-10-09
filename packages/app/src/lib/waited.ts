// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Huginn and Muninn show up only for a wait worth noticing: one that has gone on for more than about 1.2 s.
import { useEffect, useState } from 'react'

/** How long a wait runs before the ravens come. */
export const RAVEN_WAIT_MS = 1200

/** True once `on` has held for `ms`; false again as soon as it ends. */
export function useWaited(on: boolean, ms = RAVEN_WAIT_MS): boolean {
  const [long, setLong] = useState(false)
  useEffect(() => {
    if (!on) return setLong(false)
    const t = window.setTimeout(() => setLong(true), ms)
    return () => window.clearTimeout(t)
  }, [on, ms])
  return long
}
