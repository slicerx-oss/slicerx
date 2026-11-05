// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A phone paired on the LAN with the pairing host the app builds (pairHostServices): it sees mimir's approval card and
// its question card, decides the approval with its signed decision and answers the question, and each reaches the
// chat the way a click does.
import type { ApprovalDecision, ApprovalHost, ApprovalRequest, PrinterHost } from '@slicerx/contracts'
import { createIdentity, createPairClient, createPairHost, defaultEnv, memoryPairingStore, memoryPipePair, type HostPairingAttempt, type Pipe, type SocketFactory, type SocketLike } from '@slicerx/pair'
import { createMemoryRelay } from '@slicerx/pair/relay'
import { afterEach, expect, it } from 'vitest'
import { pairHostServices } from '../src/features/phone/wire'
import { resetPhoneQuestions, setPhoneCards } from '../src/workspaces/mimir/phone-answers'
import { resetPhoneApprovals, setPhoneApprovals, syncPhoneApprovals } from '../src/workspaces/mimir/phone-approvals'

const RELAY = 'wss://relay.example.test/v1'
const LAN = 'ws://192.168.1.20:47616/pair'

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A LAN socket factory that hands the other end of each connection to the host. */
function fakeLan(onConnection: (pipe: Pipe) => void): SocketFactory {
  return (url: string): SocketLike => {
    const listeners = new Map<string, Set<(ev: { data: unknown }) => void>>()
    const fire = (type: string, data?: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ data })
    }
    let state = 0
    let mine: Pipe | null = null
    setTimeout(() => {
      if (url !== LAN) {
        state = 3
        return fire('error')
      }
      const [a, b] = memoryPipePair()
      mine = a
      a.onFrame((f) => fire('message', f))
      a.onClose(() => {
        state = 3
        fire('close')
      })
      onConnection(b)
      state = 1
      fire('open')
    }, 0)
    return {
      get readyState() {
        return state
      },
      send: (d: string) => mine?.send(d),
      close: () => mine?.close(),
      addEventListener: ((type: string, cb: (ev: { data: unknown }) => void) => {
        let s = listeners.get(type)
        if (!s) listeners.set(type, (s = new Set()))
        s.add(cb)
      }) as SocketLike['addEventListener'],
    }
  }
}

const REQUEST: ApprovalRequest = {
  id: 'apr_1',
  sessionId: 's_lan',
  tool: 'printer.pause',
  permission: 'start',
  title: 'Pause the print on Bay 2?',
  lines: [],
  paramsHash: 'a'.repeat(64),
  actions: [],
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
}

afterEach(() => {
  resetPhoneApprovals()
  resetPhoneQuestions()
})

