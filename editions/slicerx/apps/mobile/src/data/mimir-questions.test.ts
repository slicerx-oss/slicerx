// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MimirQuestion } from '@slicerx/pair'
import { answeredHere, applyUpdate, endedNote, GONE, readOnlyLine, refused, type QuestionCard } from './mimir-questions'

const Q: MimirQuestion = { v: 1, sessionId: 's_1', askId: 'ask_1', title: 'Confirm the part', question: 'Is this the one on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }], at: 1 }
const live = (waiting: MimirQuestion | null, extra: object = {}) => ({ pairingId: 'pc-1', hostName: 'Studio Mac', live: true, waiting, ...extra })
const shown = (): QuestionCard[] => applyUpdate([], live(Q))

describe('question cards from a paired computer', () => {
  it('a waiting question makes a live card, and the same word again changes nothing', () => {
    const cards = shown()
    expect(cards).toEqual([{ pairingId: 'pc-1', hostName: 'Studio Mac', question: Q, reach: 'live' }])
    expect(applyUpdate(cards, live(Q))).toBe(cards)
  })

  it('answered on the computer first: the card says so with the pick', () => {
    expect(applyUpdate(shown(), live(null, { ended: { askId: 'ask_1', choiceId: 'same', by: 'app' } }))[0]?.answered).toBe('Answered in SlicerX: Yes, that one.')
    expect(applyUpdate(shown(), live(null, { ended: { askId: 'ask_1', choiceId: null, by: 'app' } }))[0]?.answered).toBe('Canceled in SlicerX.')
  })

  it('answered on another phone: the card names it', () => {
    expect(applyUpdate(shown(), live(null, { ended: { askId: 'ask_1', choiceId: 'other', by: 'phone', name: 'Tablet' } }))[0]?.answered).toBe('Answered on Tablet: A different model.')
  })

  it("this phone's own answer echoed back reads as its own", () => {
    const mine = shown().map((c) => ({ ...c, mine: { choiceId: 'other' } }))
    expect(applyUpdate(mine, live(null, { ended: { askId: 'ask_1', choiceId: 'other', by: 'phone', name: 'Pocket' } }))[0]?.answered).toBe('You picked A different model.')
    expect(answeredHere(shown(), 'pc-1', null)[0]).toMatchObject({ answered: 'Canceled.', mine: { choiceId: null } })
  })

  it('a stale card: nothing waits and no word says why, so it was answered elsewhere', () => {
    expect(applyUpdate(shown(), live(null))[0]?.answered).toBe(GONE)
  })

  it('a new question replaces the old card', () => {
    const next = applyUpdate(shown(), live({ ...Q, askId: 'ask_2' }))
    expect(next).toHaveLength(1)
    expect(next[0]?.question.askId).toBe('ask_2')
    expect(next[0]?.answered).toBeUndefined()
  })

  it('SlicerX closed or the computer out of reach: the card stays, read-only, with one line', () => {
    const closed = applyUpdate(shown(), { pairingId: 'pc-1', hostName: 'Studio Mac', live: false, waiting: null })
    expect(closed[0]?.reach).toBe('closed')
    expect(readOnlyLine(closed[0]!)).toBe('Open SlicerX on Studio Mac to answer this.')
    const gone = applyUpdate(shown(), { pairingId: 'pc-1', hostName: 'Studio Mac', live: false, waiting: null, reachable: false })
    expect(readOnlyLine(gone[0]!)).toBe("Can't reach Studio Mac right now.")
    // back again with the same question: live once more
    expect(applyUpdate(gone, live(Q))[0]?.reach).toBe('live')
  })

  it('a question of a later version shows without buttons', () => {
    const cards = applyUpdate([], live({ ...Q, v: 2 }))
    expect(cards[0]?.reach).toBe('unsupported')
    expect(readOnlyLine(cards[0]!)).toBe('Answer this in SlicerX on Studio Mac.')
  })

  it('a refused answer settles the card: answered already, an older computer, SlicerX closed', () => {
    expect(refused(shown(), 'pc-1', 'not_found')[0]?.answered).toBe(GONE)
    expect(refused(shown(), 'pc-1', 'not_supported')[0]?.reach).toBe('unsupported')
    expect(refused(shown(), 'pc-1', 'unavailable')[0]?.reach).toBe('closed')
  })

  it('keeps names to one short line', () => {
    expect(endedNote(Q, { askId: 'ask_1', choiceId: null, by: 'phone', name: '  Big\n  phone ' })).toBe('Canceled on Big phone.')
  })
})

describe('after review', () => {
  it('a question still waiting after a word that it was gone comes back live', () => {
    const gone = applyUpdate(shown(), live(null))
    expect(gone[0]?.answered).toBe(GONE)
    const back = applyUpdate(gone, live(Q))
    expect(back[0]).toMatchObject({ reach: 'live' })
    expect(back[0]?.answered).toBeUndefined()
  })

  it('a card answered for real stays answered when the same question is read again', () => {
    const done = applyUpdate(shown(), live(null, { ended: { askId: 'ask_1', choiceId: 'same', by: 'app' } }))
    expect(applyUpdate(done, live(Q))[0]?.answered).toBe('Answered in SlicerX: Yes, that one.')
  })

  it('never shows an internal choice id in a note', () => {
    expect(endedNote(Q, { askId: 'ask_1', choiceId: 'c_3f2a', by: 'app' })).toBe('Answered in SlicerX.')
    expect(endedNote(Q, { askId: 'ask_1', choiceId: 'opt1', by: 'phone', name: 'Pixel' })).toBe('Answered on Pixel.')
    expect(answeredHere(shown(), 'pc-1', 'zzz')[0]?.answered).toBe('You answered.')
  })
})
