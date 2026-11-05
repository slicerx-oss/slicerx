// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A paired phone answering the question mimir waits on, the way the pairing host (LAN) and the hub (relay) reach the
// app: the question shows to phones, a pick or a Cancel goes into pilot.answer as a click would, the first answer wins
// (a desktop click first, another phone first, a stale card), and the session reads back which phone answered.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, type ScriptStep } from '@slicerx/pilot'
import { emptyTranscript, foldEvents, startTurn, type Transcript } from '@slicerx/pilot/ui'
import { afterEach, describe, expect, it } from 'vitest'
import { hostAppLink } from '../src/app-link/host'
import { runCall } from '../src/app-link/methods'
import { setSessionSource } from '../src/app-link/sessions'
import type { BridgeAppLink } from '../src/link/bridge'
import { openChoice } from '../src/workspaces/mimir/card-waits'
import { onPhoneQuestion, phoneQuestion, phoneQuestionFeed, resetPhoneQuestions, setPhoneCards, syncPhoneQuestion, type PhoneState } from '../src/workspaces/mimir/phone-answers'
import { mimirLogs, mimirMessages, noteMessage } from '../src/workspaces/mimir/session'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const ASK = { name: 'pilot.ask', args: { title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] } }

/** The mimir tab as it registers itself for phones: its transcript folded as the pane folds it, synced on every event. */
function chat(sessionId: string) {
  const seen: { ok: boolean; result: unknown }[] = []
  const reader: ScriptStep = (messages) => {
    const last = messages.at(-1)
    if (last?.role === 'tool') seen.push(JSON.parse(last.content) as { ok: boolean; result: unknown })
    return { text: 'Got it.' }
  }
  const pilot = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ calls: [ASK] }, reader, { calls: [ASK] }, reader], { chunk: false }), builtins: false, tools: [askTool()], store: mimirLogs })
  let transcript: Transcript = emptyTranscript()
  const runs: Promise<void>[] = []
  let asked: () => void = () => undefined
  let shown = new Promise<void>((r) => (asked = r))
  const send = (text: string) => {
    noteMessage(sessionId, text, [])
    transcript = startTurn(transcript, { user: text }, 0)
    shown = new Promise<void>((r) => (asked = r))
    runs.push(
      (async () => {
        for await (const e of pilot.run(sessionId, text)) {
          transcript = foldEvents([e as PilotEvent], transcript)
          syncPhoneQuestion()
          if (e.type === 'ask') asked()
        }
      })(),
    )
    return shown
  }
  setSessionSource({ store: mimirLogs, messages: (id) => mimirMessages.get(id) ?? [] })
  setPhoneCards({
    sessionId: () => sessionId,
    open: () => openChoice(transcript),
    picked: (askId) => {
      for (const t of transcript.turns) for (const b of t.blocks) if (b.kind === 'choice' && b.askId === askId) return b.picked
      return undefined
    },
    answer: (askId, choiceId) => pilot.answer!(askId, choiceId),
  })
  return { pilot, send, runs, seen, transcript: () => transcript }
}

const by = (name: string) => ({ deviceId: `dev-${name}`, name })
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? String(e))

afterEach(() => {
  resetPhoneQuestions()
  setSessionSource(null)
})

