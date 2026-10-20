// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The send card's ledger (docs/safety.md). When the person ticks the bed and presses Print on mimir's send card, the
// card writes one entry for that request, printer and file. The guard takes it at upload time to skip its own second
// card, once. Only the send card's Print click handler calls `mark`: no tool, model output, MCP client or app link
// call reaches this module. Without an entry, the guard shows its own bed-clear card as before.

export interface SendLedger {
  /** Written only by the send card's Print click handler. */
  mark(requestId: string, printerId: string, sha256: string, expiresAt: string): void
  /** True once for an entry that matches the printer and file and has not expired. Any take uses the entry up. */
  take(requestId: string, printerId: string, sha256: string): boolean
  /** How many entries are kept, for tests. */
  size(): number
}

interface Entry {
  printerId: string
  sha256: string
  expiresMs: number
}

export function createSendLedger(now: () => number = Date.now): SendLedger {
  const entries = new Map<string, Entry>()
  return {
    mark(requestId, printerId, sha256, expiresAt) {
      const expiresMs = Date.parse(expiresAt)
      // entries never taken (an answer that failed to send) go once they expire
      const t = now()
      for (const [id, e] of entries) if (e.expiresMs < t) entries.delete(id)
      if (!requestId || !printerId || !sha256 || !Number.isFinite(expiresMs)) return
      entries.set(requestId, { printerId, sha256, expiresMs })
    },
    take(requestId, printerId, sha256) {
      const e = entries.get(requestId)
      if (!e) return false
      // single use: a take for another printer or file burns the entry too
      entries.delete(requestId)
      return e.printerId === printerId && e.sha256 === sha256 && now() <= e.expiresMs
    },
    size: () => entries.size,
  }
}

/** The app's one ledger, shared by the send card and the guard mimir's printers go through. */
export const sendLedger: SendLedger = createSendLedger()
