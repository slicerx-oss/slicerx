// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether the "Print the rest from this height" dialog is open, and which printer asked for it.
import { useSyncExternalStore } from 'react'

export interface ResumeAsk {
  printerName?: string
  /** The layer the printer showed when it stopped, when the status knows it. */
  layer?: number
}

let current: ResumeAsk | null = null
const listeners = new Set<() => void>()

function write(v: ResumeAsk | null): void {
  current = v
  for (const l of listeners) l()
}

export const openResume = (ask: ResumeAsk = {}): void => write(ask)
export const closeResume = (): void => write(null)

export function useResumeAsk(): ResumeAsk | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => null,
  )
}
