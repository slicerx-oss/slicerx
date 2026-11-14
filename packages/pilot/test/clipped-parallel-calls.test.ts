// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A reply cut off at the output limit in the middle of several tool calls: the calls whose arguments completed run,
// the one cut mid-way is answered as cut off, and every tool_use sent back has its tool_result in the next message,
// so the chat goes on.
import type { LlmHttpRequest, LlmTransport, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createTransportClient } from '../src/provider/client'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }
const BOX: EvalObject = { id: 'box', name: 'Box', bboxMm: [30, 20, 10] }

const sse = (events: [string, unknown][]): string => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')

const IDS = ['toolu_call_1', 'toolu_call_2', 'toolu_call_3', 'toolu_call_4']
const CUT_ID = IDS[3]

/** Signed thinking, three complete tool calls and a fourth whose arguments stop mid-way at max_tokens. */
function cutReply(withLastStop: boolean): string {
  const ev: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look up the guides, then cut the windows.' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ]
  const queries = ['window rows', 'port side windows', 'starboard side windows']
  queries.forEach((q, i) => {
    const index = i + 1
    ev.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: IDS[i], name: 'kb__search', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: `{"query": "${q}` } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
  })
  ev.push(
    ['content_block_start', { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: CUT_ID, name: 'kb__search', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"query": "upper deck win' } }],
  )
  if (withLastStop) ev.push(['content_block_stop', { type: 'content_block_stop', index: 4 }])
  ev.push(
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } }],
    ['message_stop', { type: 'message_stop' }],
  )
  return sse(ev)
}

const textReply = (text: string): string =>
  sse([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ])

/** A transport that answers each request with the next SSE body and keeps the request bodies. */
function transport(bodies: string[]): LlmTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  let i = 0
  return {
    sent,
    available: async () => true,
    async *stream(req: LlmHttpRequest) {
      sent.push(JSON.parse(req.body) as Record<string, unknown>)
      const body = bodies[i++] ?? textReply('Done.')
      yield new TextEncoder().encode(body)
    },
  }
}

type Block = { type: string; id?: string; tool_use_id?: string; content?: unknown }
type Msg = { role: string; content: string | Block[] }

/** Every tool_use in an assistant message has exactly one tool_result in the message right after it. */
function unpaired(messages: Msg[]): string[] {
  const out: string[] = []
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return
    const next = messages[i + 1]
    const results = next && Array.isArray(next.content) ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []
    for (const b of m.content) if (b.type === 'tool_use' && results.filter((r) => r === b.id).length !== 1) out.push(String(b.id))
  })
  return out
}

describe('a reply cut off in the middle of several tool calls', () => {
  for (const withLastStop of [false, true]) {
    it(`pairs every tool call and answers only the cut one as cut off (${withLastStop ? 'block closed' : 'block left open'})`, async () => {
      const t = transport([cutReply(withLastStop), textReply('The guides are in. Next I cut the upper deck windows.')])
      const client = createTransportClient(t, 'anthropic')
      const env = createEvalEnv({ client, machine: MACHINE, objects: [BOX] })
      for await (const _ of env.pilot.run('s', 'add rows of windows', { context: { machine: MACHINE } })) void _
      expect(t.sent.length).toBeGreaterThanOrEqual(2)
      const messages = t.sent[1]?.['messages'] as Msg[]
      expect(unpaired(messages)).toEqual([])
      const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []))
      const text = (id: string | undefined): string => {
        const r = results.find((b) => b.tool_use_id === id)
        return typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? '')
      }
      // the cut call did not run; the three complete ones before it did
      expect(text(CUT_ID)).toMatch(/cut off at the output limit/)
      for (const id of IDS.slice(0, 3)) expect(text(id)).not.toMatch(/cut off at the output limit/)
      // the signed thinking goes back unchanged
      const assistant = messages.find((m) => m.role === 'assistant' && Array.isArray(m.content))
      expect((assistant?.content as Block[])[0]).toMatchObject({ type: 'thinking', signature: 'sig' })
    })
  }
})
