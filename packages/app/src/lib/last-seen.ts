// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When each printer last reported in while reachable. A driver stamps an offline status with the time
// it gave up, so that time is not a sighting; this keeps the last real one, on this computer.
import type { PrinterStatus } from '@slicerx/contracts'

const KEY = 'slicerx.lastSeen'
let seen: Record<string, string> | null = null

function load(): Record<string, string> {
  if (seen) return seen
  try {
    seen = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>
  } catch {
    seen = {}
  }
  return seen
}

let wrote = 0

/** Notes a status: a reachable printer was seen at its `updatedAt`. Stored at most once a minute. */
export function noteStatus(s: PrinterStatus): void {
  if (s.state === 'offline' || !Number.isFinite(Date.parse(s.updatedAt))) return
  load()[s.printerId] = s.updatedAt
  const now = Date.now()
  if (now - wrote < 60_000) return
  wrote = now
  try {
    localStorage.setItem(KEY, JSON.stringify(seen))
  } catch {
    // private mode or full storage: keep it for this session only
  }
}

/** The last time the printer reported in while reachable, if this computer saw it. */
export function lastSeenAt(printerId: string): string | undefined {
  return load()[printerId]
}

/** For tests. */
export function forgetSeen(): void {
  seen = {}
}
