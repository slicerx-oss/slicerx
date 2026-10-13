// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { EditionContext, NEUTRAL } from '../src/edition'
import { HostContext } from '../src/host'
import { MimirStep, mimirChoices, mimirOnFinish, type MimirChoice } from '../src/first-run/mimir-step'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { MimirSetup } from '../src/pilot-connect/mimir-setup'
import { BASE_STEPS, contractStep, initialFlow, normalizeStep, progress, reduceFlow, stepLabel, type FlowEvent, type FlowState } from '../src/first-run/model'
import { registerLocalAi, type LocalNet } from '../src/pilot-connect/local-ai'
import { localAiJob, resetLocalAi } from '../src/pilot-connect/local-ai-job'
import { get, set } from '../src/state/store'

const HOST = { kind: 'web', capabilities: { secureStorage: false } } as unknown as Host
const inHost = (el: ReturnType<typeof createElement>) => createElement(HostContext.Provider, { value: HOST }, el)
const WITH = [...BASE_STEPS, 'mimir'] as const
const run = (s: FlowState, ...events: FlowEvent[]) => events.reduce(reduceFlow, s)
const enc = new TextEncoder()
const sse = (...events: unknown[]): string => [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'].join('')

afterEach(() => {
  cleanup()
  registerMimirCloud(null)
  registerLocalAi(null)
  resetLocalAi()
  set({ pilot: null, toast: null })
})

describe('first run with the mimir step', () => {
  it('adds a third screen that can be skipped, and stores it as the slicer screen', () => {
    const s = initialFlow('printer', { id: 'slicerx' }, null, WITH)
    const atLook = run(s, { type: 'no-printer' })
    expect(atLook.step).toBe('look')
    const atMimir = run(atLook, { type: 'next' })
    expect(atMimir.step).toBe('mimir')
    expect(stepLabel('mimir', WITH).text).toBe('Step 4 of 4, mimir')
    expect(progress('look', WITH)).toBeCloseTo(3 / 4)
    expect(run(atMimir, { type: 'skip' }).closed).toBe('finished')
    expect(run(atMimir, { type: 'back' }).step).toBe('look')
    expect(contractStep('mimir')).toBe('look')
  })

  it('keeps two screens when mimir is not offered', () => {
    const s = run(initialFlow('printer', { id: 'slicerx' }), { type: 'no-printer' }, { type: 'next' })
    expect(s.closed).toBe('finished')
    expect(normalizeStep('mimir')).toBe('theme')
    expect(normalizeStep('mimir', WITH)).toBe('mimir')
    expect(initialFlow('mimir', { id: 'slicerx' }).step).toBe('theme')
  })

  it('offers sign-in only where the shell has it, and local only when the edition keeps it', () => {
    const ids = (o: ReturnType<typeof mimirChoices>) => o.map((c) => c.id)
    expect(ids(mimirChoices({ signIn: true, localAi: true }))).toEqual(['chatgpt', 'key', 'local', 'skip'])
    expect(ids(mimirChoices({ signIn: false, localAi: false }))).toEqual(['key', 'skip'])
    expect(ids(mimirChoices({ cloud: 'ready', signIn: true, localAi: true }))).toEqual(['cloud', 'chatgpt', 'key', 'local', 'skip'])
    expect(ids(mimirChoices({ cloud: 'sign-in', signIn: false, localAi: false, skip: false }))).toEqual(['cloud', 'key'])
  })

  it('puts mimir cloud first where the edition has it and the shell carries it, and connects it on finish', () => {
    const cloudEdition = { ...NEUTRAL, ai: { ...NEUTRAL.ai, keySource: 'cloud' as const }, backend: { ...NEUTRAL.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } }
    const step = () => inHost(createElement(EditionContext.Provider, { value: cloudEdition }, createElement(MimirStep, { choice: 'cloud', onChoose: () => undefined })))
    const names = () => screen.getAllByRole('radio').map((r) => r.querySelector('.ms-card-name')?.textContent)
    // no shell host yet (the browser build today): no cloud choice
    const view = render(step())
    expect(names()).toEqual(['Use your own API key', 'Skip for now'])
    const cloudHost = { quota: async () => { throw new Error('unused') }, forget: async () => 0, register: async () => undefined }
    // the browser's host while signed out: the cloud is offered as a sign-in
    act(() => registerMimirCloud({ ...cloudHost, needsSignIn: true }))
    expect(names()).toEqual(['Sign in to use mimir free', 'Use your own API key', 'Skip for now'])
    act(() => registerMimirCloud({ ...cloudHost, needsSignIn: false }))
    expect(names()).toEqual(['Use mimir free', 'Use your own API key', 'Skip for now'])
    expect(screen.getByTestId('ms-cloud-note').textContent).toContain('No key to paste')
    view.unmount()
    expect(mimirOnFinish('cloud')).toEqual({ mode: 'on', provider: 'mimir-cloud' })
    for (const c of ['key', 'chatgpt', 'local', 'skip'] as const) expect(mimirOnFinish(c)).toBeNull()
  })

  it('in Settings, the cloud card offers Use mimir free only until it is the connection', () => {
    const cloudEdition = { ...NEUTRAL, ai: { ...NEUTRAL.ai, keySource: 'cloud' as const }, backend: { ...NEUTRAL.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } }
    registerMimirCloud({ quota: async () => { throw new Error('unused') }, forget: async () => 0, register: async () => undefined })
    set({ pilot: { mode: 'on', provider: 'anthropic', model: 'auto' } })
    const view = render(inHost(createElement(EditionContext.Provider, { value: cloudEdition }, createElement(MimirSetup, { place: 'settings', idPrefix: 't' }))))
    fireEvent.click(screen.getByTestId('ms-choice-cloud'))
    expect(screen.getByRole('button', { name: /Use mimir free/ })).toBeTruthy()
    act(() => set({ pilot: { mode: 'on', provider: 'mimir-cloud' } }))
    expect(screen.queryByRole('button', { name: /Use mimir free/ })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Connected to mimir cloud')
    view.unmount()
  })

  it('offers a local model only where the shell can run one', () => {
    render(inHost(createElement(MimirStep, { choice: 'skip', onChoose: () => undefined })))
    expect(screen.queryByRole('radio', { name: /Run a local model/ })).toBeNull()
    act(() => registerLocalAi(() => ({ hardware: async () => ({ gpu: null, ramMb: 16384, cores: 8, source: 'desktop' }), net: { get: async () => null, post: () => (async function* () {})() } })))
    expect(screen.getByRole('radio', { name: /Run a local model/ })).toBeTruthy()
  })

  it('a local model keeps downloading after setup closes, then mimir switches with a toast', async () => {
    let finish: () => void = () => undefined
    const net: LocalNet = {
      get: async (url) => (url.endsWith('/api/tags') ? JSON.stringify({ models: [] }) : null),
      post(url) {
        if (url.endsWith('/api/pull'))
          return (async function* () {
            yield enc.encode('{"status":"pulling a","digest":"a","total":100,"completed":40}\n')
            await new Promise<void>((r) => (finish = r))
            yield enc.encode('{"status":"pulling a","digest":"a","total":100,"completed":100}\n{"status":"success"}\n')
          })()
        if (url.endsWith('/api/create'))
          return (async function* () {
            yield enc.encode('{"status":"success"}\n')
          })()
        const tool = (net as { n?: number }).n === undefined
        ;(net as { n?: number }).n = 1
        return (async function* () {
          yield enc.encode(
            tool
              ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'kb__filament', arguments: '{"material":"PETG"}' } }] }, finish_reason: 'tool_calls' }] })
              : sse({ choices: [{ delta: { content: 'Hotter.' }, finish_reason: 'stop' }] }),
          )
        })()
      },
    }
    registerLocalAi(() => ({ hardware: async () => ({ gpu: { name: 'NVIDIA GeForce RTX 4060', vramMb: 8188, unified: false }, ramMb: 32768, cores: 12, source: 'desktop' }), net }))
    let choice: MimirChoice = 'local'
    const view = render(inHost(createElement(MimirStep, { choice, onChoose: (c: MimirChoice) => (choice = c) })))
    expect(screen.getByRole('radio', { name: /Run a local model/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(await screen.findByRole('button', { name: /Download 4\.7 GB/ }))
    expect(screen.getByText(/Download Qwen 2\.5 7B \(4\.7 GB\) with Ollama\? .* License: Apache 2\.0\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Download$/ }))
    await screen.findByText(/You can go on; mimir switches when it is ready\./)
    // Setup closes; the download goes on.
    view.unmount()
    expect(localAiJob().at).toBe('pulling')
    await act(async () => finish())
    await waitFor(() => expect(localAiJob().at).toBe('done'))
    expect(get().pilot).toEqual({ mode: 'on', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b-ctx16k' })
    expect(get().toast).toMatchObject({ text: 'mimir now runs Qwen 2.5 7B on this computer.', tone: 'ok' })
  })

  it('an edition without local AI shows neither the choice nor the helper', () => {
    const edition = { ...NEUTRAL, features: { ...NEUTRAL.features, localAi: false } }
    render(inHost(createElement(EditionContext.Provider, { value: edition }, createElement(MimirStep, { choice: 'local', onChoose: () => undefined }))))
    expect(screen.queryByRole('radio', { name: /Run a local model/ })).toBeNull()
    expect(screen.queryByText(/Run a model on this computer/)).toBeNull()
  })
})
