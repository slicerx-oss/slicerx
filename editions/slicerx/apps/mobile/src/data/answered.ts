// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A request this phone shows can be answered somewhere else: in SlicerX on the computer, by a
// partner app, by the agent that asked, or on another phone. Its card then closes with a short
// note of how. As a safety net for a missed event, while a card is open the computer's list is
// read again every 10 s, and a card it no longer lists closes too.
import type { ComputerResolved } from '../pair'
import type { WaitingApproval } from '../state/store'

/** How often the open cards are checked against their computer's list. */
export const RECHECK_MS = 10_000
/** How long a card answered elsewhere shows its note before it closes. */
export const NOTE_MS = 4_000
/** The note for a card its computer no longer lists. */
export const GONE_NOTE = 'This request was answered elsewhere.'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The note shown on a card that was answered somewhere else. */
export function answeredNote(r: Pick<ComputerResolved, 'decision' | 'by' | 'via'>): string {
  if (r.decision === 'expired') return 'This request expired.'
  const yes = r.decision === 'approve'
  const name = oneLine(r.by).slice(0, 60)
  switch (r.via) {
    case 'app':
      return yes ? 'Approved in SlicerX.' : 'Denied in SlicerX.'
    case 'partner': {
      const who = name || 'The partner app'
      return yes ? `${who} answered it.` : `${who} withdrew it.`
    }
    case 'agent':
      return yes ? 'The agent that asked answered it.' : 'The agent that asked withdrew it.'
    case 'phone':
      return yes ? 'Approved on another phone.' : 'Denied on another phone.'
    default:
      break
  }
  // A computer that names only who answered: SlicerX's own card, the clock, or another device.
  if (r.by === 'this computer' || r.by === 'host') return yes ? 'Approved in SlicerX.' : 'Denied in SlicerX.'
  if (r.by === 'expiry') return 'This request expired.'
  if (!name) return yes ? 'Approved elsewhere.' : 'Denied elsewhere.'
  return yes ? `Approved on ${name}.` : `Denied on ${name}.`
}

export interface AnsweredDeps {
  onResolved(cb: (r: ComputerResolved) => void): () => void
  /** The ids of the requests a computer still lists. Rejects when it cannot be reached. */
  openIds(pairingId: string): Promise<string[]>
  waiting(): readonly WaitingApproval[]
  markAnswered(id: string, note: string): void
  settle(id: string): void
}

export interface AnsweredWatch {
  /** The request was answered before its card showed: do not show it. */
  gone(id: string): boolean
  /** Wraps a card's `decide`, so this phone's own answer never reads as one from somewhere else. */
  own<T extends WaitingApproval>(a: T): T
  stop(): void
}

export function watchAnswered(d: AnsweredDeps): AnsweredWatch {
  const gone = new Set<string>()
  /** Requests this phone is answering, or answered. */
  const mine = new Set<string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const close = (id: string, note: string) => {
    const w = d.waiting().find((x) => x.id === id)
    if (!w || w.answered !== undefined) return
    d.markAnswered(id, note)
    const t = setTimeout(() => {
      timers.delete(t)
      d.settle(id)
    }, NOTE_MS)
    timers.add(t)
  }

  const offResolved = d.onResolved((r) => {
    if (mine.has(r.requestId)) return
    gone.add(r.requestId)
    close(r.requestId, answeredNote(r))
  })

  const recheck = setInterval(() => {
    const byPairing = new Map<string, string[]>()
    for (const w of d.waiting()) {
      if (!w.pairingId || w.answered !== undefined || mine.has(w.id)) continue
      byPairing.set(w.pairingId, [...(byPairing.get(w.pairingId) ?? []), w.id])
    }
    for (const [pairingId, ids] of byPairing) {
      d.openIds(pairingId).then(
        (listed) => {
          const open = new Set(listed)
          for (const id of ids) {
            if (open.has(id) || mine.has(id)) continue
            gone.add(id)
            close(id, GONE_NOTE)
          }
        },
        () => undefined,
      )
    }
  }, RECHECK_MS)

  return {
    gone: (id) => gone.has(id),
    own(a) {
      return {
        ...a,
        decide: async (decision, opts) => {
          mine.add(a.id)
          try {
            await a.decide(decision, opts)
          } catch (e) {
            mine.delete(a.id)
            throw e
          }
        },
      }
    },
    stop() {
      offResolved()
      clearInterval(recheck)
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
}
