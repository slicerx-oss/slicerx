// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { relayAudience, relayTokenSource } from '../src/relay-token'
import { ApprovalView } from '../src/rpc'

const jwt = (claims: object) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.c2ln`

describe('relay tokens (M4)', () => {
  it('trades the session for a relay token, keeps it until near expiry, and never hands on anything else', async () => {
    let now = 1_000_000
    const calls: { url: string; auth: string }[] = []
    let reply: object = { token: jwt({ aud: 'sx-relay', sub: 'u' }), expiresAt: now + 600_000 }
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)['authorization'] ?? '' })
      return new Response(JSON.stringify(reply), { status: 200 })
    }) as typeof fetch
    let session: string | null = 'session-1'
    const get = relayTokenSource({ backend: { url: 'https://p.supabase.co/', anonKey: 'anon' }, session: async () => session, fetch: fake, now: () => now })
    const t = await get()
    expect(relayAudience(t ?? '')).toBe(true)
    expect(calls).toEqual([{ url: 'https://p.supabase.co/functions/v1/relay-token', auth: 'Bearer session-1' }])
    expect(await get()).toBe(t)
    expect(calls).toHaveLength(1)
    now += 560_000
    await get()
    expect(calls).toHaveLength(2)
    // A reply that is the session (audience `authenticated`) is not passed on.
    reply = { token: jwt({ aud: 'authenticated', sub: 'u' }), expiresAt: now + 600_000 }
    session = 'session-2'
    expect(await get()).toBeNull()
    session = null
    expect(await get()).toBeNull()
  })

  it('carries the work summary next to the request, and refuses a summary of an unknown kind', () => {
    const request = { id: 'r', sessionId: 's', tool: 't', permission: 'start', title: '', lines: [], paramsHash: 'a'.repeat(64), actions: [], expiresAt: '' }
    const ok = ApprovalView.safeParse({ request, source: 'host', work: { kind: 'gcode', printerId: 'bay-4', line: 'M140 S60' } })
    expect(ok.success && ok.data.work).toEqual({ kind: 'gcode', printerId: 'bay-4', line: 'M140 S60' })
    expect(ApprovalView.safeParse({ request, source: 'host', work: { kind: 'teleport', printerId: 'bay-4' } }).success).toBe(false)
  })
})