it('a phone paired on the LAN gets mimir approval and question cards, and its answers reach the chat', async () => {
  const env = defaultEnv
  const relay = createMemoryRelay()
  const services = pairHostServices({ printers: { list: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost })
  expect(services.approvalFeed).toBeDefined()
  expect(services.questionFeed).toBeDefined()
  const host = await createPairHost({ env, identity: createIdentity(env, 'Studio Mac', 'desktop'), store: memoryPairingStore(), kind: 'desktop', services, endpoints: { lan: [LAN], relay: RELAY } })
  host.attachRelay(relay.connect({}))
  const client = createPairClient({
    env,
    identity: createIdentity(env, 'Pocket', 'ios'),
    store: memoryPairingStore(),
    relays: [RELAY],
    defaultRelay: RELAY,
    socket: fakeLan((pipe) => host.handlePipe(pipe)),
    openRelay: async () => relay.connect({}),
    accountId: null,
    lanTimeoutMs: 50,
    sessionTimeoutMs: 500,
    pairAnswerTimeoutMs: 300,
  })

  // pair with both people confirming
  const offer = host.createOffer()
  const attempts: HostPairingAttempt[] = []
  offer.onAttempt((a) => attempts.push(a))
  const flow = await client.pair(offer.link)
  await flow.sas
  await flush()
  flow.confirm()
  attempts[0]!.confirm()
  const [paired] = await Promise.all([flow.result, attempts[0]!.result])
  expect(paired).toMatchObject({ ok: true })

  const conn = await client.connect((await client.hosts())[0]!.pairingId)
  expect(conn.via).toBe('lan')
  expect(conn.info.mimir).toBe(true)

  // mimir waits on an approval and a question in the chat
  const decided: { id: string; decision: ApprovalDecision }[] = []
  let pending: ApprovalRequest[] = []
  const shownRequests: string[] = []
  conn.on('approval.request', (v) => shownRequests.push(v.request.id))
  setPhoneApprovals({
    pending: () => pending,
    outcome: (id) => (decided.find((d) => d.id === id)?.decision.kind as 'approve' | 'deny' | undefined) ?? undefined,
    resolve: async (id, decision) => {
      decided.push({ id, decision })
      pending = pending.filter((r) => r.id !== id)
    },
  })
  pending = [REQUEST]
  syncPhoneApprovals()
  await flush()
  expect(shownRequests).toEqual(['apr_1'])
  const views = await conn.approvals()
  expect(views.map((v) => [v.request.id, v.source])).toEqual([['apr_1', 'pilot']])

  const answers: { askId: string; choiceId: string | null }[] = []
  let open: { askId: string; title: string; question: string; choices: { id: string; label: string }[] } | null = { askId: 'ask_1', title: 'Confirm the part', question: 'Is this the one?', choices: [{ id: 'same', label: 'Yes' }, { id: 'other', label: 'No' }] }
  setPhoneCards({
    sessionId: () => 's_lan',
    open: () => open,
    picked: () => undefined,
    answer: async (askId, choiceId) => {
      answers.push({ askId, choiceId })
      open = null
    },
  })
  const st = await conn.mimirQuestions()
  expect(st.live).toBe(true)
  expect(st.waiting).toMatchObject({ askId: 'ask_1', sessionId: 's_lan' })

  // the phone approves with its signed decision and answers the question
  await conn.approve(views[0]!)
  expect(decided).toEqual([{ id: 'apr_1', decision: { kind: 'approve' } }])
  expect(await conn.approvals()).toEqual([])
  expect(host.audit().map((a) => [a.requestId, a.decision])).toEqual([['apr_1', 'approve']])

  await conn.mimirAnswer(st.waiting!, 'other')
  expect(answers).toEqual([{ askId: 'ask_1', choiceId: 'other' }])
  expect(host.answerAudit().map((a) => [a.askId, a.choiceId, a.deviceName])).toEqual([['ask_1', 'other', 'Pocket']])

  conn.close()
  host.close()
})

it('a LAN approve that lands after the desktop decided is refused as not_found and leaves no audit line', async () => {
  const env = defaultEnv
  const relay = createMemoryRelay()
  const services = pairHostServices({ printers: { list: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost })
  const host = await createPairHost({ env, identity: createIdentity(env, 'Studio Mac', 'desktop'), store: memoryPairingStore(), kind: 'desktop', services, endpoints: { lan: [LAN], relay: RELAY } })
  host.attachRelay(relay.connect({}))
  const client = createPairClient({ env, identity: createIdentity(env, 'Pocket', 'ios'), store: memoryPairingStore(), relays: [RELAY], defaultRelay: RELAY, socket: fakeLan((pipe) => host.handlePipe(pipe)), openRelay: async () => relay.connect({}), accountId: null, lanTimeoutMs: 50, sessionTimeoutMs: 500, pairAnswerTimeoutMs: 300 })
  const offer = host.createOffer()
  const attempts: HostPairingAttempt[] = []
  offer.onAttempt((a) => attempts.push(a))
  const flow = await client.pair(offer.link)
  await flow.sas
  await flush()
  flow.confirm()
  attempts[0]!.confirm()
  await Promise.all([flow.result, attempts[0]!.result])
  const conn = await client.connect((await client.hosts())[0]!.pairingId)

  // the card still shows to phones for a moment after the person clicked Deny on the desktop
  let decidedOnDesktop = false
  setPhoneApprovals({
    pending: () => [REQUEST],
    outcome: () => undefined,
    resolve: async () => {
      if (decidedOnDesktop) throw new Error('No approval apr_1 waits')
    },
  })
  const [view] = await conn.approvals()
  decidedOnDesktop = true
  const code = await conn.approve(view!).then(
    () => 'ok',
    (e: unknown) => (e as { code?: string }).code,
  )
  expect(code).toBe('not_found')
  expect(host.audit()).toEqual([])
  conn.close()
  host.close()
})
