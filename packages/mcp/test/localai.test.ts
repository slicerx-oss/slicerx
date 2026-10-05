// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import type { Hardware, LocalNet } from '@slicerx/pilot/local-ai'
import { describe, expect, it } from 'vitest'
import { localAiFromEnv, parseWindowsAdapters, type LocalAiOptions } from '../src/localai'
import { connect, data, text } from './helpers'

const enc = new TextEncoder()
const sse = (...events: unknown[]): string => [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'].join('')
const RTX_4070: Hardware = { gpu: { name: 'NVIDIA GeForce RTX 4070', vramMb: 12282, unified: false }, ramMb: 32768, cores: 16, source: 'desktop' }

/** Ollama on 127.0.0.1 with `tags` installed; a pull adds the model. Records every URL. */
function ollama(tags: string[], opts: { toolOk?: boolean } = {}): LocalNet & { urls: string[] } {
  const urls: string[] = []
  let chats = 0
  return {
    urls,
    async get(url) {
      urls.push(url)
      return url.endsWith('/api/tags') ? JSON.stringify({ models: tags.map((name) => ({ name })) }) : null
    },
    post(url, body) {
      urls.push(url)
      if (url.endsWith('/api/pull')) {
        const tag = (JSON.parse(body) as { model: string }).model
        return (async function* () {
          yield enc.encode('{"status":"pulling a","digest":"a","total":1000,"completed":500}\n')
          yield enc.encode('{"status":"pulling a","digest":"a","total":1000,"completed":1000}\n{"status":"success"}\n')
          tags.push(tag)
        })()
      }
      if (url.endsWith('/api/create')) {
        const tag = (JSON.parse(body) as { model: string }).model
        return (async function* () {
          yield enc.encode('{"status":"writing manifest"}\n{"status":"success"}\n')
          if (!tags.includes(tag)) tags.push(tag)
        })()
      }
      chats++
      const first = chats % 2 === 1
      const args = opts.toolOk === false ? '{"material":"PLA"}' : '{"material":"PETG"}'
      return (async function* () {
        yield enc.encode(
          first
            ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'kb__filament', arguments: args } }] }, finish_reason: 'tool_calls' }] })
            : sse({ choices: [{ delta: { content: 'Hotter.' }, finish_reason: 'stop' }] }),
        )
      })()
    },
  }
}

async function harness(localAi: LocalAiOptions, policy = DEFAULT_POLICY) {
  // Never the real ~/.config: each test has its own state file.
  const stateFile = join(mkdtempSync(join(tmpdir(), 'slicerx-local-ai-')), 'local-ai.json')
  const h = await connect({ policy, localAi: { hardware: async () => RTX_4070, stateFile, ...localAi } })
  return { ...h, localAi: { stateFile } }
}