describe('phones answering mimir questions, through the pairing host feed', () => {
  it('shows the question to phones, and a pick reaches the tool through pilot.answer', async () => {
    const changes: PhoneState[] = []
    onPhoneQuestion((s) => changes.push(s))
    const c = chat('s_pick')
    await c.send('a wall mount')
    const st = phoneQuestionFeed.state()
    expect(st.live).toBe(true)
    expect(st.waiting).toMatchObject({ v: 1, sessionId: 's_pick', title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] })
    const askId = st.waiting!.askId

    await phoneQuestionFeed.answer({ sessionId: 's_pick', askId, choiceId: 'other' }, by('Pocket'))
    await Promise.all(c.runs)
    expect(c.seen[0]).toMatchObject({ ok: true, result: { picked: 'other' } })
    expect(phoneQuestion().waiting).toBeNull()
    expect(changes.at(-1)).toEqual({ live: true, waiting: null, ended: { askId, choiceId: 'other', by: 'phone', name: 'Pocket' } })

    // the session reads back that a phone answered it
    const s = (await runCall('mimir.session', { id: 's_pick' })) as { turns: { steps: Record<string, unknown>[] }[] }
    const step = s.turns.at(-1)!.steps.find((x) => x['kind'] === 'choice')
    expect(step).toMatchObject({ askId, picked: 'other', answeredOn: { kind: 'phone', name: 'Pocket' } })
  })

  it('Cancel answers with no pick: the run carries on and mimir reads it as turned down', async () => {
    const c = chat('s_cancel')
    await c.send('a wall mount')
    const askId = phoneQuestion().waiting!.askId
    await phoneQuestionFeed.answer({ sessionId: 's_cancel', askId, choiceId: null }, by('Pocket'))
    await Promise.all(c.runs)
    expect(c.seen[0]).toMatchObject({ ok: true, result: { picked: null, dismissed: true } })
    expect(c.transcript().status).not.toBe('running')
  })

  it('the first answer wins: a desktop click, then a second phone, then a stale card', async () => {
    const changes: PhoneState[] = []
    onPhoneQuestion((s) => changes.push(s))
    const c = chat('s_race')
    await c.send('a wall mount')
    const first = phoneQuestion().waiting!.askId
    // the person clicks on the computer first
    await c.pilot.answer!(first, 'same')
    await Promise.all(c.runs)
    expect(changes.at(-1)?.ended).toEqual({ askId: first, choiceId: 'same', by: 'app' })
    expect(await code(phoneQuestionFeed.answer({ sessionId: 's_race', askId: first, choiceId: 'other' }, by('Pocket')))).toBe('not_found')
    expect(c.seen[0]).toMatchObject({ result: { picked: 'same' } })

    // two phones at once on the next question: one wins, the other is not_found
    await c.send('another one')
    const second = phoneQuestion().waiting!.askId
    expect(second).not.toBe(first)
    const results = await Promise.all([code(phoneQuestionFeed.answer({ sessionId: 's_race', askId: second, choiceId: 'same' }, by('Pocket'))), code(phoneQuestionFeed.answer({ sessionId: 's_race', askId: second, choiceId: 'other' }, by('Tablet')))])
    expect(results.sort()).toEqual(['not_found', 'ok'])
    await Promise.all(c.runs)
    expect(changes.at(-1)?.ended).toMatchObject({ askId: second, by: 'phone', name: 'Pocket', choiceId: 'same' })
    expect(c.seen[1]).toMatchObject({ result: { picked: 'same' } })

    // a stale card from the first question never answers anything
    expect(await code(phoneQuestionFeed.answer({ sessionId: 's_race', askId: first, choiceId: 'same' }, by('Tablet')))).toBe('not_found')
  })

  it('refuses a choice the question does not offer, another session, and answers while the tab is closed', async () => {
    const c = chat('s_bad')
    await c.send('a wall mount')
    const askId = phoneQuestion().waiting!.askId
    expect(await code(phoneQuestionFeed.answer({ sessionId: 's_bad', askId, choiceId: 'nope' }, by('Pocket')))).toBe('bad_request')
    expect(await code(phoneQuestionFeed.answer({ sessionId: 's_other', askId, choiceId: 'same' }, by('Pocket')))).toBe('not_found')
    expect(phoneQuestion().waiting?.askId).toBe(askId)
    const changes: PhoneState[] = []
    onPhoneQuestion((s) => changes.push(s))
    setPhoneCards(null)
    await Promise.resolve()
    expect(phoneQuestion()).toEqual({ live: false, waiting: null })
    expect(changes.at(-1)).toEqual({ live: false, waiting: null })
    expect(await code(phoneQuestionFeed.answer({ sessionId: 's_bad', askId, choiceId: 'same' }, by('Pocket')))).toBe('unavailable')
    await c.pilot.answer!(askId, null)
    await Promise.all(c.runs)
  })
})

describe('phones answering over the relay, through the hub and this window', () => {
  function fakeLink() {
    const states: unknown[] = []
    const replies: { callId: number; out: unknown }[] = []
    let phoneCb: Parameters<NonNullable<BridgeAppLink['onPhoneAnswer']>>[0] = () => undefined
    const link: BridgeAppLink = {
      isOn: async () => false,
      setOn: async () => false,
      host: async () => ({ on: false, origin: 'tauri://localhost' }),
      onCall: () => () => undefined,
      onAsk: () => () => undefined,
      onAskEnded: () => () => undefined,
      reply: async (callId, out) => void replies.push({ callId, out }),
      answer: async () => undefined,
      grants: async () => [],
      revoke: async () => undefined,
      onPhoneAnswer: (cb) => {
        phoneCb = cb
        return () => undefined
      },
      mimirState: async (st) => void states.push(st),
    }
    return { link, states, replies, phone: (a: Parameters<typeof phoneCb>[0]) => phoneCb(a) }
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('tells the hub what mimir waits on and answers a phone with the reply the hub maps', async () => {
    const f = fakeLink()
    const stop = hostAppLink(f.link)
    const c = chat('s_relay')
    await c.send('a wall mount')
    await settle()
    const told = f.states.at(-1) as { waiting: { askId: string } | null }
    expect(told.waiting?.askId).toBeTruthy()
    const askId = told.waiting!.askId

    f.phone({ callId: 7, answer: { sessionId: 's_relay', askId, choiceId: 'nope' }, phone: { deviceId: 'd', name: 'Pocket' } })
    await settle()
    expect(f.replies.at(-1)).toMatchObject({ callId: 7, out: { ok: false, code: 'invalid_input' } })

    f.phone({ callId: 8, answer: { sessionId: 's_relay', askId, choiceId: null }, phone: { deviceId: 'd', name: 'Pocket' } })
    await settle()
    expect(f.replies.at(-1)).toEqual({ callId: 8, out: { ok: true, value: { answered: true } } })
    await Promise.all(c.runs)
    expect(c.seen[0]).toMatchObject({ result: { picked: null, dismissed: true } })
    expect(f.states.at(-1)).toEqual({ live: true, waiting: null, ended: { askId, choiceId: null, by: 'phone', name: 'Pocket' } })

    f.phone({ callId: 9, answer: { sessionId: 's_relay', askId, choiceId: 'same' }, phone: { deviceId: 'd', name: 'Tablet' } })
    await settle()
    expect(f.replies.at(-1)).toMatchObject({ callId: 9, out: { ok: false, code: 'not_found' } })
    stop()
  })
})
