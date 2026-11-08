// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client turning down the question mimir waits on, over the app link, the way a client drives it: mimir.session shows
// the question as waiting, mimir.ask is refused while it waits, mimir.dismiss turns it down (with words mimir reads in
// its place), the run carries on to its end, and the session reads the question back as dismissed. A stale question id
// is refused so a late call cannot turn down the next one, and the words are held to their limit.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { askTool, createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '@slicerx/pilot'
import { emptyTranscript, foldEvents, startTurn, type Transcript } from '@slicerx/pilot/ui'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { setMimirAsker } from '../src/app-link/mimir-ask'
import { setMimirCards } from '../src/app-link/mimir-dismiss'
import { setSessionSource } from '../src/app-link/sessions'
import { openChoice, openSheetCard } from '../src/workspaces/mimir/card-waits'
import { mimirLogs, mimirMessages, noteMessage } from '../src/workspaces/mimir/session'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const ASK = { name: 'pilot.ask', args: { title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] } }

/** The tab's chat as it registers itself: each message noted and run, its transcript folded as the panes fold it. */
function chat(sessionId: string, steps: ScriptStep[]) {
  const seen: { ok: boolean; result: unknown }[] = []
  const reader: ScriptStep = (messages) => {
    const last = messages.at(-1)
    if (last?.role === 'tool') seen.push(JSON.parse(last.content) as { ok: boolean; result: unknown })
    return { text: 'Okay, I will leave it for now.' }
  }
  const pilot = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([...steps, reader, { text: 'Second reply.' }], { chunk: false }), builtins: false, tools: [askTool()], store: mimirLogs })
  let transcript: Transcript = emptyTranscript()
  let running = false
  let asked: () => void = () => undefined
  const shown = new Promise<void>((r) => (asked = r))
  const runs: Promise<void>[] = []
  const send = (text: string, files: PilotAttachment[]): string => {
    noteMessage(sessionId, text, files)
    running = true
    transcript = startTurn(transcript, { user: text }, 0)
    runs.push(
      (async () => {
        for await (const e of pilot.run(sessionId, text)) {
          transcript = foldEvents([e as PilotEvent], transcript)
          if (e.type === 'ask') asked()
        }
        running = false
      })(),
    )
    return sessionId
  }
  setSessionSource({ store: mimirLogs, messages: (id) => mimirMessages.get(id) ?? [] })
  setMimirAsker({ busy: () => running, send })
  setMimirCards({ sessionId: () => sessionId, open: () => openChoice(transcript), dismiss: (askId, said) => pilot.answer!(askId, null, said) })
  return { send, shown, runs, seen, transcript: () => transcript }
}

const code = async (method: string, args: Record<string, unknown>) => ((await runCall(method, args).catch((e: unknown) => e)) as LinkError).code

afterEach(() => {
  setMimirAsker(null)
  setMimirCards(null)
  setSessionSource(null)
})

type Session = { waiting: { askId: string; title: string; question: string; choices: { id: string; label: string }[] } | null; stats: { questions: number; questionsDismissed: number }; turns: { steps: Record<string, unknown>[] }[] }

describe('mimir.dismiss over the app link', () => {
  it('is an edit, like a message to mimir', () => {
    expect(APP_LINK_METHODS['mimir.dismiss']).toBe('edit')
  })

  it('a waiting question shows in the read-back, blocks a message, and once turned down the run carries on to its end', async () => {
    const c = chat('s_dismiss', [{ calls: [ASK] }])
    await runCall('mimir.ask', { message: 'a wall mount for my thermostat' })
    await c.shown
    const before = (await runCall('mimir.session', { id: 's_dismiss' })) as Session
    expect(before.waiting).toMatchObject({ title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] })
    const askId = before.waiting!.askId
    expect(await code('mimir.ask', { message: 'are you there?' })).toBe('busy')

    const out = await runCall('mimir.dismiss', { askId, said: '  it is a different model  ' })
    expect(out).toEqual({ sessionId: 's_dismiss', askId, dismissed: true, said: 'it is a different model' })
    await Promise.all(c.runs)
    expect(c.seen[0]).toMatchObject({ ok: true, result: { picked: null, dismissed: true, said: 'it is a different model' } })

    const after = (await runCall('mimir.session', { id: 's_dismiss' })) as Session
    expect(after.waiting).toBeNull()
    expect(after.stats).toMatchObject({ questions: 1, questionsDismissed: 1 })
    const step = after.turns.at(-1)!.steps.find((s) => s['kind'] === 'choice')
    expect(step).toMatchObject({ askId, picked: '', dismissed: true, said: 'it is a different model' })
    expect(after.turns.at(-1)!.steps).toContainEqual({ kind: 'said', text: 'Okay, I will leave it for now.' })

    // the run ended the ordinary way, so the next message is taken
    expect(await runCall('mimir.ask', { message: 'thanks' })).toMatchObject({ sessionId: 's_dismiss' })
    await Promise.all(c.runs)
  })

  it('without an askId turns down the one waiting now; a stale or unknown id is refused and the question stays open', async () => {
    const c = chat('s_stale', [{ calls: [ASK] }])
    c.send('a wall mount', [])
    await c.shown
    expect(await code('mimir.dismiss', { askId: 'ask_gone' })).toBe('not_found')
    expect(openChoice(c.transcript())).not.toBeNull()
    const out = (await runCall('mimir.dismiss', {})) as { askId: string; dismissed: boolean }
    expect(out.dismissed).toBe(true)
    await Promise.all(c.runs)
    expect(c.seen[0]).toMatchObject({ ok: true, result: { picked: null, dismissed: true } })
    // the same id again: nothing waits now
    expect(await code('mimir.dismiss', { askId: out.askId })).toBe('not_found')
    expect(await code('mimir.dismiss', {})).toBe('not_found')
  })

  it('refuses words past the limit and arguments of the wrong kind before anything is answered', async () => {
    const c = chat('s_limit', [{ calls: [ASK] }])
    c.send('a wall mount', [])
    await c.shown
    expect(await code('mimir.dismiss', { said: 'x'.repeat(1001) })).toBe('invalid_input')
    expect(await code('mimir.dismiss', { said: 7 })).toBe('invalid_input')
    expect(await code('mimir.dismiss', { askId: 42 })).toBe('invalid_input')
    expect(openChoice(c.transcript())).not.toBeNull()
    await runCall('mimir.dismiss', { said: 'x'.repeat(1000) })
    await Promise.all(c.runs)
    expect((c.seen[0]!.result as { said: string }).said).toHaveLength(1000)
  })

  it('says so when the mimir tab has not been opened', async () => {
    expect(await code('mimir.dismiss', {})).toBe('not_ready')
  })
})

