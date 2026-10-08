// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowedModels,
  checkModel,
  contextTag,
  detectRunners,
  ensureContext,
  fetchNet,
  installedName,
  LOCAL_MODELS,
  localAiUrlAllowed,
  licenseOf,
  MIMIR_CONTEXT,
  nextModelUp,
  OLLAMA_DOWNLOAD,
  pullModel,
  recommend,
  strictToolCall,
  type Hardware,
  type LocalModel,
  type LocalNet,
  type PullProgress,
} from '../src/pilot-connect/local-ai'

const enc = new TextEncoder()
const model = (id: string): LocalModel => LOCAL_MODELS.find((m) => m.id === id) as LocalModel
const card = (name: string, vramMb: number, ramMb = 32768): Hardware => ({ gpu: { name, vramMb, unified: false }, ramMb, cores: 16, source: 'desktop' })
const apple = (name: string, budgetMb: number, ramMb: number): Hardware => ({ gpu: { name, vramMb: budgetMb, unified: true }, ramMb, cores: 12, source: 'desktop' })
const cpuOnly = (ramMb: number): Hardware => ({ gpu: null, ramMb, cores: 8, source: 'desktop' })

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield enc.encode(p)
}

/** A local net that answers GETs from a table and POSTs from a queue, and records every URL. */
function mockNet(gets: Record<string, string | null>, posts: ((body: string, signal?: AbortSignal) => AsyncIterable<Uint8Array>)[] = []): LocalNet & { urls: string[]; bodies: string[] } {
  const urls: string[] = []
  const bodies: string[] = []
  return {
    urls,
    bodies,
    async get(url) {
      urls.push(url)
      return gets[url] ?? null
    },
    post(url, body, signal) {
      urls.push(url)
      bodies.push(body)
      const next = posts.shift()
      if (!next) throw new Error('unexpected post')
      return next(body, signal)
    },
  }
}

