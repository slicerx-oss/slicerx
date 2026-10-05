// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalAiCard } from '../src/pilot-connect/local-ai-card'
import { registerLocalAi, type LocalNet } from '../src/pilot-connect/local-ai'
import { resetLocalAi } from '../src/pilot-connect/local-ai-job'
import { get, set } from '../src/state/store'

const enc = new TextEncoder()
const sse = (...events: unknown[]): string => [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'].join('')

function setup(tags: string[], pull: (signal?: AbortSignal) => AsyncIterable<Uint8Array>) {
  const posts: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  const net: LocalNet = {
    get: async (url) => (url.endsWith('/api/tags') ? JSON.stringify({ models: tags.map((name) => ({ name })) }) : null),
    post(url, _body, signal) {
      posts.push(url)
      signals.push(signal)
      if (url.endsWith('/api/pull')) return pull(signal)
      if (url.endsWith('/api/create'))
        return (async function* () {
          yield enc.encode('{"status":"success"}\n')
        })()
      const tool = posts.filter((p) => p.endsWith('/chat/completions')).length === 1
      return (async function* () {
        yield enc.encode(
          tool
            ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'kb__filament', arguments: '{"material":"PETG"}' } }] }, finish_reason: 'tool_calls' }] })
            : sse({ choices: [{ delta: { content: 'Hotter.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 30 } }),
        )
      })()
    },
  }
  registerLocalAi(() => ({ hardware: async () => ({ gpu: { name: 'NVIDIA GeForce RTX 4070', vramMb: 12282, unified: false }, ramMb: 32768, cores: 16, source: 'desktop' }), net }))
  return { posts, signals }
}

afterEach(() => {
  cleanup()
  registerLocalAi(null)
  resetLocalAi()
  set({ pilot: null })
})

describe('Set up local AI card', () => {
  it('shows the size and license and asks before downloading, then cancels the pull', async () => {
    let release: () => void = () => undefined
    const { posts, signals } = setup([], (signal) =>
      (async function* () {
        yield enc.encode('{"status":"pulling a","digest":"a","total":9000000000,"completed":3000000000}\n')
        await new Promise<void>((r) => {
          release = r
          signal?.addEventListener('abort', () => r())
        })
      })(),
    )
    render(createElement(LocalAiCard))
    await screen.findByText('Your RTX 4070 has 12 GB, so Qwen 2.5 14B fits well.')
    expect(screen.getByText(/Apache 2\.0\. Free to use, change and share/)).toBeTruthy()
    await screen.findByText(/Ollama is running/)
    fireEvent.click(screen.getByRole('button', { name: /Download 9\.0 GB/ }))
    expect(screen.getByText(/Download Qwen 2\.5 14B \(9\.0 GB\) with Ollama\?/)).toBeTruthy()
    expect(posts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: /^Download$/ }))
    await screen.findByText('3.0 GB of 9.0 GB, 33%')
    expect(posts).toEqual(['http://127.0.0.1:11434/api/pull'])
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(signals[0]?.aborted).toBe(true)
    await act(async () => release())
    await screen.findByRole('button', { name: /Download 9\.0 GB/ })
    expect(get().pilot?.provider).toBeUndefined()
  })

  it('tests a model Ollama already has and switches mimir to it', async () => {
    const { posts } = setup(['qwen2.5:14b'], () => {
      throw new Error('no pull expected')
    })
    render(createElement(LocalAiCard))
    fireEvent.click(await screen.findByRole('button', { name: /Test and use/ }))
    await waitFor(() => expect(get().pilot).toEqual({ mode: 'on', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b-ctx16k' }))
    expect(posts).toEqual(['http://127.0.0.1:11434/api/create', 'http://127.0.0.1:11434/v1/chat/completions', 'http://127.0.0.1:11434/v1/chat/completions'])
    await screen.findByText(/now uses qwen2\.5:14b on this computer\. Tool call passed\./)
  })
})
