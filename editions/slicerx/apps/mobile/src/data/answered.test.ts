// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApprovalRequest } from '@slicerx/contracts'
import type { ComputerResolved } from '../pair'
import type { WaitingApproval } from '../state/store'
import { answeredNote, GONE_NOTE, NOTE_MS, RECHECK_MS, watchAnswered } from './answered'

const req = (id: string): ApprovalRequest => ({
  id,
  sessionId: 's',
  tool: 'printer.pause',
  permission: 'start',
  title: 'Pause Bay 4?',
  lines: [],
  paramsHash: 'x',
  actions: [],
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})
const card = (id: string, pairingId = 'pc-1'): WaitingApproval => ({ id, hostName: 'Studio Mac', pairingId, request: req(id), source: 'host', decide: jest.fn(() => Promise.resolve()) })

function harness(listed: Record<string, string[]> = {}) {
  let waiting: WaitingApproval[] = []
  const resolved = new Set<(r: ComputerResolved) => void>()
  const openIds = jest.fn((p: string) => Promise.resolve(listed[p] ?? []))
  const w = watchAnswered({
    onResolved: (cb) => {
      resolved.add(cb)
      return () => resolved.delete(cb)
    },
    openIds,
    waiting: () => waiting,
    markAnswered: (id, note) => {
      waiting = waiting.map((x) => (x.id === id ? { ...x, answered: note } : x))
    },
    settle: (id) => {
      waiting = waiting.filter((x) => x.id !== id)
    },
  })
  return {
    w,
    openIds,
    add: (a: WaitingApproval) => {
      waiting = [...waiting, w.own(a)]
    },
    card: (id: string) => waiting.find((x) => x.id === id),
    resolve: (r: Omit<ComputerResolved, 'pairingId'>) => {
      for (const cb of [...resolved]) cb({ pairingId: 'pc-1', ...r })
    },
  }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

it('closes a card answered in SlicerX with a note, then lets it go', () => {
  const h = harness()
  h.add(card('a'))
  h.resolve({ requestId: 'a', decision: 'approve', by: 'app', via: 'app' })
  expect(h.card('a')?.answered).toBe('Approved in SlicerX.')
  jest.advanceTimersByTime(NOTE_MS)
  expect(h.card('a')).toBeUndefined()
  h.w.stop()
})

it('says which partner app answered or withdrew it, and when its agent withdrew it', () => {
  const h = harness()
  for (const id of ['p1', 'p2', 'g1']) h.add(card(id))
  h.resolve({ requestId: 'p1', decision: 'approve', by: 'LayerMate', via: 'partner' })
  h.resolve({ requestId: 'p2', decision: 'deny', by: 'LayerMate', via: 'partner' })
  h.resolve({ requestId: 'g1', decision: 'deny', by: 'agent', via: 'agent' })
  expect(h.card('p1')?.answered).toBe('LayerMate answered it.')
  expect(h.card('p2')?.answered).toBe('LayerMate withdrew it.')
  expect(h.card('g1')?.answered).toBe('The agent that asked withdrew it.')
  h.w.stop()
})

it('words what a computer without via sends', () => {
  expect(answeredNote({ decision: 'approve', by: 'this computer' })).toBe('Approved in SlicerX.')
  expect(answeredNote({ decision: 'deny', by: 'Sam iPad' })).toBe('Denied on Sam iPad.')
  expect(answeredNote({ decision: 'expired', by: 'expiry' })).toBe('This request expired.')
  expect(answeredNote({ decision: 'deny', by: 'phone', via: 'phone' })).toBe('Denied on another phone.')
})

it('never puts a note on the answer this phone gave itself', async () => {
  const h = harness()
  h.add(card('a'))
  await h.card('a')?.decide('deny')
  h.resolve({ requestId: 'a', decision: 'deny', by: 'phone', via: 'phone' })
  expect(h.card('a')?.answered).toBeUndefined()
  h.w.stop()
})

it('remembers a request answered before its card showed', () => {
  const h = harness()
  h.resolve({ requestId: 'late', decision: 'deny', by: 'agent', via: 'agent' })
  expect(h.w.gone('late')).toBe(true)
  expect(h.w.gone('other')).toBe(false)
  h.w.stop()
})

it('every 10 s drops open cards the computer no longer lists', async () => {
  const h = harness({ 'pc-1': ['kept'] })
  h.add(card('kept'))
  h.add(card('dropped'))
  jest.advanceTimersByTime(RECHECK_MS - 1)
  expect(h.openIds).not.toHaveBeenCalled()
  jest.advanceTimersByTime(1)
  await Promise.resolve()
  expect(h.openIds).toHaveBeenCalledWith('pc-1')
  expect(h.card('dropped')?.answered).toBe(GONE_NOTE)
  expect(h.card('kept')?.answered).toBeUndefined()
  jest.advanceTimersByTime(NOTE_MS)
  expect(h.card('dropped')).toBeUndefined()
  expect(h.card('kept')).toBeDefined()
  h.w.stop()
})

it('reads nothing while no card is open', () => {
  const h = harness()
  jest.advanceTimersByTime(3 * RECHECK_MS)
  expect(h.openIds).not.toHaveBeenCalled()
  h.w.stop()
})