describe('local AI recommendation', () => {
  it('picks the largest model the graphics memory fits, with a plain reason', () => {
    const r = recommend(card('NVIDIA GeForce RTX 4070', 12282))
    expect(r).toMatchObject({ kind: 'model', onGpu: true, model: { id: 'qwen-2.5-14b' } })
    expect(r.reason).toBe('Your RTX 4070 has 12 GB, so Qwen 2.5 14B fits well.')
    expect(recommend(card('NVIDIA GeForce RTX 5080', 16303))).toMatchObject({ model: { id: 'qwen-2.5-14b' } })
    expect(recommend(card('NVIDIA GeForce RTX 4090', 24564))).toMatchObject({ model: { id: 'qwen-2.5-32b' } })
    expect(recommend(card('NVIDIA GeForce RTX 4060', 8188))).toMatchObject({ model: { id: 'qwen-2.5-7b' } })
    expect(recommend(card('NVIDIA GeForce GTX 1650', 4096, 16384))).toMatchObject({ model: { id: 'llama-3.2-3b' }, onGpu: true })
  })

  it('counts the share of unified memory the GPU may use on Apple Silicon', () => {
    const big = recommend(apple('Apple M3 Pro', 24576, 36864))
    expect(big).toMatchObject({ model: { id: 'qwen-2.5-32b' } })
    expect(big.reason).toBe('Your Apple M3 Pro can give about 24 GB of its shared memory to a model, so Qwen 2.5 32B fits well.')
    expect(recommend(apple('Apple M2', 10922, 16384))).toMatchObject({ model: { id: 'qwen-2.5-7b' } })
  })

  it('falls back to the processor with enough memory, and says answers are slower', () => {
    const r = recommend(cpuOnly(16384))
    expect(r).toMatchObject({ kind: 'model', onGpu: false, model: { id: 'qwen-2.5-7b' } })
    expect(r.reason).toContain('runs on the processor with 16 GB')
    // A 2 GB card is too small, so the processor runs it.
    expect(recommend(card('Radeon RX 550', 2048, 8192))).toMatchObject({ onGpu: false, model: { id: 'llama-3.2-3b' } })
  })

  it('says when the machine is too weak and points to cloud or ChatGPT', () => {
    const r = recommend(cpuOnly(4096))
    expect(r.kind).toBe('too-weak')
    expect(r.reason).toMatch(/cloud model or sign in with ChatGPT/)
  })

  it('in the browser, suggests the desktop app instead of guessing', () => {
    expect(recommend({ gpu: null, ramMb: 8192, cores: 8, source: 'browser' })).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/desktop app/) })
  })

  it('suggests the next model up only when it still fits', () => {
    expect(nextModelUp(model('llama-3.2-3b'), card('GTX 1650', 4096, 16384))?.id).toBe('llama-3.1-8b')
    expect(nextModelUp(model('qwen-2.5-7b'), card('RTX 4060', 8188, 32768))).toBeNull()
    expect(nextModelUp(model('qwen-2.5-14b'), card('RTX 4090', 24564))?.id).toBe('qwen-2.5-32b')
  })

  it('offers only the models an edition allows', () => {
    const only = allowedModels(['qwen-2.5-7b', 'llama-3.2-3b'])
    expect(only.map((m) => m.id)).toEqual(['llama-3.2-3b', 'qwen-2.5-7b'])
    expect(recommend(card('NVIDIA GeForce RTX 4090', 24564), only)).toMatchObject({ model: { id: 'qwen-2.5-7b' } })
    expect(nextModelUp(model('qwen-2.5-7b'), card('NVIDIA GeForce RTX 4090', 24564), only)).toBeNull()
    expect(allowedModels(undefined)).toBe(LOCAL_MODELS)
  })

  it('has a table with measured or provisional figures and a plain license for every model', () => {
    for (const m of LOCAL_MODELS) {
      // Measured on the benchmark means a speed; a model not measured yet is marked provisional.
      expect(m.provisional).toBe(m.tokensPerSecond === null)
      expect(m.downloadGb).toBeGreaterThan(0)
      expect(licenseOf(m).plain.length).toBeGreaterThan(10)
    }
    expect(licenseOf(model('qwen-2.5-14b')).name).toBe('Apache 2.0')
    expect(licenseOf(model('llama-3.1-8b')).name).toMatch(/Meta Llama 3\.1 Community License/)
  })
})

describe('local AI runners', () => {
  const tags = JSON.stringify({ models: [{ name: 'qwen2.5:14b' }, { name: 'llama3.2:3b' }] })
  const lm = JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'text-embedding-nomic-embed-text-v1.5' }] })

  it('finds a running Ollama and LM Studio by their listings', async () => {
    const net = mockNet({ 'http://127.0.0.1:11434/api/tags': tags, 'http://127.0.0.1:1234/v1/models': lm })
    const found = await detectRunners(net)
    expect(found.map((r) => [r.kind, r.base])).toEqual([
      ['ollama', 'http://127.0.0.1:11434/v1'],
      ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ])
    expect(found[1]?.models).toEqual(['qwen2.5-7b-instruct'])
    expect(installedName(found[0]!, model('qwen-2.5-14b'))).toBe('qwen2.5:14b')
    expect(installedName(found[0]!, model('qwen-2.5-32b'))).toBeNull()
    expect(installedName(found[1]!, model('qwen-2.5-7b'))).toBe('qwen2.5-7b-instruct')
  })

  it('finds only the one that runs, and nothing when neither does', async () => {
    expect((await detectRunners(mockNet({ 'http://127.0.0.1:1234/v1/models': lm }))).map((r) => r.kind)).toEqual(['lmstudio'])
    expect(await detectRunners(mockNet({}))).toEqual([])
    // A server that answers something else is not taken for Ollama.
    expect(await detectRunners(mockNet({ 'http://127.0.0.1:11434/api/tags': '<html>' }))).toEqual([])
  })
})

