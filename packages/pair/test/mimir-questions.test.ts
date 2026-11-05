// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's question cards on a paired phone: an approver phone reads the question the desktop app waits on, answers it
// (a choice or a cancel), and hears when it ends. The first answer wins; a late or stale one is refused with not_found.
// A phone without the approve right reads and answers nothing, and a computer from before it existed says not_supported.
import { describe, expect, it } from 'vitest'
import type { HostConnection } from '../src/client'
import type { MimirAnswerAudit, QuestionFeed } from '../src/host'
import { fromB64url } from '../src/bytes'
import { openSession } from '../src/session'
import { memoryPipePair } from '../src/transport'
import { createRpcPeer, EVENTS, METHODS, MIMIR_QUESTION_V, PairError, type MimirEnded, type MimirQuestion, type MimirState } from '../src/rpc'
import { flush, pairByLink, world, type Phone, type World } from './helpers'

const Q: MimirQuestion = { v: 1, sessionId: 's_1', askId: 'ask_1', title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }], at: 1 }

/** The desktop app's side as the host sees it: one question at a time, the first answer wins. */
function testQuestions(live = true) {
  let state: MimirState = { live, waiting: null }
  const cbs = new Set<(s: MimirState & { ended?: MimirEnded }) => void>()
  const answers: { askId: string; choiceId: string | null; by: string }[] = []
  const emit = (ended?: MimirEnded) => {
    for (const cb of [...cbs]) cb({ ...state, ...(ended ? { ended } : {}) })
  }
  const feed: QuestionFeed & { ask(q: MimirQuestion): void; answerInApp(choiceId: string | null): void; setLive(on: boolean): void; answers: typeof answers } = {
    answers,
    state: () => state,
    onChange(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    async answer(a, by) {
      const w = state.waiting
      if (!state.live) throw Object.assign(new Error('closed'), { code: 'unavailable' })
      if (!w || w.askId !== a.askId || w.sessionId !== a.sessionId) throw Object.assign(new Error('gone'), { code: 'not_found' })
      if (a.choiceId !== null && !w.choices.some((c) => c.id === a.choiceId)) throw Object.assign(new Error('no such choice'), { code: 'bad_request' })
      answers.push({ askId: a.askId, choiceId: a.choiceId, by: by.name })
      state = { ...state, waiting: null }
      emit({ askId: a.askId, choiceId: a.choiceId, by: 'phone', name: by.name })
    },
    ask(q) {
      state = { ...state, waiting: q }
      emit()
    },
    answerInApp(choiceId) {
      const w = state.waiting
      if (!w) return
      state = { ...state, waiting: null }
      emit({ askId: w.askId, choiceId, by: 'app' })
    },
    setLive(on) {
      state = { live: on, waiting: on ? state.waiting : null }
      emit()
    },
  }
  return feed
}

async function connected(w: World, phone: Phone): Promise<HostConnection> {
  await pairByLink(w, phone)
  const hosts = await phone.client.hosts()
  return phone.client.connect(hosts.at(-1)?.pairingId ?? '')
}

function events(conn: HostConnection) {
  const seen: (MimirState & { ended?: MimirEnded })[] = []
  conn.on('mimir.question', (s) => seen.push(s))
  return seen
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof PairError ? e.code : String(e)))

describe('the protocol', () => {
  it('reads a question, an answer and the change event, and refuses anything past its limits', () => {
    expect(METHODS['mimir.questions'].result.parse({ live: true, waiting: Q })).toEqual({ live: true, waiting: Q })
    expect(METHODS['mimir.answer'].params.parse({ v: 1, sessionId: 's_1', askId: 'ask_1', choiceId: null })).toEqual({ v: 1, sessionId: 's_1', askId: 'ask_1', choiceId: null })
    expect(EVENTS['mimir.question'].parse({ live: true, waiting: null, ended: { askId: 'ask_1', choiceId: 'same', by: 'phone', name: 'Pocket' } }).ended?.by).toBe('phone')
    expect(METHODS['mimir.answer'].params.safeParse({ v: 1, sessionId: 's_1', askId: 'ask_1', choiceId: '' }).success).toBe(false)
    expect(METHODS['mimir.answer'].params.safeParse({ sessionId: 's_1', askId: 'ask_1', choiceId: 'same' }).success).toBe(false)
    expect(METHODS['mimir.questions'].result.safeParse({ live: true, waiting: { ...Q, choices: [] } }).success).toBe(false)
    expect(METHODS['mimir.questions'].result.safeParse({ live: true, waiting: { ...Q, title: 'x'.repeat(201) } }).success).toBe(false)
    expect(METHODS['mimir.questions'].result.safeParse({ live: true, waiting: { ...Q, choices: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, label: 'x' })) } }).success).toBe(false)
    expect(MIMIR_QUESTION_V).toBe(1)
  })

  it('keeps a question of a later version readable, so the phone can show it without buttons', () => {
    expect(METHODS['mimir.questions'].result.parse({ live: true, waiting: { ...Q, v: 2 } }).waiting?.v).toBe(2)
  })
})

