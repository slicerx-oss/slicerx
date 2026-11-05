// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps the question cards in step with the paired computers: every word a computer sends goes into the cards
// (./mimir-questions), a card that ended shows its note for a moment and closes, and while a card can be answered its
// computer is read again every 10 s, the net for a missed event. Answering goes through `answer`, so this phone's own
// answer never reads as one from somewhere else, and a refusal (answered already, SlicerX closed, an older computer)
// turns into a note or a read-only line, never an error.
import type { MimirQuestion, MimirState } from '@slicerx/pair'
import { answeredHere, applyUpdate, QUESTION_NOTE_MS, QUESTION_RECHECK_MS, refused, type QuestionCard, type QuestionUpdate } from './mimir-questions'

export interface QuestionWatchDeps {
  onUpdate(cb: (u: QuestionUpdate) => void): () => void
  read(pairingId: string): Promise<MimirState>
  send(pairingId: string, q: MimirQuestion, choiceId: string | null): Promise<void>
  cards(): readonly QuestionCard[]
  update(fn: (cards: QuestionCard[]) => QuestionCard[]): void
  /** A new question to answer arrived (for a local alert). */
  onNew?(card: QuestionCard): void
}

export interface QuestionWatch {
  /** Answers the card of `pairingId`. Resolves once the computer took it or refused it; rejects only on a send that failed. */
  answer(pairingId: string, choiceId: string | null): Promise<void>
  /** The person closed a card: it goes now. */
  dismiss(pairingId: string): void
  stop(): void
}

const codeOf = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : undefined
}

/** Codes that settle the card (a note or a read-only line); anything else is a send that failed, to try again. */
const SETTLES = new Set(['not_found', 'not_supported', 'bad_request', 'unavailable', 'closed'])

export function watchQuestions(d: QuestionWatchDeps): QuestionWatch {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  /** A card that shows a note closes after a moment; one that is live again (the question came back) keeps showing. */
  const schedule = () => {
    for (const [key, t] of timers) {
      if (!d.cards().some((c) => `${c.pairingId}:${c.question.askId}` === key && c.answered !== undefined)) {
        clearTimeout(t)
        timers.delete(key)
      }
    }
    for (const c of d.cards()) {
      const key = `${c.pairingId}:${c.question.askId}`
      if (c.answered === undefined || timers.has(key)) continue
      const t = setTimeout(() => {
        timers.delete(key)
        d.update((cards) => {
          const i = cards.findIndex((x) => x.pairingId === c.pairingId && x.question.askId === c.question.askId && x.answered !== undefined)
          return i === -1 ? cards : cards.filter((_, k) => k !== i)
        })
      }, QUESTION_NOTE_MS)
      timers.set(key, t)
    }
  }

  const apply = (u: QuestionUpdate) => {
    const before = d.cards()
    d.update((cards) => applyUpdate(cards, u))
    const after = d.cards().find((c) => c.pairingId === u.pairingId)
    const was = before.find((c) => c.pairingId === u.pairingId)
    if (after && after.reach === 'live' && after.answered === undefined && (!was || was.question.askId !== after.question.askId)) d.onNew?.(after)
    schedule()
  }

  const off = d.onUpdate(apply)

  const recheck = setInterval(() => {
    for (const c of d.cards()) {
      if (c.answered !== undefined || c.reach === 'unsupported') continue
      d.read(c.pairingId).then(
        (st) => apply({ pairingId: c.pairingId, hostName: c.hostName, ...st }),
        (e: unknown) => {
          if (codeOf(e) === 'not_supported') {
            d.update((cards) => refused(cards, c.pairingId, 'not_supported'))
          }
        },
      )
    }
  }, QUESTION_RECHECK_MS)

  return {
    async answer(pairingId, choiceId) {
      const card = d.cards().find((c) => c.pairingId === pairingId && c.answered === undefined)
      if (!card || card.reach !== 'live') return
      const askId = card.question.askId
      const mark = (mine: { choiceId: string | null } | undefined) =>
        d.update((cards) => cards.map((c) => (c.pairingId === pairingId && c.question.askId === askId && c.answered === undefined ? { ...c, mine } : c)))
      // marked before it goes, so the computer's word that it ended reads as this phone's own answer
      mark({ choiceId })
      try {
        await d.send(pairingId, card.question, choiceId)
      } catch (e) {
        const code = codeOf(e)
        mark(undefined)
        if (code === undefined || !SETTLES.has(code)) throw e
        d.update((cards) => refused(cards, pairingId, code))
        schedule()
        return
      }
      d.update((cards) => answeredHere(cards, pairingId, choiceId))
      schedule()
    },
    dismiss(pairingId) {
      d.update((cards) => cards.filter((c) => c.pairingId !== pairingId))
    },
    stop() {
      off()
      clearInterval(recheck)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}
