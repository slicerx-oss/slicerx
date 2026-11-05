// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HostConnection, MimirState } from '@slicerx/pair'
import { hookQuestions, type ComputerQuestion } from './questions'

const Q = { v: 1, sessionId: 's_1', askId: 'ask_1', title: 'Confirm', question: 'This one?', choices: [{ id: 'same', label: 'Yes' }], at: 1 }

function fakeConn(info: { mimir?: boolean; approve: boolean }, read: MimirState = { live: true, waiting: Q }) {
  const events = new Set<(d: unknown) => void>()
  const closes = new Set<() => void>()
  const mimirQuestions = jest.fn(() => Promise.resolve(read))
  const conn = {
    info: { identity: { name: 'Studio Mac' }, mimir: info.mimir, rights: { request: true, approve: info.approve, introduce: false } },
    on: jest.fn((ev: string, cb: (d: unknown) => void) => {
      if (ev === 'mimir.question') events.add(cb)
      return () => events.delete(cb)
    }),
    onClose: (cb: () => void) => {
      closes.add(cb)
      return () => closes.delete(cb)
    },
    mimirQuestions,
  } as unknown as Pick<HostConnection, 'info' | 'on' | 'onClose' | 'mimirQuestions'>
  return { conn, mimirQuestions, emit: (d: unknown) => events.forEach((cb) => cb(d)), close: () => closes.forEach((cb) => cb()), listeners: () => events.size }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

it('a computer that offers questions to an approver phone: a first read, its changes, and out of reach on close', async () => {
  const f = fakeConn({ mimir: true, approve: true })
  const seen: ComputerQuestion[] = []
  hookQuestions(f.conn, 'pc-1', (q) => seen.push(q))
  await flush()
  expect(seen).toEqual([{ pairingId: 'pc-1', hostName: 'Studio Mac', live: true, waiting: Q }])
  f.emit({ live: true, waiting: null, ended: { askId: 'ask_1', choiceId: 'same', by: 'app' } })
  expect(seen.at(-1)).toMatchObject({ waiting: null, ended: { by: 'app' } })
  f.close()
  expect(seen.at(-1)).toEqual({ pairingId: 'pc-1', hostName: 'Studio Mac', live: false, waiting: null, reachable: false })
})

it.each([
  ['a computer from before questions', { approve: true }],
  ['a computer that says no', { mimir: false, approve: true }],
  ['a phone without the approve right there', { mimir: true, approve: false }],
])('%s: no read, no listener, no card', async (_name, info) => {
  const f = fakeConn(info)
  const seen: ComputerQuestion[] = []
  hookQuestions(f.conn, 'pc-1', (q) => seen.push(q))
  await flush()
  f.emit({ live: true, waiting: Q })
  expect(f.mimirQuestions).not.toHaveBeenCalled()
  expect(f.listeners()).toBe(0)
  expect(seen).toEqual([])
})

it('stopping detaches the listener, so a reconnect never doubles an event', async () => {
  const f = fakeConn({ mimir: true, approve: true })
  const seen: ComputerQuestion[] = []
  const stop = hookQuestions(f.conn, 'pc-1', (q) => seen.push(q))
  await flush()
  stop()
  expect(f.listeners()).toBe(0)
  const g = fakeConn({ mimir: true, approve: true })
  hookQuestions(g.conn, 'pc-1', (q) => seen.push(q))
  await flush()
  f.emit({ live: true, waiting: null })
  g.emit({ live: true, waiting: null })
  expect(seen.filter((q) => q.waiting === null)).toHaveLength(1)
})
