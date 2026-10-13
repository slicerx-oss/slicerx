// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { createAnthropicAdapter } from '../src/provider/anthropic'
import { adapterFor } from '../src/provider/client'
import { createOpenAiCompatibleAdapter } from '../src/provider/openai-compatible'
import type { LlmEvent, LlmRequest } from '../src/provider/types'

async function* chunks(parts: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  for (const p of parts) yield enc.encode(p)
}
async function collect(it: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = []
  for await (const x of it) out.push(x)
  return out
}
const sse = (events: [string, unknown][]): string[] => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)

const REQ: LlmRequest = {
  model: 'm',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'kb.filament', arguments: '{"material":"petg"}' }, { id: 'c2', name: 'printer.list', arguments: '{}' }] },
    { role: 'tool', callId: 'c1', content: '{"ok":true}' },
    { role: 'tool', callId: 'c2', content: '[]' },
  ],
  tools: [{ name: 'kb.filament', description: 'd', parameters: { type: 'object', properties: {} } }],
}

describe('adapter registry', () => {
  it('knows all three providers', () => {
    expect(['openai', 'anthropic', 'openai-compatible'].map((p) => adapterFor(p).id)).toEqual(['openai', 'anthropic', 'openai-compatible'])
  })
})

describe('Anthropic adapter', () => {
  const adapter = createAnthropicAdapter()

  it('builds a streaming request with no key and merges tool results into one user message', () => {
    const http = adapter.build({ ...REQ, reasoning: 'medium', webSearch: true })
    expect(http.url).toBe('https://api.anthropic.com/v1/messages')
    const names = Object.keys(http.headers).map((h) => h.toLowerCase())
    for (const bad of ['x-api-key', 'authorization', 'anthropic-version']) expect(names).not.toContain(bad)
    const body = JSON.parse(http.body) as Record<string, unknown>
    expect(body['stream']).toBe(true)
    expect(body['system']).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }])
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(body['max_tokens']).toBe(8192 + 8192)
    expect(JSON.stringify(body['tools'])).toContain('kb__filament')
    expect(JSON.stringify(body['tools'])).toContain('web_search_20250305')
    const messages = body['messages'] as { role: string; content: unknown }[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'c1', name: 'kb__filament', input: { material: 'petg' } },
      { type: 'tool_use', id: 'c2', name: 'printer__list', input: {} },
    ])
    expect(messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' },
      { type: 'tool_result', tool_use_id: 'c2', content: '[]' },
    ])
  })

  it('does not force tool use while thinking, and needs no thinking field without reasoning', () => {
    const forced = JSON.parse(adapter.build({ ...REQ, toolChoice: 'required', reasoning: 'low' }).body) as Record<string, unknown>
    expect(forced['tool_choice']).toEqual({ type: 'auto' })
    const plain = JSON.parse(adapter.build({ ...REQ, toolChoice: 'required' }).body) as Record<string, unknown>
    expect(plain['tool_choice']).toEqual({ type: 'any' })
    expect(plain['thinking']).toBeUndefined()
  })

  it('marks cache points on the last client tool and the system prompt', () => {
    const body = JSON.parse(adapter.build({ ...REQ, webSearch: true }).body) as { tools: Record<string, unknown>[] }
    const marked = body.tools.filter((t) => t['cache_control'])
    expect(marked).toHaveLength(1)
    // the server tool comes after the cache point, which the proxy rebuilds without one
    expect(marked[0]?.['name']).toBe(body.tools.filter((t) => !t['type']).at(-1)?.['name'])
    expect(body.tools.at(-1)?.['type']).toBe('web_search_20250305')
    const none = JSON.parse(adapter.build({ ...REQ, tools: [], messages: [{ role: 'user', content: 'hi' }] }).body) as Record<string, unknown>
    expect(none['tools']).toBeUndefined()
    expect(none['system']).toBeUndefined()
  })

  it('uses adaptive thinking and an effort on current models, never a token budget', () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-4-6']) {
      const body = JSON.parse(adapter.build({ ...REQ, model, reasoning: 'medium' }).body) as Record<string, unknown>
      expect(body['thinking'], model).toEqual({ type: 'adaptive' })
      expect(body['output_config'], model).toEqual({ effort: 'medium' })
      expect(JSON.stringify(body), model).not.toContain('budget_tokens')
    }
    // older models keep the budget
    const old = JSON.parse(adapter.build({ ...REQ, model: 'claude-haiku-4-5', reasoning: 'low' }).body) as Record<string, unknown>
    expect(old['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(old['output_config']).toBeUndefined()
    // no reasoning asked: no thinking field, the model's own default holds
    const plain = JSON.parse(adapter.build({ ...REQ, model: 'claude-haiku-5-5' }).body) as Record<string, unknown>
    expect(plain['thinking']).toBeUndefined()
    expect(plain['output_config']).toBeUndefined()
  })

  it('never forces a tool on models that refuse it or think by default', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5']) {
      const body = JSON.parse(adapter.build({ ...REQ, model, toolChoice: 'required' }).body) as Record<string, unknown>
      expect(body['tool_choice'], model).toEqual({ type: 'auto' })
    }
    for (const model of ['claude-opus-4-8', 'claude-haiku-4-5']) {
      const body = JSON.parse(adapter.build({ ...REQ, model, toolChoice: 'required' }).body) as Record<string, unknown>
      expect(body['tool_choice'], model).toEqual({ type: 'any' })
    }
    const none = JSON.parse(adapter.build({ ...REQ, model: 'claude-opus-5-5', toolChoice: 'none' }).body) as Record<string, unknown>
    expect(none['tool_choice']).toEqual({ type: 'none' })
  })

  it('sends assistant raw blocks back unchanged', () => {
    const raw = [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'tool_use', id: 'c1', name: 'kb__filament', input: {} }]
    const body = JSON.parse(adapter.build({ ...REQ, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', toolCalls: [], raw }] }).body) as { messages: { content: unknown }[] }
    expect(body.messages[1]?.content).toEqual(raw)
  })

  it('parses text, thinking with its signature, a tool call and usage, across odd chunking', async () => {
    const text = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 1 } } }],
      ['ping', { type: 'ping' }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look up ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PETG.' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'kb__filament', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"mater' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ial":"petg"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }],
      ['message_stop', { type: 'message_stop' }],
    ]).join('')
    const mid = Math.floor(text.length / 3)
    const events = await collect(adapter.parse(chunks([text.slice(0, mid), text.slice(mid, mid + 7), text.slice(mid + 7)])))
    expect(events.filter((e) => e.type === 'reasoning').map((e) => (e as { delta: string }).delta).join('')).toBe('Look up PETG.')
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Checking')
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'toolu_1', name: 'kb.filament', arguments: '{"material":"petg"}' } })
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 25, outputTokens: 42 })
    const done = events.at(-1) as Extract<LlmEvent, { type: 'done' }>
    expect(done.stop).toBe('tool_calls')
    expect(done.raw).toEqual([
      { type: 'thinking', thinking: 'Look up PETG.', signature: 'abc' },
      { type: 'text', text: 'Checking' },
      { type: 'tool_use', id: 'toolu_1', name: 'kb__filament', input: { material: 'petg' } },
    ])
  })

  it('maps max_tokens to length, a tool call with empty input to {}, and stream errors', async () => {
    const len = await collect(adapter.parse(chunks(sse([['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3 } }]]))))
    expect((len.at(-1) as { stop: string }).stop).toBe('length')
    const empty = await collect(adapter.parse(chunks(sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'printer__list', input: {} } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ]))))
    expect((empty.find((e) => e.type === 'tool_call') as { call: { arguments: string } }).call.arguments).toBe('{}')
    const err = await collect(adapter.parse(chunks(sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]))))
    expect(err.find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'Overloaded', retryable: true })
    expect((err.at(-1) as { stop: string }).stop).toBe('error')
  })

  it('reports web search citations', async () => {
    const events = await collect(adapter.parse(chunks(sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.com/a', title: 'A' } } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ]))))
    expect(events.find((e) => e.type === 'citation')).toEqual({ type: 'citation', url: 'https://example.com/a', title: 'A' })
  })
})

describe('OpenAI-compatible adapter', () => {
  const adapter = createOpenAiCompatibleAdapter()
  const data = (objs: unknown[]): string[] => [...objs.map((o) => `data: ${JSON.stringify(o)}\n\n`), 'data: [DONE]\n\n']

  it('builds a chat completions request against the base URL with no key', () => {
    const http = adapter.build(REQ, { baseUrl: 'http://127.0.0.1:1234/v1/' })
    expect(http.url).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(adapter.build(REQ).url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(Object.keys(http.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    const body = JSON.parse(http.body) as Record<string, unknown>
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
    expect((body['tools'] as { function: { name: string } }[])[0]?.function.name).toBe('kb__filament')
    expect((body['messages'] as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool'])
    expect((body['messages'] as { tool_calls?: unknown[] }[])[2]?.tool_calls).toHaveLength(2)
  })

  it('parses text, reasoning, and tool calls split across deltas, including a missing id', async () => {
    const events = await collect(adapter.parse(chunks(data([
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'kb__filament', arguments: '{"mater' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ial":"pla"}' } }, { index: 1, function: { name: 'printer__list', arguments: { all: true } } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ]))))
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello')
    expect(events.find((e) => e.type === 'reasoning')).toEqual({ type: 'reasoning', delta: 'think' })
    const calls = events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: unknown }).call)
    expect(calls).toEqual([
      { id: 'call_a', name: 'kb.filament', arguments: '{"material":"pla"}' },
      { id: 'call_1', name: 'printer.list', arguments: '{"all":true}' },
    ])
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 11, outputTokens: 7 })
    expect((events.at(-1) as { stop: string }).stop).toBe('tool_calls')
  })

  it('maps length and error replies', async () => {
    const len = await collect(adapter.parse(chunks(data([{ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }]))))
    expect((len.at(-1) as { stop: string }).stop).toBe('length')
    const err = await collect(adapter.parse(chunks(data([{ error: { message: 'model not found' } }]))))
    expect(err.find((e) => e.type === 'error')).toMatchObject({ message: 'model not found' })
    expect((err.at(-1) as { stop: string }).stop).toBe('error')
  })
})
