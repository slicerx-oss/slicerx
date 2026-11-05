// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's question cards for paired phones. The chat registers its open question card here while the mimir tab runs;
// approver phones read the question and answer it, over the LAN through the pairing host (questionFeed) or over the
// relay through the hub (appLink.mimirState and appLink.phoneAnswer). An answer goes to the same pilot.answer a click
// on the card makes, so the first answer wins: a late one, a stale card or a second phone is refused with not_found.
// Cancel is an answer with no choice. An answer unlocks nothing on a printer: anything mimir does next asks for its
// own approval. Agents never reach this; they may turn a question down (mimir.dismiss), never pick its answer.

/** The question card version on the wire (`MIMIR_QUESTION_V` in @slicerx/pair). */
export const PHONE_QUESTION_V = 1

export interface PhoneQuestion {
  v: number
  sessionId: string
  askId: string
  title: string
  question: string
  choices: { id: string; label: string }[]
  at: number
}

export interface PhoneEnded {
  askId: string
  choiceId: string | null
  by: 'app' | 'phone'
  name?: string
}

export interface PhoneState {
  /** A chat that can take an answer is open. False reads as SlicerX closed, never as an answer. */
  live: boolean
  waiting: PhoneQuestion | null
  ended?: PhoneEnded
}

export interface PhoneCards {
  sessionId(): string
  /** The question card waiting in the chat now, or null. */
  open(): { askId: string; title: string; question: string; choices: { id: string; label: string }[] } | null
  /** How a question ended: its pick, or null for a cancel. Undefined when the chat does not know the question. */
  picked(askId: string): string | null | undefined
  /** Answers like a click on the card: a choice id, or null to cancel. Rejects when the question no longer waits. */
  answer(askId: string, choiceId: string | null): Promise<void>
}

/** The words a phone may show for each refusal, the same as the pairing host's. */
export const PHONE_REFUSALS = {
  closed: 'Open the mimir tab in SlicerX on your computer to answer this.',
  gone: 'This question was already answered or is no longer waiting.',
  choice: 'That is not one of the answers.',
} as const

/** A refusal with the code the pairing host reads (`QuestionFeed` in @slicerx/pair). */
export class PhoneAnswerError extends Error {
  constructor(
    readonly code: 'not_found' | 'bad_request' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'PhoneAnswerError'
  }
}

let cards: PhoneCards | null = null
/** Whether phones were last told a chat is open. */
let liveTold = false
let current: PhoneQuestion | null = null
const listeners = new Set<(s: PhoneState) => void>()
/** Questions a phone answered, with its pick and its name; the first answer only. */
const byPhone = new Map<string, { choiceId: string | null; name: string }>()
/** Questions answered on a phone, for the session read-back (mimir.session); the newest 200. */
const answeredOn = new Map<string, string>()
/** When each question was first seen, so `at` stays put while it waits. */
const seenAt = new Map<string, number>()

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The open card as phones read it, or null when it cannot travel (too many choices, ids past the limit). */
function toPhone(sessionId: string, open: NonNullable<ReturnType<PhoneCards['open']>>, now: number): PhoneQuestion | null {
  const choices = open.choices
  if (choices.length === 0 || choices.length > 12 || choices.some((c) => !c.id || c.id.length > 64)) return null
  if (!sessionId || sessionId.length > 128 || !open.askId || open.askId.length > 200) return null
  let at = seenAt.get(open.askId)
  if (at === undefined) {
    at = now
    seenAt.set(open.askId, at)
  }
  return { v: PHONE_QUESTION_V, sessionId, askId: open.askId, title: clip(open.title, 200), question: clip(open.question, 1000), choices: choices.map((c) => ({ id: c.id, label: clip(c.label, 200) })), at }
}

const same = (a: PhoneQuestion | null, b: PhoneQuestion | null) => a?.askId === b?.askId && a?.sessionId === b?.sessionId

