// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Node transport's anthropic route, with fetch mocked: no request leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_KEY_ENV, createNodeTransport, TransportError } from '../src/node/index'
import { createAnthropicAdapter } from '../src/provider/anthropic'
import { createTransportClient } from '../src/provider/client'
import type { LlmEvent, LlmRequest } from '../src/provider/types'

const KEY = 'test-route-key-0123456789' // gitleaks:allow (a made-up test key)
const MODEL = 'test-model'

/** A Messages API stream: one text block, one tool_use block split across deltas, and the usage. */
function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}
const TOOL_REPLY = sse([
  { type: 'message_start', message: { usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 9000, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Making it.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'make_model', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name":"Hook","parts":[{"kind":"box",' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"sizeMm":[40,20,5]}]}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 420 } },
  { type: 'message_stop' },
])

const REQUEST: LlmRequest = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You design parts.' },
    { role: 'user', content: 'A headphone hook.' },
  ],
  tools: [{ name: 'make_model', description: 'Adds a part.', parameters: { type: 'object', properties: {} } }],
}

interface Sent {
  url: string
  init: RequestInit
}
let sent: Sent[] = []

function mockFetch(reply: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} })
      return reply()
    }),
  )
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const ev of it) out.push(ev)
  return out
}

beforeEach(() => {
  sent = []
  for (const n of ANTHROPIC_KEY_ENV) vi.stubEnv(n, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('node transport, anthropic route', () => {
  it('sends the request the app builds to the Messages API with the key header the desktop transport adds', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    mockFetch(() => new Response(TOOL_REPLY, { status: 200 }))
    await collect(createTransportClient(createNodeTransport(), 'anthropic').stream(REQUEST))
    expect(sent).toHaveLength(1)
    const [{ url, init }] = sent as [Sent]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    // the body is the adapter's, byte for byte: the transport adds headers only
    expect(init.body).toBe(createAnthropicAdapter().build(REQUEST).body)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: MODEL, stream: true, tools: [{ name: 'make_model', input_schema: { type: 'object' } }] })
  })

  it('SLICERX_ANTHROPIC_API_KEY wins over ANTHROPIC_API_KEY, as on the desktop', async () => {
    vi.stubEnv('SLICERX_ANTHROPIC_API_KEY', `${KEY}-app`)
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    mockFetch(() => new Response(TOOL_REPLY, { status: 200 }))
    await collect(createTransportClient(createNodeTransport(), 'anthropic').stream(REQUEST))
    expect((sent[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(`${KEY}-app`)
  })

  it('parses the streamed tool call and its usage, cache counts included', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    mockFetch(() => new Response(TOOL_REPLY, { status: 200 }))
    const events = await collect(createTransportClient(createNodeTransport(), 'anthropic').stream(REQUEST))
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'Making it.' }])
    const calls = events.filter((e) => e.type === 'tool_call')
    expect(calls).toEqual([{ type: 'tool_call', call: { id: 'toolu_1', name: 'make_model', arguments: '{"name":"Hook","parts":[{"kind":"box","sizeMm":[40,20,5]}]}' } }])
    // inputTokens holds all input, cache writes and reads included; the cost split reads the two cache counts
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', inputTokens: 13200, outputTokens: 420, cacheReadTokens: 9000, cacheWriteTokens: 3000 })
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'tool_calls' })
  })

  it('a missing key fails before any request and names only the variable', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'other-provider-key-should-not-appear')
    mockFetch(() => new Response(TOOL_REPLY, { status: 200 }))
    const transport = createNodeTransport()
    expect(await transport.available('anthropic')).toBe(false)
    const err = await collect(transport.stream(createAnthropicAdapter().build(REQUEST))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).status).toBe(401)
    expect((err as TransportError).message).toBe('No API key for anthropic: set ANTHROPIC_API_KEY (or SLICERX_ANTHROPIC_API_KEY)')
    expect(sent).toHaveLength(0)
    // through the client it is an error event, with the same words and nothing from the request
    const events = await collect(createTransportClient(createNodeTransport(), 'anthropic').stream(REQUEST))
    const e = events.find((x) => x.type === 'error')
    expect(e).toMatchObject({ type: 'error', message: 'No API key for anthropic: set ANTHROPIC_API_KEY (or SLICERX_ANTHROPIC_API_KEY)' })
    expect(JSON.stringify(events)).not.toMatch(/headphone|You design|other-provider/)
  })

  it('an HTTP error carries the status and the provider message, with the key taken out', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    mockFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }), { status: 401, statusText: 'Unauthorized' }))
    const err = await collect(createNodeTransport().stream(createAnthropicAdapter().build(REQUEST))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).status).toBe(401)
    expect((err as TransportError).message).toBe('anthropic 401: invalid x-api-key [key]')
    expect((err as TransportError).message).not.toContain(KEY)
    // a body that is not JSON keeps the status text
    mockFetch(() => new Response('<html>overloaded</html>', { status: 529, statusText: 'Overloaded' }))
    const events = await collect(createTransportClient(createNodeTransport(), 'anthropic').stream(REQUEST))
    expect(events).toEqual([
      { type: 'error', message: 'anthropic 529: Overloaded', retryable: true },
      { type: 'done', stop: 'error' },
    ])
  })

  it('never follows a redirect, so the key header cannot reach another host', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    vi.stubEnv('OPENAI_API_KEY', `${KEY}-openai`)
    // fetch as Node runs it: a 307 to another origin is followed with the custom key header still on, unless
    // redirect is 'error', which fails the call instead
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        sent.push({ url: String(url), init: init ?? {} })
        if (init?.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
        sent.push({ url: 'https://evil.example/v1/messages', init: init ?? {} })
        return new Response(TOOL_REPLY, { status: 200 })
      }),
    )
    const transport = createNodeTransport()
    const err = await collect(transport.stream(createAnthropicAdapter().build(REQUEST))).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).message).toBe('anthropic request failed: fetch failed: unexpected redirect')
    expect(sent.map((s) => s.url)).toEqual(['https://api.anthropic.com/v1/messages'])
    expect(sent[0]!.init.redirect).toBe('error')
    // every route sends with redirect 'error'
    const openai = await collect(createTransportClient(transport, 'openai').stream(REQUEST))
    expect(openai.find((e) => e.type === 'error')).toMatchObject({ message: 'openai request failed: fetch failed: unexpected redirect' })
    expect(sent.map((s) => s.init.redirect)).toEqual(['error', 'error'])
    expect(sent.some((s) => s.url.includes('evil.example'))).toBe(false)
  })

  it('a failed fetch that quotes the key loses it, and a key with a line break inside counts as missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    mockFetch(() => {
      throw new TypeError(`Headers.append: "${KEY}" is an invalid header value.`)
    })
    const err = await collect(createNodeTransport().stream(createAnthropicAdapter().build(REQUEST))).catch((e: unknown) => e)
    expect((err as TransportError).message).toBe('anthropic request failed: Headers.append: "[key]" is an invalid header value.')
    sent = []
    vi.stubEnv('ANTHROPIC_API_KEY', `${KEY}\n${KEY}`)
    const transport = createNodeTransport()
    expect(await transport.available('anthropic')).toBe(false)
    await expect(collect(transport.stream(createAnthropicAdapter().build(REQUEST)))).rejects.toThrow('No API key for anthropic: set ANTHROPIC_API_KEY (or SLICERX_ANTHROPIC_API_KEY)')
    expect(sent).toHaveLength(0)
  })

  it('sends only to api.anthropic.com over https, and refuses a request that brings its own key header', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY)
    mockFetch(() => new Response(TOOL_REPLY, { status: 200 }))
    const transport = createNodeTransport()
    const good = createAnthropicAdapter().build(REQUEST)
    for (const url of ['http://api.anthropic.com/v1/messages', 'https://api.anthropic.com:8443/v1/messages', 'https://api.anthropic.com.evil.example/v1/messages', 'https://api.openai.com/v1/messages']) {
      await expect(collect(transport.stream({ ...good, url }))).rejects.toThrow(/^Refusing to send an? anthropic request/)
    }
    for (const h of ['x-api-key', 'Anthropic-Version', 'Authorization']) {
      await expect(collect(transport.stream({ ...good, headers: { ...good.headers, [h]: 'x' } }))).rejects.toThrow('Requests must not carry their own authorization header')
    }
    expect(sent).toHaveLength(0)
  })
})
