// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MimirQuestion, MimirState } from '@slicerx/pair'
import { GONE, QUESTION_NOTE_MS, QUESTION_RECHECK_MS, type QuestionCard, type QuestionUpdate } from './mimir-questions'
import { watchQuestions } from './question-watch'

/** A refusal as @slicerx/pair's PairError carries it: a code and a message. */
class PairError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const Q: MimirQuestion = { v: 1, sessionId: 's_1', askId: 'ask_1', title: 'Confirm the part', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }], at: 1 }

function harness(opts: { read?: (id: string) => Promise<MimirState>; send?: jest.Mock } = {}) {
  let cards: QuestionCard[] = []
  let push: (u: QuestionUpdate) => void = () => undefined
  const send = opts.send ?? jest.fn(() => Promise.resolve())
  const onNew = jest.fn()
  const w = watchQuestions({
    onUpdate: (cb) => {
      push = cb
      return () => undefined
    },
    read: opts.read ?? (() => Promise.resolve({ live: true, waiting: Q })),
    send,
    cards: () => cards,
    update: (fn) => {
      cards = fn(cards)
    },
    onNew,
  })
  return { w, send, onNew, cards: () => cards, push: (u: Partial<QuestionUpdate>) => push({ pairingId: 'pc-1', hostName: 'Studio Mac', live: true, waiting: Q, ...u }) }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

it('a new question shows once, and an answer goes to the computer with its pick', async () => {
  const h = harness()
  h.push({})
  h.push({})
  expect(h.onNew).toHaveBeenCalledTimes(1)
  await h.w.answer('pc-1', 'other')
  expect(h.send).toHaveBeenCalledWith('pc-1', Q, 'other')
  expect(h.cards()[0]?.answered).toBe('You picked No.')
  // the computer's echo of this answer keeps the phone's own words
  h.push({ waiting: null, ended: { askId: 'ask_1', choiceId: 'other', by: 'phone', name: 'Pocket' } })
  expect(h.cards()[0]?.answered).toBe('You picked No.')
  jest.advanceTimersByTime(QUESTION_NOTE_MS)
  expect(h.cards()).toEqual([])
  h.w.stop()
})

it('Cancel sends no pick', async () => {
  const h = harness()
  h.push({})
  await h.w.answer('pc-1', null)
  expect(h.send).toHaveBeenCalledWith('pc-1', Q, null)
  expect(h.cards()[0]?.answered).toBe('Canceled.')
  h.w.stop()
})

it('the echo that arrives before the reply still reads as this phone', async () => {
  let release: () => void = () => undefined
  const send = jest.fn(() => new Promise<void>((r) => (release = r)))
  const h = harness({ send })
  h.push({})
  const sent = h.w.answer('pc-1', 'same')
  h.push({ waiting: null, ended: { askId: 'ask_1', choiceId: 'same', by: 'phone', name: 'Pocket' } })
  expect(h.cards()[0]?.answered).toBe('You picked Yes.')
  release()
  await sent
  expect(h.cards()[0]?.answered).toBe('You picked Yes.')
  h.w.stop()
})

it('the computer answered first: the late answer closes the card with a note, never an error', async () => {
  const send = jest.fn(() => Promise.reject(new PairError('not_found', 'already answered')))
  const h = harness({ send })
  h.push({})
  await expect(h.w.answer('pc-1', 'same')).resolves.toBeUndefined()
  expect(h.cards()[0]?.answered).toBe(GONE)
  jest.advanceTimersByTime(QUESTION_NOTE_MS)
  expect(h.cards()).toEqual([])
  h.w.stop()
})

it('an older computer answers not_supported: the card stays read-only', async () => {
  const send = jest.fn(() => Promise.reject(new PairError('not_supported', 'Unknown method mimir.answer')))
  const h = harness({ send })
  h.push({})
  await h.w.answer('pc-1', 'same')
  expect(h.cards()[0]).toMatchObject({ reach: 'unsupported' })
  expect(h.cards()[0]?.answered).toBeUndefined()
  // a read-only card never sends
  await h.w.answer('pc-1', 'same')
  expect(send).toHaveBeenCalledTimes(1)
  h.w.stop()
})

it('a send that failed on the way can be tried again', async () => {
  const send = jest.fn().mockRejectedValueOnce(new Error('socket hiccup')).mockResolvedValue(undefined)
  const h = harness({ send })
  h.push({})
  await expect(h.w.answer('pc-1', 'same')).rejects.toThrow('socket hiccup')
  expect(h.cards()[0]).toMatchObject({ reach: 'live' })
  expect(h.cards()[0]?.mine).toBeUndefined()
  await h.w.answer('pc-1', 'same')
  expect(h.cards()[0]?.answered).toBe('You picked Yes.')
  h.w.stop()
})

it('reads the computer again every 10 s, which closes a card answered while an event was missed', async () => {
  const read = jest.fn(() => Promise.resolve({ live: true, waiting: null }))
  const h = harness({ read })
  h.push({})
  jest.advanceTimersByTime(QUESTION_RECHECK_MS)
  await Promise.resolve()
  await Promise.resolve()
  expect(read).toHaveBeenCalledWith('pc-1')
  expect(h.cards()[0]?.answered).toBe(GONE)
  h.w.stop()
})

it('the computer goes out of reach: the card stays without buttons until it is back', () => {
  const h = harness()
  h.push({})
  h.push({ live: false, waiting: null, reachable: false })
  expect(h.cards()[0]?.reach).toBe('unreachable')
  h.push({})
  expect(h.cards()[0]?.reach).toBe('live')
  h.w.stop()
})