/** Reads the chat again and tells phones when the waiting question changed. The chat calls it on every change. */
export function syncPhoneQuestion(now = Date.now(), force = false): void {
  const open = cards?.open() ?? null
  const next = cards && open ? toPhone(cards.sessionId(), open, now) : null
  if (same(current, next) && !force) return
  const was = same(current, next) ? null : current
  current = next
  let ended: PhoneEnded | undefined
  if (was) {
    seenAt.delete(was.askId)
    const phone = byPhone.get(was.askId)
    byPhone.delete(was.askId)
    // a chat that went away, or another chat on screen, ended nothing: only the chat that asked can say how it ended
    if (cards && cards.sessionId() === was.sessionId) {
      if (phone) ended = { askId: was.askId, choiceId: phone.choiceId, by: 'phone', name: phone.name }
      else {
        const picked = cards.picked(was.askId)
        ended = { askId: was.askId, choiceId: picked ? picked : null, by: 'app' }
      }
    }
  }
  const state: PhoneState = { live: cards !== null, waiting: current, ...(ended ? { ended } : {}) }
  liveTold = state.live
  for (const cb of [...listeners]) cb(state)
}

/**
 * The chat whose question cards phones may answer registers here; null takes it away. The tab registers again whenever
 * it rebuilds its runtime, so a null is told to phones only if no chat registers in the same turn: a rebuild with the
 * question still waiting tells them nothing.
 */
export function setPhoneCards(c: PhoneCards | null): void {
  const was = cards !== null
  cards = c
  if (c === null) {
    if (was) queueMicrotask(() => cards === null && syncPhoneQuestion(Date.now(), true))
    return
  }
  // live again after a real close: say so even when the question is the same
  syncPhoneQuestion(Date.now(), !was && !liveTold)
}

/** The question phones see now. `live` is whether a chat that can take an answer is registered. */
export function phoneQuestion(): { live: boolean; waiting: PhoneQuestion | null } {
  return { live: cards !== null, waiting: current }
}

/** Every change to the waiting question; returns how to stop. */
export function onPhoneQuestion(cb: (s: PhoneState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** A paired phone's answer. `choiceId` null cancels the question. The first answer wins. */
export async function answerFromPhone(a: { sessionId: string; askId: string; choiceId: string | null }, phone: { name: string }): Promise<void> {
  if (!cards) throw new PhoneAnswerError('unavailable', PHONE_REFUSALS.closed)
  const open = cards.open()
  if (!open || open.askId !== a.askId || cards.sessionId() !== a.sessionId) throw new PhoneAnswerError('not_found', PHONE_REFUSALS.gone)
  if (a.choiceId !== null && !open.choices.some((c) => c.id === a.choiceId)) throw new PhoneAnswerError('bad_request', PHONE_REFUSALS.choice)
  const mine = !byPhone.has(a.askId)
  if (mine) byPhone.set(a.askId, { choiceId: a.choiceId, name: phone.name.slice(0, 64) || 'Phone' })
  try {
    await cards.answer(a.askId, a.choiceId)
  } catch {
    if (mine) byPhone.delete(a.askId)
    throw new PhoneAnswerError('not_found', PHONE_REFUSALS.gone)
  }
  answeredOn.set(a.askId, byPhone.get(a.askId)?.name ?? (phone.name.slice(0, 64) || 'Phone'))
  if (answeredOn.size > 200) answeredOn.delete(answeredOn.keys().next().value!)
  syncPhoneQuestion()
}

/** The phone that answered a question, by name, when one did; mimir.session reads it back. */
export function phoneAnsweredOn(askId: string): { kind: 'phone'; name: string } | undefined {
  const name = answeredOn.get(askId)
  return name === undefined ? undefined : { kind: 'phone', name }
}

/** The pairing host's view (`QuestionFeed` in @slicerx/pair). */
export const phoneQuestionFeed = {
  state: () => phoneQuestion(),
  onChange: (cb: (s: PhoneState) => void) => onPhoneQuestion(cb),
  answer: (a: { sessionId: string; askId: string; choiceId: string | null }, by: { deviceId: string; name: string }) => answerFromPhone(a, by),
}

/** For tests: forget everything. */
export function resetPhoneQuestions(): void {
  cards = null
  liveTold = false
  current = null
  listeners.clear()
  byPhone.clear()
  seenAt.clear()
  answeredOn.clear()
}
