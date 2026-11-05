// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What phones hear while the mimir tab rebuilds its runtime, switches chats or closes: a rebuild ends nothing (the run
// and its cards still wait), a chat switch never claims an answer, and a closed tab reads as not live. The pane's
// approval cards, as paneApprovalCards builds them from the transcript, are only the ones still waiting in a running
// reply, and each ends with how it really ended.
import type { ApprovalRequest, PilotEvent } from '@slicerx/contracts'
import { emptyTranscript, foldEvents, startTurn, type Transcript } from '@slicerx/pilot/ui'
import { afterEach, describe, expect, it } from 'vitest'
import { onPhoneQuestion, phoneQuestion, resetPhoneQuestions, setPhoneCards, type PhoneCards, type PhoneState } from '../src/workspaces/mimir/phone-answers'
import { paneApprovalCards, phoneApprovalFeed, resetPhoneApprovals, setPhoneApprovals, syncPhoneApprovals } from '../src/workspaces/mimir/phone-approvals'

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const OPEN = { askId: 'ask_1', title: 'Confirm the part', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }] }
const cardsFor = (sessionId: string, open: PhoneCards['open'] = () => OPEN): PhoneCards => ({ sessionId: () => sessionId, open, picked: () => undefined, answer: async () => undefined })

const req = (id: string): ApprovalRequest => ({ id, sessionId: 's_1', tool: 'printer.pause', permission: 'start', title: 'Pause Bay 2?', lines: [], paramsHash: 'a'.repeat(64), actions: [], expiresAt: new Date(Date.now() + 60_000).toISOString() })

afterEach(() => {
  resetPhoneQuestions()
  resetPhoneApprovals()
})

describe('questions while the tab rebuilds, switches or closes', () => {
  it('a runtime rebuild with the question still waiting tells phones nothing new', async () => {
    const seen: PhoneState[] = []
    setPhoneCards(cardsFor('s_1'))
    onPhoneQuestion((s) => seen.push(s))
    // the pane's effect cleans up and registers again in one commit
    setPhoneCards(null)
    setPhoneCards(cardsFor('s_1'))
    await settle()
    expect(seen.filter((s) => s.waiting === null)).toEqual([])
    expect(seen.some((s) => s.ended)).toBe(false)
    expect(phoneQuestion()).toMatchObject({ live: true, waiting: { askId: 'ask_1' } })
  })

  it('a tab that closes reads as not live, never as an answer', async () => {
    const seen: PhoneState[] = []
    setPhoneCards(cardsFor('s_1'))
    onPhoneQuestion((s) => seen.push(s))
    setPhoneCards(null)
    await settle()
    expect(seen).toEqual([{ live: false, waiting: null }])
  })

  it('every state says whether a chat can take an answer', () => {
    const seen: PhoneState[] = []
    onPhoneQuestion((s) => seen.push(s))
    setPhoneCards(cardsFor('s_1'))
    expect(seen.at(-1)).toMatchObject({ live: true, waiting: { askId: 'ask_1' } })
  })

  it('switching to another chat while a question waits claims no answer', async () => {
    const seen: PhoneState[] = []
    setPhoneCards(cardsFor('s_1'))
    onPhoneQuestion((s) => seen.push(s))
    setPhoneCards(cardsFor('s_2', () => null))
    await settle()
    expect(seen.some((s) => s.ended)).toBe(false)
    expect(seen.at(-1)).toMatchObject({ live: true, waiting: null })
  })

  it('a question that cannot travel (13 choices, a long id) shows phones nothing', () => {
    setPhoneCards(cardsFor('s_1', () => ({ ...OPEN, choices: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, label: 'x' })) })))
    expect(phoneQuestion().waiting).toBeNull()
    setPhoneCards(cardsFor('s_1', () => ({ ...OPEN, choices: [{ id: 'x'.repeat(65), label: 'x' }] })))
    expect(phoneQuestion().waiting).toBeNull()
  })
})

