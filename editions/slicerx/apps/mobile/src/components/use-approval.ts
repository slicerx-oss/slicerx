// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs an approval action once per tap and tracks it: busy while it runs, a plain error if it fails.
// Approving is a tap; there is no biometric or passcode step. Every approval in the app goes through here.
import { useCallback, useRef, useState } from 'react'
import { haptic } from './feedback'

export interface ApprovalRun {
  /** Runs the action. Resolves true when it completed. */
  approve: (action: () => Promise<void> | void) => Promise<boolean>
  busy: boolean
  /** Why the last attempt did not go through, in plain words. */
  error: string | null
  clearError: () => void
}

export function useApproval(): ApprovalRun {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const approve = useCallback(async (action: () => Promise<void> | void) => {
    // A double tap must not send twice.
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      haptic.success()
      return true
    } catch (e) {
      haptic.error()
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Nothing was sent')
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])
  return { approve, busy, error, clearError }
}
