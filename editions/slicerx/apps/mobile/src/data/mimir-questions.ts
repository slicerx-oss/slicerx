// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The question mimir waits on in SlicerX on a paired computer, as a card on this phone. One card per computer. The
// computer says what waits (mimir.question, or a read of mimir.questions), and this folds each word into the card:
// live with its buttons, read-only with one plain line when the computer cannot take an answer, or answered with a
// short note before it closes. The first answer wins on the computer; a late one here closes with a note, never an error.
import type { MimirEnded, MimirQuestion } from '@slicerx/pair'

/** The question card version this phone answers (`MIMIR_QUESTION_V` in @slicerx/pair). */
export const QUESTION_V = 1
/** How long a card answered here or elsewhere shows its note before it closes. */
export const QUESTION_NOTE_MS = 4_000
/** How often an open card is checked against its computer, for a missed event. */
export const QUESTION_RECHECK_MS = 10_000

/**
 * `live`: the buttons answer it. `closed`: SlicerX on the computer is not running. `unreachable`: the phone cannot
 * reach the computer. `unsupported`: the computer or the card is from a version this phone cannot answer.
 */
export type QuestionReach = 'live' | 'closed' | 'unreachable' | 'unsupported'

export interface QuestionCard {
  /** The computer's pairing id: one card per computer. */
  pairingId: string
  hostName: string
  question: MimirQuestion
  reach: QuestionReach
  /** Set once it was answered: the note the card shows until it closes. */
  answered?: string | undefined
  /** The answer this phone sent, so its own echo never reads as one from somewhere else. */
  mine?: { choiceId: string | null } | undefined
}

/** One word from a computer about its question. `reachable` false: the connection dropped. */
export interface QuestionUpdate {
  pairingId: string
  hostName: string
  live: boolean
  waiting: MimirQuestion | null
  ended?: MimirEnded | undefined
  reachable?: boolean | undefined
}

const label = (q: MimirQuestion, id: string | null) => (id === null ? null : (q.choices.find((c) => c.id === id)?.label ?? id))

/** The one plain line a card shows when it cannot be answered here. */
export function readOnlyLine(c: Pick<QuestionCard, 'reach' | 'hostName'>): string | undefined {
  switch (c.reach) {
    case 'closed':
      return `Open SlicerX on ${c.hostName} to answer this.`
    case 'unreachable':
      return `Can't reach ${c.hostName} right now.`
    case 'unsupported':
      return `Answer this in SlicerX on ${c.hostName}.`
    default:
      return undefined
  }
}

/** The note for a question that ended, given what this phone sent. */
export function endedNote(q: MimirQuestion, e: MimirEnded, mine?: { choiceId: string | null }): string {
  const name = (e.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (mine && e.by === 'phone' && mine.choiceId === e.choiceId) return yourNote(q, mine.choiceId)
  const picked = label(q, e.choiceId)
  if (e.by === 'app') return picked === null ? 'Canceled in SlicerX.' : `Answered in SlicerX: ${picked}.`
  const where = name ? `on ${name}` : 'on another phone'
  return picked === null ? `Canceled ${where}.` : `Answered ${where}: ${picked}.`
}

/** The note for an answer this phone sent. */
export function yourNote(q: MimirQuestion, choiceId: string | null): string {
  const picked = label(q, choiceId)
  return picked === null ? 'Canceled.' : `You picked ${picked}.`
}

/** The note for a card its computer no longer lists. */
export const GONE = 'This question was answered elsewhere.'

const reachOf = (u: QuestionUpdate, q: MimirQuestion): QuestionReach => (u.reachable === false ? 'unreachable' : !u.live ? 'closed' : q.v !== QUESTION_V ? 'unsupported' : 'live')

/** Folds one update into the cards. Returns the same array when nothing changed. */
export function applyUpdate(cards: readonly QuestionCard[], u: QuestionUpdate): QuestionCard[] {
  const at = cards.findIndex((c) => c.pairingId === u.pairingId)
  const card = at === -1 ? undefined : cards[at]
  const put = (next: QuestionCard | null): QuestionCard[] => {
    if (at === -1) return next ? [...cards, next] : (cards as QuestionCard[])
    const out = [...cards]
    if (next) out[at] = next
    else out.splice(at, 1)
    return out
  }
  // a new question, or the same one again
  if (u.waiting && u.live && u.reachable !== false) {
    if (card && card.question.askId === u.waiting.askId && card.question.sessionId === u.waiting.sessionId) {
      const reach = reachOf(u, u.waiting)
      return card.reach === reach && card.hostName === u.hostName ? (cards as QuestionCard[]) : put({ ...card, hostName: u.hostName, reach })
    }
    // a different question: it takes the shown one's place, which ended without a word reaching here
    return put({ pairingId: u.pairingId, hostName: u.hostName, question: u.waiting, reach: reachOf(u, u.waiting) })
  }
  if (!card || card.answered !== undefined) return cards as QuestionCard[]
  // the connection dropped or the app closed: the card stays, read-only, with one line
  if (u.reachable === false || !u.live) {
    const reach: QuestionReach = u.reachable === false ? 'unreachable' : 'closed'
    return card.reach === reach ? (cards as QuestionCard[]) : put({ ...card, reach })
  }
  // live, nothing waits: the shown question ended, here or somewhere else
  const ended = u.ended && u.ended.askId === card.question.askId ? u.ended : undefined
  const note = ended ? endedNote(card.question, ended, card.mine) : card.mine ? yourNote(card.question, card.mine.choiceId) : GONE
  return put({ ...card, answered: note })
}

/** This phone sent an answer the computer took. */
export function answeredHere(cards: readonly QuestionCard[], pairingId: string, choiceId: string | null): QuestionCard[] {
  return cards.map((c) => (c.pairingId === pairingId && c.answered === undefined ? { ...c, mine: { choiceId }, answered: yourNote(c.question, choiceId) } : c))
}

/** An answer this phone sent was refused: `not_found` closes the card with a note, the rest make it read-only. */
export function refused(cards: readonly QuestionCard[], pairingId: string, code: string): QuestionCard[] {
  return cards.map((c) => {
    if (c.pairingId !== pairingId || c.answered !== undefined) return c
    if (code === 'not_found') return { ...c, answered: GONE }
    if (code === 'not_supported' || code === 'bad_request') return { ...c, reach: 'unsupported' }
    if (code === 'unavailable') return { ...c, reach: 'closed' }
    if (code === 'closed') return { ...c, reach: 'unreachable' }
    return c
  })
}