describe('approval cards while the tab rebuilds or closes', () => {
  function track() {
    const requests: string[] = []
    const resolved: [string, string][] = []
    phoneApprovalFeed.onRequest((r) => requests.push(r.id))
    phoneApprovalFeed.onResolved((id, d) => resolved.push([id, d]))
    return { requests, resolved }
  }

  it('a runtime rebuild with a card still waiting reports nothing ended and nothing new', async () => {
    const pending = [req('apr_1')]
    setPhoneApprovals({ pending: () => pending, outcome: () => undefined, resolve: async () => undefined })
    const t = track()
    setPhoneApprovals(null)
    setPhoneApprovals({ pending: () => pending, outcome: () => undefined, resolve: async () => undefined })
    await settle()
    expect(t.resolved).toEqual([])
    expect(t.requests).toEqual([])
    expect(phoneApprovalFeed.pending().map((r) => r.id)).toEqual(['apr_1'])
  })

  it('a tab that closes reports its cards as run out', async () => {
    setPhoneApprovals({ pending: () => [req('apr_1')], outcome: () => undefined, resolve: async () => undefined })
    const t = track()
    setPhoneApprovals(null)
    await settle()
    expect(t.resolved).toEqual([['apr_1', 'expired']])
  })

  it('a card the desktop answers first ends as it ended, and a late phone decision is refused', async () => {
    let pending = [req('apr_1')]
    const outcomes = new Map<string, 'approve' | 'deny'>()
    setPhoneApprovals({ pending: () => pending, outcome: (id) => outcomes.get(id), resolve: async () => undefined })
    const t = track()
    pending = []
    outcomes.set('apr_1', 'deny')
    syncPhoneApprovals()
    expect(t.resolved).toEqual([['apr_1', 'deny']])
    await expect(phoneApprovalFeed.decide('apr_1', { kind: 'approve' }, { deviceId: 'd', name: 'Pocket' })).rejects.toThrow('This request was already decided or has expired')
  })
})

describe('the pane approval cards, from the transcript', () => {
  const fold = (events: PilotEvent[], status: Transcript['status'] = 'running', replay = false): Transcript => {
    let tr = startTurn(emptyTranscript(), { user: 'pause it' }, 0)
    if (replay) tr = { ...tr, turns: tr.turns.map((x) => ({ ...x, replay: true })) }
    tr = foldEvents(events, tr)
    return { ...tr, status }
  }

  it('lists the cards still waiting in a running reply, and none from a saved log or a stopped one', () => {
    const asked = [{ type: 'approval_request', request: req('apr_1') } as PilotEvent, { type: 'approval_request', request: req('apr_2') } as PilotEvent, { type: 'approval_resolved', requestId: 'apr_2', decision: { kind: 'approve' }, by: 'user' } as PilotEvent]
    expect(paneApprovalCards(() => fold(asked), { resolveApproval: async () => undefined }).pending().map((r) => r.id)).toEqual(['apr_1'])
    expect(paneApprovalCards(() => fold(asked, 'done'), { resolveApproval: async () => undefined }).pending()).toEqual([])
    expect(paneApprovalCards(() => fold(asked, 'running', true), { resolveApproval: async () => undefined }).pending()).toEqual([])
  })

  it('says how each card ended: approved, denied, or run out', () => {
    const tr = fold([
      { type: 'approval_request', request: req('a') } as PilotEvent,
      { type: 'approval_request', request: req('d') } as PilotEvent,
      { type: 'approval_request', request: req('e') } as PilotEvent,
      { type: 'approval_resolved', requestId: 'a', decision: { kind: 'approve' }, by: 'user' } as PilotEvent,
      { type: 'approval_resolved', requestId: 'd', decision: { kind: 'deny', reason: 'canceled' }, by: 'user' } as PilotEvent,
      { type: 'approval_resolved', requestId: 'e', decision: { kind: 'deny', reason: 'expired' }, by: 'expiry' } as PilotEvent,
    ])
    const cards = paneApprovalCards(() => tr, { resolveApproval: async () => undefined })
    expect(['a', 'd', 'e', 'x'].map((id) => cards.outcome(id))).toEqual(['approve', 'deny', 'expired', undefined])
  })

  it("a phone's decision goes to pilot.resolveApproval, as a click does", async () => {
    const calls: unknown[] = []
    const tr = fold([{ type: 'approval_request', request: req('apr_1') } as PilotEvent])
    setPhoneApprovals(paneApprovalCards(() => tr, { resolveApproval: async (id, d) => void calls.push([id, d]) }))
    await phoneApprovalFeed.decide('apr_1', { kind: 'approve', bedClear: true }, { deviceId: 'd', name: 'Pocket' })
    expect(calls).toEqual([['apr_1', { kind: 'approve', bedClear: true }]])
  })
})