describe('MCP local AI tools', () => {
  it('check reads the hardware and recommends one model with its reason, size and license', async () => {
    const net = ollama([])
    const h = await harness({ net })
    const r = await h.call('slicerx_local_ai_check')
    expect(r.isError).toBeFalsy()
    const out = data<{ output: { recommendation: Record<string, unknown>; runners: { app: string }[]; hardware: { gpu: { memory_gb: number } } } }>(r).output
    expect(out.hardware.gpu.memory_gb).toBe(12)
    expect(out.recommendation).toMatchObject({ id: 'qwen-2.5-14b', download_gb: 9, license: 'Apache 2.0', reason: 'Your RTX 4070 has 12 GB, so Qwen 2.5 14B fits well.', runs_on: 'graphics card' })
    expect(out.runners.map((x) => x.app)).toEqual(['Ollama'])
    expect(net.urls.every((u) => u.startsWith('http://127.0.0.1:11434/') || u.startsWith('http://127.0.0.1:1234/'))).toBe(true)
  })

  it('says when the machine is too weak and links Ollama when nothing runs', async () => {
    const net: LocalNet = { get: async () => null, post: () => (async function* () {})() }
    const h = await harness({ net, hardware: async () => ({ gpu: null, ramMb: 4096, cores: 4, source: 'desktop' }) })
    const out = data<{ output: Record<string, unknown> }>(await h.call('slicerx_local_ai_check')).output
    expect(out['recommendation']).toBeNull()
    expect(String(out['too_weak'])).toMatch(/cloud model or sign in with ChatGPT/)
    expect(out['get_ollama']).toBe('https://ollama.com/download')
  })

  it('setup asks the user first, even when its class is allowed, and shows size and license', async () => {
    const net = ollama([])
    const h = await harness({ net }, { classes: { ...DEFAULT_POLICY.classes, profile: 'allow' } })
    const r = await h.call('slicerx_local_ai_setup')
    const req = data<{ status: string; title: string; lines: string[]; request_id: string }>(r)
    expect(req.status).toBe('approval_required')
    expect(req.title).toBe('Download Qwen 2.5 14B (9.0 GB) with Ollama?')
    expect(req.lines[0]).toMatch(/^License: Apache 2\.0\./)
    expect(net.urls.filter((u) => u.endsWith('/api/pull'))).toEqual([])
  })

  it('once approved, pulls with progress notifications, checks, and records the model for status', async () => {
    const net = ollama([])
    const h = await harness({ net })
    const req = data<{ request_id: string }>(await h.call('slicerx_local_ai_setup'))
    const seen: { progress: number; message?: string }[] = []
    const r = (await h.client.callTool({ name: 'slicerx_approve', arguments: { request_id: req.request_id, approve: true } }, undefined, { onprogress: (p) => seen.push({ progress: p.progress, ...(p.message ? { message: p.message } : {}) }) })) as CallToolResult
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/Qwen 2\.5 14B is ready\. Tool call passed\./)
    expect(net.urls).toContain('http://127.0.0.1:11434/api/pull')
    expect(seen.map((s) => s.message)).toContain('0.0 GB of 0.0 GB')
    expect(seen.at(-1)).toMatchObject({ progress: 1, message: 'Done' })
    const state = JSON.parse(readFileSync(h.localAi.stateFile, 'utf8')) as { model: string; baseUrl: string }
    expect(state).toMatchObject({ model: 'qwen2.5:14b-ctx16k', baseUrl: 'http://127.0.0.1:11434/v1' })
    const status = data<{ output: { in_use: { model: string; available: boolean }; installed: { model: string; known?: { license: string } }[] } }>(await h.call('slicerx_local_ai_status')).output
    expect(status.in_use).toMatchObject({ model: 'qwen2.5:14b-ctx16k', available: true })
    expect(status.installed).toEqual(['qwen2.5:14b', 'qwen2.5:14b-ctx16k'].map((model) => expect.objectContaining({ model, known: expect.objectContaining({ license: 'Apache 2.0' }) })))
  })

  it('reports a failed tool check plainly and records nothing', async () => {
    const net = ollama(['qwen2.5:14b'], { toolOk: false })
    const h = await harness({ net })
    const req = data<{ request_id: string }>(await h.call('slicerx_local_ai_setup'))
    const r = await h.call('slicerx_approve', { request_id: req.request_id, approve: true })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/did not pass the check: The model did not make the tool call correctly/)
    expect(net.urls).not.toContain('http://127.0.0.1:11434/api/pull')
    expect(existsSync(h.localAi.stateFile)).toBe(false)
  })

  it('an edition can turn the tools off or limit the models', async () => {
    const off = await harness({ off: true, net: ollama([]) })
    const names = (await off.client.listTools()).tools.map((t) => t.name)
    expect(names.filter((n) => n.startsWith('slicerx_local_ai'))).toEqual([])
    const limited = await harness({ net: ollama([]), allowed: ['qwen-2.5-7b'] })
    const out = data<{ output: { recommendation: { id: string } } }>(await limited.call('slicerx_local_ai_check')).output
    expect(out.recommendation.id).toBe('qwen-2.5-7b')
  })

  it('reads Windows adapter memory from the registry, past the 4 GB WMI cap', () => {
    const json = JSON.stringify([
      { DriverDesc: 'Intel(R) UHD Graphics 770', 'HardwareInformation.qwMemorySize': 134217728 },
      { DriverDesc: 'NVIDIA GeForce RTX 5080', 'HardwareInformation.qwMemorySize': 17095983104 },
    ])
    expect(parseWindowsAdapters(json)).toEqual({ name: 'NVIDIA GeForce RTX 5080', vramMb: 16304, unified: false })
    expect(parseWindowsAdapters('not json')).toBeNull()
  })

  it('reads the edition switches from SLICERX_CONFIG', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'slicerx-edition-')), 'edition.json')
    writeFileSync(file, JSON.stringify({ features: { pilot: true, localAi: true }, ai: { allowedLocalModels: ['qwen-2.5-7b'] } }))
    expect(localAiFromEnv({ SLICERX_CONFIG: file })).toEqual({ allowed: ['qwen-2.5-7b'] })
    writeFileSync(file, JSON.stringify({ features: { pilot: true, localAi: false }, ai: {} }))
    expect(localAiFromEnv({ SLICERX_CONFIG: file })).toEqual({ off: true })
    expect(localAiFromEnv({})).toEqual({})
  })
})
