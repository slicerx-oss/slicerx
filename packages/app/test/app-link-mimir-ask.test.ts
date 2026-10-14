// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client's message to mimir over the app link, with a picture and a PDF: mimir.ask hands it to the chat, the chat's
// run sends both files to the model in the provider request, and mimir.session reads the turn back with the files'
// names. Files outside the chat's limits are refused before anything runs, and a run already going is never cut off.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PilotAttachment, type PrinterHost } from '@slicerx/contracts'
import { createPilot, DEFAULT_CONFIG } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkError, runCall } from '../src/app-link/methods'
import { setMimirAsker } from '../src/app-link/mimir-ask'
import { setSessionSource } from '../src/app-link/sessions'
import { dockLogs, dockMessages, noteDockMessage } from '../src/features/pilot/dock-log'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PDF = Buffer.from('%PDF-1.4\n%%EOF').toString('base64')

function chat() {
  const sent: LlmHttpRequest[] = []
  const llm: LlmTransport = {
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
      yield new TextEncoder().encode(
        ev('message_start', { message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }) +
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'I can see the drawing.' } }) +
          ev('content_block_stop', { index: 0 }) +
          ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) +
          ev('message_stop', {}),
      )
    },
  }
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const pilot = createPilot({ host, config: { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5' }, policy: DEFAULT_POLICY, builtins: false, tools: [], store: dockLogs })
  const runs: Promise<void>[] = []
  let busy = false
  // what the docked chat registers: each message noted for the read-back, then run
  setSessionSource({ store: dockLogs, messages: dockMessages })
  setMimirAsker({
    busy: () => busy,
    send: (text: string, files: PilotAttachment[]) => {
      noteDockMessage('s_link', text, files)
      runs.push(
        (async () => {
          for await (const _ of pilot.run('s_link', text, files.length ? { attachments: files } : {})) void _
        })(),
      )
      return 's_link'
    },
  })
  return { sent, runs, setBusy: (b: boolean) => (busy = b) }
}

afterEach(() => {
  setMimirAsker(null)
  setSessionSource(null)
})

const files = [
  { name: 'sketch.png', type: 'image/png', data: PNG },
  { name: 'bracket.pdf', type: 'application/pdf', data: PDF },
]

describe('mimir.ask over the app link', () => {
  it('sends a picture and a PDF to the model, and the turn reads back with them', async () => {
    const c = chat()
    const out = (await runCall('mimir.ask', { message: 'Make a bracket for this', files })) as { sessionId: string; attachments: { name: string; type: string }[] }
    expect(out.sessionId).toBe('s_link')
    expect(out.attachments.map((f) => [f.name, f.type])).toEqual([['sketch.png', 'image/png'], ['bracket.pdf', 'application/pdf']])
    await Promise.all(c.runs)
    const body = JSON.parse(c.sent[0]!.body) as { messages: { role: string; content: Record<string, unknown>[] }[] }
    const content = body.messages.at(-1)!.content
    expect(content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } })
    expect(content).toContainEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'bracket.pdf' })
    const back = (await runCall('mimir.session', { id: 's_link' })) as { turns: { said?: string; attachments?: string[]; steps: { kind: string; text?: string }[] }[] }
    expect(back.turns.at(-1)).toMatchObject({ said: 'Make a bracket for this', attachments: ['sketch.png', 'bracket.pdf'] })
    expect(back.turns.at(-1)!.steps).toContainEqual({ kind: 'said', text: 'I can see the drawing.' })
  })

  it('refuses what the chat would refuse, before anything runs', async () => {
    const c = chat()
    const code = async (args: Record<string, unknown>) => ((await runCall('mimir.ask', args).catch((e: unknown) => e)) as LinkError).code
    expect(await code({ message: 'hi', files: [{ name: 'part.stl', type: 'model/stl', data: 'c29saWQ=' }] })).toBe('invalid_input')
    expect(await code({ message: 'hi', files: [...files, ...files, files[0]] })).toBe('invalid_input')
    expect(await code({ message: 'hi', files: [{ name: 'big.pdf', type: 'application/pdf', data: 'A'.repeat(14_200_000) }] })).toBe('invalid_input')
    expect(await code({ message: '' })).toBe('invalid_input')
    c.setBusy(true)
    expect(await code({ message: 'hi' })).toBe('busy')
    expect(c.sent).toHaveLength(0)
  })

  it('says so when the chat is not open', async () => {
    expect(((await runCall('mimir.ask', { message: 'hi' }).catch((e: unknown) => e)) as LinkError).code).toBe('not_ready')
  })
})