// A size sheet waiting is set aside the way Return in the message box sets it aside: mimir reads the words in its place
// and builds nothing from it. The read-back shows the sheet as waiting, then counts it as set aside.
describe('mimir.dismiss on a waiting size sheet', () => {
  const SHEET = { name: 'pilot.sheet', args: { title: 'Clip sizes', dims: [{ key: 'bore', label: 'Cable bore', value: 6.2, unit: 'mm', source: 'asked' }] } }

  function sheetChat(sessionId: string) {
    const seen: { ok: boolean; summary?: string; result: unknown }[] = []
    const reader: ScriptStep = (messages) => {
      const last = messages.at(-1)
      if (last?.role === 'tool') seen.push(JSON.parse(last.content) as { ok: boolean; result: unknown })
      return { text: 'Adding the hole.' }
    }
    const pilot = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ calls: [SHEET] }, reader], { chunk: false }), builtins: false, tools: [sheetTool()], store: mimirLogs })
    let transcript: Transcript = startTurn(emptyTranscript(), { user: 'a cable clip' }, 0)
    let shownSheet: () => void = () => undefined
    const shown = new Promise<void>((r) => (shownSheet = r))
    noteMessage(sessionId, 'a cable clip', [])
    const run = (async () => {
      for await (const e of pilot.run(sessionId, 'a cable clip')) {
        transcript = foldEvents([e as PilotEvent], transcript)
        if (e.type === 'sheet') shownSheet()
      }
    })()
    setSessionSource({ store: mimirLogs, messages: (id) => mimirMessages.get(id) ?? [] })
    setMimirCards({ sessionId: () => sessionId, open: () => openChoice(transcript), dismiss: (askId, said) => pilot.answer!(askId, null, said), sheet: () => openSheetCard(transcript), setAside: (sheetId, said) => pilot.answerSheet!(sheetId, null, said) })
    return { shown, run, seen }
  }

  it('shows the sheet as waiting, sets it aside with the words, and counts it as set aside', async () => {
    const c = sheetChat('s_sheet')
    await c.shown
    const before = (await runCall('mimir.session', { id: 's_sheet' })) as { waiting: { sheetId: string; title: string; sizes: unknown[] } | null }
    expect(before.waiting).toMatchObject({ title: 'Clip sizes', sizes: [{ key: 'bore', label: 'Cable bore', value: 6.2, unit: 'mm' }] })
    const sheetId = before.waiting!.sheetId
    expect(await code('mimir.dismiss', { sheetId: 'sheet_gone', said: 'x' })).toBe('not_found')
    const out = await runCall('mimir.dismiss', { sheetId, said: '  also add a cable hole  ' })
    expect(out).toEqual({ sessionId: 's_sheet', sheetId, setAside: true, said: 'also add a cable hole' })
    await c.run
    expect(c.seen[0]).toMatchObject({ ok: false, result: { confirmed: false, said: 'also add a cable hole' } })
    const after = (await runCall('mimir.session', { id: 's_sheet' })) as { waiting: unknown; stats: { sheetsSetAside: number; sheetsConfirmed: number } }
    expect(after.waiting).toBeNull()
    expect(after.stats).toMatchObject({ sheetsSetAside: 1, sheetsConfirmed: 0 })
    expect(await code('mimir.dismiss', {})).toBe('not_found')
  })
})
