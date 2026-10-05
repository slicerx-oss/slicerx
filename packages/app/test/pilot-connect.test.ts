// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { registerChatGpt, type ChatGptHost } from '../src/pilot-connect/chatgpt'
import { browserStore, keyStoreFor } from '../src/pilot-connect/keys'
import { pilotModel } from '../src/pilot-connect/llm'
import { authHeaders, browserTransport, localAllowed, testConnection } from '../src/pilot-connect/transport'
import { NEUTRAL } from '../src/edition'

function memStorage(): Storage {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size } }
}

const KEY = 'sk-test-0123456789abcdefghij'

describe('mimir keys', () => {
  it('stores the key encrypted, never as plain text, and reads it back', async () => {
    const ls = memStorage()
    const store = browserStore(ls)
    expect(await store.has('openai')).toBe(false)
    await store.set('openai', KEY)
    const raw = ls.getItem('slicerx.pilot.key.openai') ?? ''
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain('0123456789')
    expect(await store.get('openai')).toBe(KEY)
    await store.delete('openai')
    expect(await store.has('openai')).toBe(false)
  })

  it('on desktop writes through the host key commands, never the printer hub secrets, and never reads it back', async () => {
    const written: [string, string][] = []
    const hub: string[] = []
    const keys: Pick<ChatGptHost, 'hasApiKey' | 'setApiKey' | 'clearApiKey'> = { hasApiKey: async (p) => written.some(([q]) => q === p), setApiKey: async (p, k) => void written.push([p, k]), clearApiKey: async () => undefined }
    registerChatGpt(() => keys as ChatGptHost)
    try {
      const host = { capabilities: { secureStorage: true }, secrets: { has: async () => false, set: async (n: string) => void hub.push(n), delete: async () => undefined } } as unknown as Host
      const store = keyStoreFor(host)
      await store.set('anthropic', 'k')
      expect(written).toEqual([['anthropic', 'k']])
      expect(hub).toEqual([])
      expect(await store.has('anthropic')).toBe(true)
      expect(await store.has('openai')).toBe(false)
      expect(await store.get('anthropic')).toBeNull()
    } finally {
      registerChatGpt(null)
    }
  })
})

describe('mimir transport', () => {
  it('adds each provider its own auth headers', () => {
    expect(authHeaders('openai', 'k')).toEqual({ authorization: 'Bearer k' })
    expect(authHeaders('anthropic', 'k')).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
    expect(authHeaders('local', null)).toEqual({})
  })

  it('tests a connection with one call and explains failures without the key', async () => {
    let called = ''
    const ok = await testConnection({ provider: 'openai' }, KEY, (async (url: string) => { called = url; return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }) }) as typeof fetch)
    expect(ok).toEqual({ ok: true, message: 'Connected to OpenAI. 2 models available.' })
    expect(called).toBe('https://api.openai.com/v1/models')
    const refused = await testConnection({ provider: 'openai' }, KEY, (async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 })) as typeof fetch)
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/The key was refused/)
    expect(refused.message).not.toContain(KEY)
    expect((await testConnection({ provider: 'anthropic' }, null)).message).toBe('Paste the API key first.')
    const down = await testConnection({ provider: 'local', baseUrl: 'http://localhost:11434/v1' }, null, (async () => { throw new TypeError('fetch failed') }) as typeof fetch)
    expect(down.message).toMatch(/Start Ollama or LM Studio/)
  })

  it('keeps local models on this computer or the home network', async () => {
    expect(localAllowed('http://localhost:11434/v1/chat/completions')).toBe(true)
    expect(localAllowed('http://192.168.1.20:1234/v1')).toBe(true)
    expect(localAllowed('https://example.com/v1')).toBe(false)
    expect((await testConnection({ provider: 'local', baseUrl: 'https://example.com/v1' }, null)).ok).toBe(false)
  })

  it('streams through the browser transport with the stored key', async () => {
    const ls = memStorage()
    const store = browserStore(ls)
    await store.set('openai', KEY)
    const seen: Record<string, string>[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>)
      return new Response('data: hi\n\n', { status: 200 })
    }) as typeof fetch
    try {
      const t = browserTransport(store, () => ({ provider: 'openai' }))
      expect(await t.available('openai')).toBe(true)
      const chunks: Uint8Array[] = []
      for await (const c of t.stream({ provider: 'openai', url: 'https://api.openai.com/v1/responses', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })) chunks.push(c)
      expect(new TextDecoder().decode(chunks[0])).toContain('hi')
      expect(seen[0]?.['authorization']).toBe(`Bearer ${KEY}`)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('picks the adapter and model for each provider', () => {
    expect(pilotModel(NEUTRAL, { mode: 'on', provider: 'anthropic' })).toMatchObject({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })
    expect(pilotModel(NEUTRAL, { mode: 'on', provider: 'local', baseUrl: 'http://localhost:1234/v1', model: 'qwen' })).toEqual({ provider: 'openai-compatible', model: 'qwen', baseUrl: 'http://localhost:1234/v1' })
    expect(pilotModel(NEUTRAL, { mode: 'on', provider: 'openai' })?.provider).toBe('openai')
  })
})
