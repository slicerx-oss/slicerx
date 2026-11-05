// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's approval cards for phones paired on the LAN. The mimir tab registers the cards waiting in its running reply;
// the pairing host (approvalFeed) shows them to phones with the approve right and takes their signed decisions, which
// go to the same pilot.resolveApproval a click on the card makes. Over the relay the hub carries mimir's cards itself.
import type { ApprovalDecision, ApprovalRequest, Pilot } from '@slicerx/contracts'
import type { Transcript } from '@slicerx/pilot/ui'

export interface PhoneApprovalCards {
  /** The approval cards waiting in the chat's running reply, oldest first. */
  pending(): ApprovalRequest[]
  /** How a card ended, once it did: approved, denied, or ran out. Undefined while it waits or when the chat does not know it. */
  outcome(requestId: string): 'approve' | 'deny' | 'expired' | undefined
  /** Decides like a click on the card. Rejects when the card no longer waits. */
  resolve(requestId: string, decision: ApprovalDecision): Promise<void>
}

/** The mimir pane's cards: the ones still waiting in its running reply, and how each ended. */
export function paneApprovalCards(transcript: () => Transcript, pilot: Pick<Pilot, 'resolveApproval'>): PhoneApprovalCards {
  return {
    pending: () => {
      const t = transcript()
      if (t.status !== 'running') return []
      const out: ApprovalRequest[] = []
      for (const turn of t.turns) for (const b of turn.blocks) if (b.kind === 'approval' && b.resolution === null && !b.replay) out.push(b.request)
      return out
    },
    outcome: (id) => {
      for (const turn of transcript().turns)
        for (const b of turn.blocks) if (b.kind === 'approval' && b.request.id === id && b.resolution) return b.resolution.by === 'expiry' ? 'expired' : b.resolution.decision.kind
      return undefined
    },
    resolve: (id, decision) => pilot.resolveApproval(id, decision),
  }
}

let cards: PhoneApprovalCards | null = null
/** The ids phones were told about, in order. */
let shown: ApprovalRequest[] = []
const requestCbs = new Set<(r: ApprovalRequest) => void>()
const resolvedCbs = new Set<(id: string, d: 'approve' | 'deny' | 'expired') => void>()

/** Reads the chat again and tells phones about new cards and cards that ended. The chat calls it on every change. */
export function syncPhoneApprovals(): void {
  const now = cards?.pending() ?? []
  const ids = new Set(now.map((r) => r.id))
  const before = new Set(shown.map((r) => r.id))
  const ended = shown.filter((r) => !ids.has(r.id))
  shown = now
  for (const r of now) if (!before.has(r.id)) for (const cb of [...requestCbs]) cb(r)
  // a card that went with its chat ran out as far as a phone can tell
  for (const r of ended) {
    const d = cards?.outcome(r.id) ?? 'expired'
    for (const cb of [...resolvedCbs]) cb(r.id, d)
  }
}

/** The chat whose approval cards LAN phones may decide registers here; null takes it away. */
export function setPhoneApprovals(c: PhoneApprovalCards | null): void {
  cards = c
  // the tab registers again whenever it rebuilds its runtime: its cards end only if no chat registers in the same turn,
  // and the next registration's own cards decide what ended
  if (c === null) queueMicrotask(() => cards === null && syncPhoneApprovals())
  else syncPhoneApprovals()
}

/** The pairing host's view (`ApprovalFeed` in @slicerx/pair). */
export const phoneApprovalFeed = {
  pending: (): ApprovalRequest[] => [...shown],
  onRequest(cb: (r: ApprovalRequest) => void): () => void {
    requestCbs.add(cb)
    return () => requestCbs.delete(cb)
  },
  onResolved(cb: (id: string, d: 'approve' | 'deny' | 'expired') => void): () => void {
    resolvedCbs.add(cb)
    return () => resolvedCbs.delete(cb)
  },
  async decide(requestId: string, decision: ApprovalDecision, _by: { deviceId: string; name: string }): Promise<void> {
    if (!cards || !shown.some((r) => r.id === requestId)) throw new Error('This request was already decided or has expired')
    await cards.resolve(requestId, decision)
    syncPhoneApprovals()
  },
}

/** For tests: forget everything. */
export function resetPhoneApprovals(): void {
  cards = null
  shown = []
  requestCbs.clear()
  resolvedCbs.clear()
}
