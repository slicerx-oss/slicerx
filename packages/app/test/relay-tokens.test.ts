// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app entries' two relay token calls wait in relay-tokens.ts until remote.ts loads, so the phone code stays out of
// the startup code. The calls that came first are applied when it arrives, and later calls go straight in.
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())

describe('relay token calls', () => {
  it('keep the latest of each call until remote.ts loads, then apply them', async () => {
    const tokens = await import('../src/features/phone/relay-tokens')
    const first = { url: 'https://one.example', anonKey: 'k1' }
    const second = { url: 'https://two.example', anonKey: 'k2' }
    tokens.configureRelayTokens(first)
    tokens.pushAccountToken('session-1')
    tokens.configureRelayTokens(second)
    tokens.pushAccountToken('session-2')
    const calls: unknown[][] = []
    tokens.relayTokensLoaded({ configureRelayTokens: (...a) => void calls.push(['configure', ...a]), pushAccountToken: (...a) => void calls.push(['push', ...a]) })
    expect(calls).toEqual([
      ['configure', second],
      ['push', 'session-2'],
    ])
  })

  it('go straight to remote.ts once it is there', async () => {
    const tokens = await import('../src/features/phone/relay-tokens')
    const calls: unknown[][] = []
    tokens.relayTokensLoaded({ configureRelayTokens: (...a) => void calls.push(['configure', ...a]), pushAccountToken: (...a) => void calls.push(['push', ...a]) })
    expect(calls).toEqual([])
    tokens.pushAccountToken(null)
    tokens.pushAccountToken('session')
    expect(calls).toEqual([['push', null], ['push', 'session']])
  })

  it('reach the real module when it loads: a sign-in before it, a token minted after it', async () => {
    const tokens = await import('../src/features/phone/relay-tokens')
    tokens.pushAccountToken('session-0')
    const remote = await import('../src/features/phone/remote')
    const minted: string[] = []
    remote.setRelayTokenMint(async (session) => (minted.push(session), { token: 'relay', expiresAt: Date.now() + 600_000 }))
    tokens.pushAccountToken('session-1')
    await vi.waitFor(() => expect(minted).toEqual(['session-1']))
    remote.setRelayTokenMint(null)
    tokens.pushAccountToken(null)
  })

  it('apply a call made before the module loaded, when it does', async () => {
    const tokens = await import('../src/features/phone/relay-tokens')
    const seen: string[] = []
    tokens.configureRelayTokens({ url: 'https://relay.example/', anonKey: 'anon' })
    tokens.pushAccountToken('early')
    const fetched = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)['authorization']))
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetched)
    try {
      await import('../src/features/phone/remote')
      await vi.waitFor(() => expect(seen).toEqual(['Bearer early']))
      expect(fetched.mock.calls[0]?.[0]).toBe('https://relay.example/functions/v1/relay-token')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