describe('local AI download', () => {
  it('shows progress summed over layers, across split lines, and finishes on success', async () => {
    const lines = [
      '{"status":"pulling manifest"}\n',
      '{"status":"pulling a","digest":"sha256:a","total":1000,"completed":0}\n{"status":"pulling a","digest":"sha256:a","total":1000,"comp',
      'leted":500}\n',
      '{"status":"pulling b","digest":"sha256:b","total":200,"completed":200}\n',
      '{"status":"pulling a","digest":"sha256:a","total":1000,"completed":1000}\n',
      '{"status":"verifying sha256 digest"}\n{"status":"success"}\n',
    ]
    const net = mockNet({}, [() => chunks(...lines)])
    const seen: PullProgress[] = []
    await pullModel(net, 'qwen2.5:14b', (p) => seen.push(p))
    expect(net.urls).toEqual(['http://127.0.0.1:11434/api/pull'])
    expect(JSON.parse(net.bodies[0]!)).toEqual({ model: 'qwen2.5:14b', stream: true })
    expect(seen.map((p) => [p.completedBytes, p.totalBytes])).toContainEqual([500, 1000])
    expect(seen.at(-1)).toEqual({ status: 'success', completedBytes: 1200, totalBytes: 1200 })
  })

  it('reports an Ollama error and a stream that stops early', async () => {
    await expect(pullModel(mockNet({}, [() => chunks('{"error":"pull model manifest: file does not exist"}\n')]), 'nope:1b', () => undefined)).rejects.toThrow(/could not download nope:1b: pull model manifest/)
    await expect(pullModel(mockNet({}, [() => chunks('{"status":"pulling a","digest":"a","total":10,"completed":1}\n')]), 'x', () => undefined)).rejects.toThrow(/stopped before it finished/)
  })

  it('cancels: the request gets the signal and the pull rejects with an AbortError', async () => {
    const ctl = new AbortController()
    let gotSignal: AbortSignal | undefined
    const net = mockNet({}, [
      (_b, signal) => {
        gotSignal = signal
        return (async function* () {
          yield enc.encode('{"status":"pulling a","digest":"a","total":100,"completed":10}\n')
          ctl.abort()
          yield enc.encode('{"status":"pulling a","digest":"a","total":100,"completed":20}\n')
        })()
      },
    ])
    const seen: PullProgress[] = []
    await expect(pullModel(net, 'qwen2.5:7b', (p) => seen.push(p), ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(gotSignal).toBe(ctl.signal)
    expect(seen).toHaveLength(1)
  })
})

const sse = (...events: unknown[]): string[] => [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n']
const toolReply = (name: string, args: string) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
const textReply = () => sse({ choices: [{ delta: { content: 'PETG melts higher.' } }] }, { choices: [{ delta: { content: ' It needs more heat.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 40 } })

describe('local AI check', () => {
  it('passes a strict kb.filament call, times the answer from its first word, and stays on localhost', async () => {
    const net = mockNet({}, [() => chunks(...toolReply('kb__filament', '{"material":"PETG"}')), () => chunks(...textReply())])
    const times = [1000, 3000]
    const r = await checkModel(net, 'http://127.0.0.1:11434/v1', 'qwen2.5:14b', { now: () => times.shift() ?? 3000 })
    expect(r).toEqual({ ok: true, toolCall: true, tokensPerSecond: 20, contextTokens: null, message: 'Tool call passed. About 20 tokens per second.' })
    expect(net.urls).toEqual(['http://127.0.0.1:11434/v1/chat/completions', 'http://127.0.0.1:11434/api/ps', 'http://127.0.0.1:11434/v1/chat/completions'])
    const first = JSON.parse(net.bodies[0]!) as { model: string; tools: { function: { name: string } }[] }
    expect(first.model).toBe('qwen2.5:14b')
    expect(first.tools.map((t) => t.function.name)).toEqual(['kb__filament'])
  })

  it('fails plainly when the model skips the tool or gets it wrong', async () => {
    for (const reply of [textReply(), toolReply('kb__printer', '{"material":"PETG"}'), toolReply('kb__filament', '{"material":"PETG","extra":1}'), toolReply('kb__filament', '{material: PETG}'), toolReply('kb__filament', '{"material":"PLA"}')]) {
      const r = await checkModel(mockNet({}, [() => chunks(...reply)]), 'http://127.0.0.1:1234/v1', 'm')
      expect(r).toMatchObject({ ok: false, toolCall: false })
      expect(r.message).toMatch(/did not make the tool call correctly/)
    }
  })

  it('reports a server that does not answer', async () => {
    const net = mockNet({}, [
      () => {
        throw new Error('connection refused')
      },
    ])
    expect(await checkModel(net, 'http://127.0.0.1:11434/v1', 'm')).toMatchObject({ ok: false, message: 'The model did not answer: connection refused' })
  })

  it('fails a model Ollama loaded with too little context, before timing it, and passes one with enough', async () => {
    const ps = (ctx: number) => JSON.stringify({ models: [{ name: 'qwen2.5:14b-instruct-ctx16k', model: 'qwen2.5:14b-instruct-ctx16k', context_length: ctx }] })
    const small = mockNet({ 'http://127.0.0.1:11434/api/ps': ps(4096) }, [() => chunks(...toolReply('kb__filament', '{"material":"PETG"}'))])
    const r = await checkModel(small, 'http://127.0.0.1:11434/v1', 'qwen2.5:14b-instruct-ctx16k')
    expect(r).toMatchObject({ ok: false, toolCall: true, tokensPerSecond: null, contextTokens: 4096 })
    expect(r.message).toMatch(/room for 4096 tokens, and mimir needs 16384/)
    expect(r.message).toMatch(/Set it up again here/)
    expect(small.urls.filter((u) => u.endsWith('/chat/completions'))).toHaveLength(1)

    const big = mockNet({ 'http://127.0.0.1:11434/api/ps': ps(MIMIR_CONTEXT) }, [() => chunks(...toolReply('kb__filament', '{"material":"PETG"}')), () => chunks(...textReply())])
    expect(await checkModel(big, 'http://127.0.0.1:11434/v1', 'qwen2.5:14b-instruct-ctx16k')).toMatchObject({ ok: true, contextTokens: 16384 })
  })

  it('reads the loaded context from LM Studio and says how to raise it there', async () => {
    const net = mockNet({ 'http://127.0.0.1:1234/api/v0/models': JSON.stringify({ data: [{ id: 'other', loaded_context_length: 32768 }, { id: 'qwen2.5-14b-instruct', loaded_context_length: 4096 }] }) }, [() => chunks(...toolReply('kb__filament', '{"material":"PETG"}'))])
    const r = await checkModel(net, 'http://127.0.0.1:1234/v1', 'qwen2.5-14b-instruct')
    expect(r).toMatchObject({ ok: false, toolCall: true, contextTokens: 4096 })
    expect(r.message).toMatch(/In LM Studio, load it again with a context length of 16384 or more/)
  })

  it('parses arguments strictly', async () => {
    expect(await strictToolCall([{ name: 'kb.filament', arguments: '{"material":"petg"}' }])).toBe(true)
    expect(await strictToolCall([{ name: 'kb.filament', arguments: '{"material":""}' }])).toBe(false)
    expect(await strictToolCall([{ name: 'kb.filament', arguments: '["PETG"]' }])).toBe(false)
    expect(await strictToolCall([])).toBe(false)
  })
})

describe('local AI context', () => {
  it('names the variant after the tag, once', () => {
    expect(contextTag('qwen2.5:14b-instruct')).toBe('qwen2.5:14b-instruct-ctx16k')
    expect(contextTag('qwen2.5:14b-instruct-ctx16k')).toBe('qwen2.5:14b-instruct-ctx16k')
    expect(contextTag('mistral-small')).toBe('mistral-small:latest-ctx16k')
    expect(contextTag('hf.co/org/model')).toBe('hf.co/org/model:latest-ctx16k')
    expect(contextTag('llama3.1:8b', 32768)).toBe('llama3.1:8b-ctx32k')
  })

  it('creates the variant from the pulled tag with num_ctx, through Ollama on localhost', async () => {
    const net = mockNet({}, [() => chunks('{"status":"using existing layer sha256:aa"}\n{"status":"writing manifest"}\n', '{"status":"success"}\n')])
    expect(await ensureContext(net, 'qwen2.5:14b-instruct')).toBe('qwen2.5:14b-instruct-ctx16k')
    expect(net.urls).toEqual(['http://127.0.0.1:11434/api/create'])
    expect(JSON.parse(net.bodies[0]!)).toEqual({ model: 'qwen2.5:14b-instruct-ctx16k', from: 'qwen2.5:14b-instruct', parameters: { num_ctx: 16384 }, stream: true })
  })

  it('leaves a tag that already has the context, and reports Ollama errors and early stops', async () => {
    const none = mockNet({})
    expect(await ensureContext(none, 'qwen2.5:14b-instruct-ctx16k')).toBe('qwen2.5:14b-instruct-ctx16k')
    expect(none.urls).toEqual([])
    await expect(ensureContext(mockNet({}, [() => chunks('{"error":"model not found"}\n')]), 'nope:1b')).rejects.toThrow(/could not give nope:1b room for 16384 tokens: model not found/)
    await expect(ensureContext(mockNet({}, [() => chunks('{"status":"writing manifest"}\n')]), 'qwen2.5:7b')).rejects.toThrow(/stopped before qwen2.5:7b was set up/)
  })
})

describe('local AI network', () => {
  it('the browser net refuses anything but the two local servers, without a request', async () => {
    const called: string[] = []
    const net = fetchNet((async (url: string) => {
      called.push(url)
      return new Response('{}')
    }) as typeof fetch)
    await expect(net.get('https://ollama.com/api/tags')).rejects.toThrow(/Only Ollama and LM Studio/)
    await expect((async () => {
      for await (const _ of net.post('http://192.168.1.20:11434/api/pull', '{}')) break
    })()).rejects.toThrow(/Only Ollama and LM Studio/)
    expect(called).toEqual([])
    expect(await net.get('http://127.0.0.1:11434/api/tags')).toBe('{}')
    expect(called).toEqual(['http://127.0.0.1:11434/api/tags'])
  })

  it('allows only 127.0.0.1 on the Ollama and LM Studio ports', () => {
    expect(localAiUrlAllowed('http://127.0.0.1:11434/api/pull')).toBe(true)
    expect(localAiUrlAllowed('http://127.0.0.1:1234/v1/chat/completions')).toBe(true)
    for (const u of ['http://127.0.0.1:8080/', 'https://127.0.0.1:11434/', 'http://localhost.evil.example:11434/', 'http://x@127.0.0.1:11434/', OLLAMA_DOWNLOAD]) expect(localAiUrlAllowed(u)).toBe(false)
  })

  it('names no address but the local servers and the Ollama download page, which the desktop opener allows', () => {
    const files = ['../src/pilot-connect/local-ai.ts', '../src/pilot-connect/local-ai-card.tsx', '../../../apps/desktop/src/host/local-ai.ts']
    for (const f of files) {
      const text = readFileSync(join(__dirname, f), 'utf8')
      for (const url of text.match(/https?:\/\/[^\s'"`)]+/g) ?? []) expect([OLLAMA_DOWNLOAD, 'http://127.0.0.1:11434', 'http://127.0.0.1:1234'], `${f}: ${url}`).toContain(url)
    }
    const caps = JSON.parse(readFileSync(join(__dirname, '../../../apps/desktop/src-tauri/capabilities/shared-links.json'), 'utf8')) as { permissions: (string | { identifier: string; allow: { url: string }[] })[] }
    const opener = caps.permissions.find((p) => typeof p === 'object' && p.identifier === 'opener:allow-open-url') as { allow: { url: string }[] }
    expect(opener.allow).toContainEqual({ url: OLLAMA_DOWNLOAD })
    expect(opener.allow.filter((a) => a.url.includes('ollama'))).toEqual([{ url: OLLAMA_DOWNLOAD }])
  })
})
