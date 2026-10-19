// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud on the desktop: the shell sends the model the proxy used as its own chunk before the reply, and the chat
// names that model, not the one the turn asked for.
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLICY, type ApprovalHost, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { DEFAULT_CONFIG, createPilot } from '@slicerx/pilot'

type Chunk = { kind: 'model'; model: string } | { kind: 'data'; b64: string } | { kind: 'end' }

/** What the shell answers to each llm_stream call, and the headers each call carried. */
const shell = vi.hoisted(() => ({ replies: [] as { model?: string; sse: string }[], sent: [] as Record<string, string>[] }))

vi.mock('@tauri-apps/api/core', () => {
  class Channel<T> {
    onmessage: (c: T) => void = () => undefined
  }
  return {
    Channel,
    invoke: async (cmd: string, args?: { request?: { headers: Record<string, string> }; onChunk?: Channel<Chunk> }) => {
      if (cmd !== 'llm_stream' || !args?.onChunk || !args.request) return undefined
      shell.sent.push(args.request.headers)
      const reply = shell.replies.shift() ?? { sse: '' }
      const ch = args.onChunk
      setTimeout(() => {
        if (reply.model) ch.onmessage({ kind: 'model', model: reply.model })
        ch.onmessage({ kind: 'data', b64: btoa(reply.sse) })
        ch.onmessage({ kind: 'end' })
      }, 0)
      return undefined
    },
  }
})

const sse = (events: unknown[]): string => events.map((d) => `event: ${(d as { type: string }).type}\ndata: ${JSON.stringify(d)}\n\n`).join('')
const text = (t: string): string =>
  sse([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])
const lookUp = sse([
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_0', name: 'no_such_tool', input: {} } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
])

const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
const NO_APPROVALS = { register: async () => undefined, grant: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost

describe('the desktop transport and mimir cloud', () => {
  it('a Haiku x-sx-model after a step hint switches the label to Haiku', async () => {
    const { createTauriLlm } = await import('../src/host/llm')
    shell.replies = [
      { model: 'claude-sonnet-5-5', sse: lookUp },
      { model: 'claude-haiku-5-5', sse: text('The bed was too cold.') },
    ]
    const pilot = createPilot({
      host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: createTauriLlm() },
      config: { ...DEFAULT_CONFIG, provider: 'mimir-cloud', model: 'claude-haiku-5-5', baseUrl: 'https://abcdefghijklmnop.supabase.co/functions/v1/mimir', billing: 'key', webSearch: false },
      policy: DEFAULT_POLICY,
      builtins: false,
      tools: [],
    })
    const ev: PilotEvent[] = []
    for await (const e of pilot.run('ses_1', 'Why did my print fail?')) ev.push(e)
    expect(shell.sent.map((h) => h['x-sx-tier'])).toEqual(['step', 'step'])
    const switches = ev.flatMap((e) => (e.type === 'model_switch' ? [{ model: e.model, label: e.label }] : []))
    expect(switches).toEqual([
      { model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { model: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    ])
    // the Haiku switch comes before that reply's text
    expect(ev.findIndex((e) => e.type === 'model_switch' && e.model === 'claude-haiku-5-5')).toBeLessThan(ev.findIndex((e) => e.type === 'text'))
  })

  it('passes only the model to the callback, before the first bytes', async () => {
    const { createTauriLlm } = await import('../src/host/llm')
    shell.replies = [{ model: 'claude-haiku-5-5', sse: 'data: {}\n\n' }]
    const seen: Record<string, string>[] = []
    let before = -1
    for await (const _ of createTauriLlm().stream({ provider: 'mimir-cloud', url: 'https://x/functions/v1/mimir/v1/messages', method: 'POST', headers: {}, body: '{}' }, undefined, (h) => seen.push(h))) {
      void _
      if (before < 0) before = seen.length
    }
    expect(seen).toEqual([{ 'x-sx-model': 'claude-haiku-5-5' }])
    expect(before).toBe(1)
  })
})
