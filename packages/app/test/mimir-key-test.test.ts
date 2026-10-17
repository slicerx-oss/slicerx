// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > mimir > Use your own API key in the browser build: Test and connect calls the provider from the page with
// the typed key and shows its answer; a refusal says so and keeps the key out of the words. (Moved from the mimir-key-test
// Playwright spec; the call itself and its wording are also in pilot-connect.test.ts.)
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import { HostContext } from '../src/host'
import { ConnectPanel } from '../src/pilot-connect/connect-panel'
import { get, set } from '../src/state/store'

const KEY = 'sk-ant-test-invalid'
const host = { kind: 'web', capabilities: { secureStorage: false } } as unknown as Host
const realFetch = globalThis.fetch
let sent: { url: string; key: string | null }[] = []

beforeEach(() => {
  sent = []
  localStorage.clear()
  set({ pilot: { mode: 'off' } })
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

function provider(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

async function testKey(): Promise<void> {
  render(createElement(HostContext.Provider, { value: host }, createElement(ConnectPanel, { only: ['openai', 'anthropic'], withLocal: false })))
  await act(async () => fireEvent.click(screen.getByTestId('pc-provider-anthropic')))
  fireEvent.change(screen.getByTestId('pc-key'), { target: { value: KEY } })
  await act(async () => fireEvent.click(screen.getByTestId('pc-test')))
}

describe('Test and connect with a key typed in the browser build', () => {
  it('calls the provider with the typed key and shows its refusal, connecting nothing', async () => {
    provider(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    await testKey()
    const result = await waitFor(() => screen.getByTestId('pc-result'))
    expect(result.textContent?.trim()).toBe('The key was refused: invalid x-api-key')
    expect(result.getAttribute('data-state')).toBe('failed')
    expect(sent).toEqual([{ url: 'https://api.anthropic.com/v1/models', key: KEY }])
    expect(get().pilot).toEqual({ mode: 'off' })
  })

  it('connects and keeps the key out of the page storage in plain text when the provider accepts it', async () => {
    provider(200, { data: [{ id: 'claude-haiku-5-5' }] })
    await testKey()
    const result = await waitFor(() => screen.getByTestId('pc-result'))
    expect(result.getAttribute('data-state')).not.toBe('failed')
    expect(get().pilot).toMatchObject({ mode: 'on', provider: 'anthropic' })
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY)
  })
})
