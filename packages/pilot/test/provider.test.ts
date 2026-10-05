// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { createOpenAiAdapter, decodeToolName, encodeToolName } from '../src/provider/openai'
import { parseSse } from '../src/provider/sse'
import type { LlmEvent } from '../src/provider/types'

async function* chunks(parts: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  for (const p of parts) yield enc.encode(p)
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('SSE parser', () => {
  it('handles events split across chunks and CRLF', async () => {
    const msgs = await collect(parseSse(chunks(['event: a\r\nda', 'ta: {"x":1}\r', '\n\r\ndata: two\n', 'data: lines\n\n: comment\n\ndata: last'])))
    expect(msgs).toEqual([{ event: 'a', data: '{"x":1}' }, { data: 'two\nlines' }, { data: 'last' }])
  })
})

describe('OpenAI Responses adapter', () => {
  const adapter = createOpenAiAdapter()

  it('builds a stateless streaming request without any key', () => {
    const req = adapter.build({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'kb.filament', arguments: '{"material":"petg"}' }] },
        { role: 'tool', callId: 'c1', content: '{"ok":true}' },
      ],
      tools: [{ name: 'kb.filament', description: 'd', parameters: { type: 'object', properties: {} } }],
      reasoning: 'medium',
      webSearch: true,
    })
    expect(req.url).toBe('https://api.openai.com/v1/responses')
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    const body = JSON.parse(req.body) as Record<string, unknown>
    expect(body['store']).toBe(false)
    expect(body['stream']).toBe(true)
    expect(body['model']).toBe('gpt-6-sol')
    expect(JSON.stringify(body['tools'])).toContain('kb__filament')
    expect(JSON.stringify(body['tools'])).toContain('web_search')
    expect(body['input']).toEqual([
      { role: 'developer', content: 'sys' },
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'kb__filament', arguments: '{"material":"petg"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ])
  })

  it('round-trips dotted tool names', () => {
    expect(decodeToolName(encodeToolName('spoolman.list_spools'))).toBe('spoolman.list_spools')
  })

  it('parses text, reasoning, tool calls, citations and usage', async () => {
    const ev = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
    const body = chunks([
      ev({ type: 'response.reasoning_summary_text.delta', delta: 'Think' }),
      ev({ type: 'response.output_text.delta', delta: 'Hello' }),
      ev({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] } }),
      ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'kb__filament', arguments: '{"material":"PETG"}' } }),
      ev({ type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation', url: 'https://example.org/a', title: 'A' }] }] } }),
      ev({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    ])
    const out: LlmEvent[] = await collect(adapter.parse(body))
    expect(out).toContainEqual({ type: 'reasoning', delta: 'Think' })
    expect(out).toContainEqual({ type: 'text', delta: 'Hello' })
    expect(out).toContainEqual({ type: 'tool_call', call: { id: 'call_1', name: 'kb.filament', arguments: '{"material":"PETG"}' } })
    expect(out).toContainEqual({ type: 'citation', url: 'https://example.org/a', title: 'A' })
    expect(out).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 })
    const done = out.at(-1)
    expect(done).toMatchObject({ type: 'done', stop: 'tool_calls' })
    // Reasoning keeps its id for the encrypted content; stored ids are dropped from the rest.
    const raw = done?.type === 'done' ? (done.raw as Record<string, unknown>[]) : []
    expect(raw[0]).toMatchObject({ type: 'reasoning', id: 'rs_1' })
    expect(raw[1]).not.toHaveProperty('id')
  })

  it('reports provider failures as errors', async () => {
    const out = await collect(adapter.parse(chunks([`data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'model not found' } } })}\n\n`])))
    expect(out).toContainEqual({ type: 'error', message: 'model not found', retryable: false })
  })
})
