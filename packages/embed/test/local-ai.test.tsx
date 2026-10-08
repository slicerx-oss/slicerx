// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createTheme, LocalAiSetup, type Hardware, type LocalAiReady, type LocalNet } from '../src/index'
import { EMBED_CSS } from '../src/styles'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const enc = new TextEncoder()
const sse = (...events: unknown[]): string => [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'].join('')
const RTX_4060: Hardware = { gpu: { name: 'NVIDIA GeForce RTX 4060', vramMb: 8188, unified: false }, ramMb: 32768, cores: 12, source: 'desktop' }

function ollama(): LocalNet & { urls: string[] } {
  const urls: string[] = []
  let chats = 0
  return {
    urls,
    async get(url) {
      urls.push(url)
      return url.endsWith('/api/tags') ? JSON.stringify({ models: [] }) : null
    },
    post(url) {
      urls.push(url)
      if (url.endsWith('/api/pull'))
        return (async function* () {
          yield enc.encode('{"status":"pulling a","digest":"a","total":100,"completed":100}\n{"status":"success"}\n')
        })()
      if (url.endsWith('/api/create'))
        return (async function* () {
          yield enc.encode('{"status":"success"}\n')
        })()
      chats++
      const first = chats === 1
      return (async function* () {
        yield enc.encode(
          first
            ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'kb__filament', arguments: '{"material":"PETG"}' } }] }, finish_reason: 'tool_calls' }] })
            : sse({ choices: [{ delta: { content: 'Hotter.' }, finish_reason: 'stop' }] }),
        )
      })()
    },
  }
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
// Flushes until the condition holds. The model check imports its tool on first use, which on a loaded machine takes far
// more than a few ticks, so this waits by the clock, up to 20 s, not by a count of ticks.
async function until(ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await flush()
}
let host: HTMLDivElement | null = null
afterEach(() => {
  host?.remove()
  host = null
})

function button(name: RegExp): HTMLButtonElement {
  const b = [...(host?.querySelectorAll('button') ?? [])].find((x) => name.test(x.textContent ?? ''))
  if (!b) throw new Error(`no button ${name}: ${host?.textContent}`)
  return b
}

describe('LocalAiSetup', () => {
  it('recommends, confirms size and license, downloads, checks and hands the model to the host', async () => {
    const net = ollama()
    const ready: LocalAiReady[] = []
    host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => root.render(<LocalAiSetup net={net} hardware={async () => RTX_4060} onReady={(r) => ready.push(r)} />))
    await until(() => /License: Apache 2\.0\..*is running/s.test(host?.textContent ?? ''))
    expect(host.textContent).toContain('Your RTX 4060 has 8 GB, so Qwen 2.5 7B fits well.')
    expect(host.textContent).toContain('License: Apache 2.0.')
    await act(async () => button(/Download 4\.7 GB/).click())
    expect(host.textContent).toMatch(/Download Qwen 2\.5 7B \(4\.7 GB\) with Ollama\?/)
    expect(net.urls.some((u) => u.endsWith('/api/pull'))).toBe(false)
    await act(async () => button(/^Download$/).click())
    await until(() => ready.length > 0)
    expect(ready).toEqual([{ model: 'qwen2.5:7b-ctx16k', name: 'Qwen 2.5 7B', baseUrl: 'http://127.0.0.1:11434/v1', tokensPerSecond: expect.anything() }])
    expect(host.textContent).toContain('Qwen 2.5 7B is ready.')
    expect(net.urls.every((u) => u.startsWith('http://127.0.0.1:11434/') || u.startsWith('http://127.0.0.1:1234/'))).toBe(true)
    await act(async () => root.unmount())
  })

  it('offers only the allowed models and links Ollama when nothing runs', async () => {
    const opened: string[] = []
    const none: LocalNet = { get: async () => null, post: () => (async function* () {})() }
    host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => root.render(<LocalAiSetup net={none} hardware={async () => RTX_4060} allowedModels={['llama-3.2-3b']} onOpenUrl={(u) => opened.push(u)} />))
    await until(() => host?.textContent?.includes('Get Ollama') ?? false)
    expect(host.textContent).toContain('Llama 3.2 3B')
    expect(host.textContent).toContain('Meta Llama 3.2 Community License')
    await act(async () => button(/Get Ollama/).click())
    expect(opened).toEqual(['https://ollama.com/download'])
    await act(async () => root.unmount())
  })

  it('takes the host theme, scoped to the piece', () => {
    const theme = createTheme({ name: 'harbor', colors: { purple: '#0a7ea4' } })
    const html = renderToString(<LocalAiSetup theme={theme} net={{ get: async () => null, post: () => (async function* () {})() }} />)
    expect(html).toContain('sx-theme-scope')
    expect(html).toContain('sxe-localai')
    expect(EMBED_CSS).toContain('.sxe-localai')
  })
})