describe('mimir questions on a paired phone', () => {
  it('an approver phone reads the waiting question, picks an answer, and hears it end; the host keeps an audit line', async () => {
    const feed = testQuestions()
    const w = await world({ services: { questionFeed: feed } })
    const conn = await connected(w, w.phone('Pocket'))
    expect(conn.info.mimir).toBe(true)
    const seen = events(conn)
    expect(await conn.mimirQuestions()).toEqual({ live: true, waiting: null })
    feed.ask(Q)
    await flush()
    expect(seen.at(-1)).toEqual({ live: true, waiting: Q })
    expect(await conn.mimirQuestions()).toEqual({ live: true, waiting: Q })

    await conn.mimirAnswer(Q, 'other')
    await flush()
    expect(feed.answers).toEqual([{ askId: 'ask_1', choiceId: 'other', by: 'Pocket' }])
    expect(seen.at(-1)).toEqual({ live: true, waiting: null, ended: { askId: 'ask_1', choiceId: 'other', by: 'phone', name: 'Pocket' } })
    const audit: MimirAnswerAudit[] = w.host.answerAudit()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ askId: 'ask_1', sessionId: 's_1', choiceId: 'other', deviceName: 'Pocket', at: w.env.now() })
    expect(audit[0]?.deviceId).toBeTruthy()
  })

  it('Cancel is an answer with no choice', async () => {
    const feed = testQuestions()
    const w = await world({ services: { questionFeed: feed } })
    const conn = await connected(w, w.phone('Pocket'))
    feed.ask(Q)
    await conn.mimirAnswer(Q, null)
    expect(feed.answers).toEqual([{ askId: 'ask_1', choiceId: null, by: 'Pocket' }])
    expect(w.host.answerAudit()[0]?.choiceId).toBeNull()
  })

  it('the first answer wins: the desktop first, or another phone first, and a stale card is refused', async () => {
    const feed = testQuestions()
    const w = await world({ services: { questionFeed: feed } })
    const a = await connected(w, w.phone('Pocket'))
    const b = await connected(w, w.phone('Tablet'))
    const seenB = events(b)

    // the desktop answers first: the phone's late answer is not_found and its event names the app
    feed.ask(Q)
    feed.answerInApp('same')
    await flush()
    expect(seenB.at(-1)?.ended).toEqual({ askId: 'ask_1', choiceId: 'same', by: 'app' })
    expect(await code(a.mimirAnswer(Q, 'other'))).toBe('not_found')

    // two phones: the second gets not_found and the event names the first
    const q2 = { ...Q, askId: 'ask_2' }
    feed.ask(q2)
    await a.mimirAnswer(q2, 'same')
    expect(await code(b.mimirAnswer(q2, 'other'))).toBe('not_found')
    await flush()
    expect(seenB.at(-1)?.ended).toMatchObject({ askId: 'ask_2', by: 'phone', name: 'Pocket' })

    // a stale card: a new question waits, the old id never answers it
    const q3 = { ...Q, askId: 'ask_3' }
    feed.ask(q3)
    expect(await code(b.mimirAnswer(q2, 'same'))).toBe('not_found')
    expect(await code(b.mimirAnswer({ ...q3, sessionId: 's_other' }, 'same'))).toBe('not_found')
    expect(await code(b.mimirAnswer(q3, 'nope'))).toBe('bad_request')
    expect(feed.answers.map((x) => x.askId)).toEqual(['ask_2'])
    expect(w.host.answerAudit().map((x) => x.askId)).toEqual(['ask_2'])
  })

  it('says when the app cannot take an answer, and passes the live flag through', async () => {
    const feed = testQuestions()
    const w = await world({ services: { questionFeed: feed } })
    const conn = await connected(w, w.phone('Pocket'))
    const seen = events(conn)
    feed.ask(Q)
    feed.setLive(false)
    await flush()
    expect(seen.at(-1)).toEqual({ live: false, waiting: null })
    expect(await code(conn.mimirAnswer(Q, 'same'))).toBe('unavailable')
    expect(w.host.answerAudit()).toEqual([])
  })

  it('a phone without the approve right reads and answers nothing, and gets no events', async () => {
    const feed = testQuestions()
    const w = await world({ services: { questionFeed: feed } })
    const phone = w.phone('Kid')
    await pairByLink(w, phone)
    const [device] = await w.host.devices()
    await w.host.setRights(device?.pairingId ?? '', { request: true, approve: false, introduce: false })
    const conn = await phone.client.connect((await phone.client.hosts())[0]?.pairingId ?? '')
    const seen = events(conn)
    feed.ask(Q)
    await flush()
    expect(seen).toEqual([])
    expect(await code(conn.mimirQuestions())).toBe('forbidden')
    expect(await code(conn.mimirAnswer(Q, 'same'))).toBe('forbidden')
    expect(feed.answers).toEqual([])
  })

  it('a computer without question cards says not_supported, so the phone keeps the card read-only', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    expect(conn.info.mimir).toBe(false)
    expect(await code(conn.mimirQuestions())).toBe('not_supported')
    expect(await code(conn.mimirAnswer(Q, 'same'))).toBe('not_supported')
  })

  it('refuses an answer of another version before the app sees it', async () => {
    const feed = testQuestions()
    const w = await world({ services: { questionFeed: feed } })
    const phone = w.phone('Pocket')
    await connected(w, phone)
    feed.ask(Q)
    // the typed client always sends its own version; a raw session stands in for a phone from a later release
    const [rec] = await phone.store.list()
    const key = fromB64url(rec?.deviceKey ?? '')
    const hostDhPub = fromB64url(rec?.peer.dhPub ?? '')
    if (!key || !hostDhPub) throw new Error('no pairing')
    const [x, y] = memoryPipePair()
    w.host.handlePipe(y)
    const rpc = createRpcPeer(await openSession(x, { env: w.env, deviceKey: key, hostDhPub }))
    await rpc.call('host.info', {})
    expect(await code(rpc.call('mimir.answer', { v: 2, sessionId: 's_1', askId: 'ask_1', choiceId: 'same' }))).toBe('bad_request')
    expect(feed.answers).toEqual([])
    expect(w.host.answerAudit()).toEqual([])
  })
})
