// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud in the browser: signed-in members only. The host sends the session token only to the proxy, as
// authorization, sends nothing while signed out, and the app reads it as offered but not ready until sign-in.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditionConfig } from '@slicerx/edition-config'
import { createBrowserMimirCloud } from '../src/pilot-connect/browser-cloud'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { cloudOffered, cloudReady } from '../src/pilot-connect/cloud-edition'
import { browserTransport } from '../src/pilot-connect/transport'

const BASE = 'https://proj.example.co/functions/v1/mimir'
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln'

type Seen = { url: string; method: string; headers: Record<string, string>; body?: string }

/** A proxy that answers any session token, and refuses calls without one as the real one does. */
function proxy() {
  const seen: Seen[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url, method: init?.method ?? 'GET', headers, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    if (!headers['authorization']) return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Sign in to use mimir.', reason: 'sign_in' } }, { status: 401 })
    if (url.endsWith('/quota')) return Response.json({ edition: 'slicerx-web', day: '2026-10-13', install_used: 1000, install_cap: 250000, ip_used: 2000, ip_cap: 1000000, edition_open: true })
    if (url.endsWith('/forget')) return Response.json({ deleted: 4 })
    if (url.endsWith('/v1/messages')) return new Response('event: message_stop\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    return new Response(null, { status: 404 })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen }
}

const edition = { ai: { keySource: 'cloud' }, backend: { supabase: { url: 'https://proj.example.co', anonKey: 'anon' } } } as unknown as EditionConfig

afterEach(() => registerMimirCloud(null))

describe('mimir cloud in the browser', () => {
  it('sends the session token only to the proxy, and reads the quota with it', async () => {
    const p = proxy()
    const host = createBrowserMimirCloud({ base: `${BASE}/`, session: () => JWT, fetch: p.fetch })
    expect(host.needsSignIn).toBe(false)
    expect(await host.quota()).toEqual({ edition: 'slicerx-web', day: '2026-10-13', installUsed: 1000, installCap: 250000, ipUsed: 2000, ipCap: 1000000, editionOpen: true })
    expect(await host.forget()).toBe(4)
    await host.register()
    await expect(host.send('https://api.anthropic.com/v1/messages', { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow(/only to its own proxy/)
    const res = await host.send(`${BASE}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sx-share': '1' }, body: '{}' })
    expect(res.ok).toBe(true)
    // nothing registers, nothing goes elsewhere, and no install token is involved
    expect(p.seen.map((s) => s.url.slice(BASE.length))).toEqual(['/quota', '/forget', '/v1/messages'])
    expect(p.seen.every((s) => s.headers['authorization'] === `Bearer ${JWT}` && !('x-sx-install' in s.headers))).toBe(true)
    expect(p.seen[2]!.headers).toMatchObject({ 'x-sx-share': '1' })
  })

  it('reads the token at each call, so a refreshed session goes with the next one', async () => {
    const p = proxy()
    let t = JWT
    const host = createBrowserMimirCloud({ base: BASE, session: () => t, fetch: p.fetch })
    await host.quota()
    t = `${JWT}x`
    await host.quota()
    expect(p.seen.map((s) => s.headers['authorization'])).toEqual([`Bearer ${JWT}`, `Bearer ${JWT}x`])
  })

  it('signed out, it is offered but not ready, sends nothing and says to sign in', async () => {
    const p = proxy()
    const host = createBrowserMimirCloud({ base: BASE, session: () => null, fetch: p.fetch })
    expect(host.needsSignIn).toBe(true)
    expect(cloudOffered(edition, host)).toBe(true)
    expect(cloudReady(edition, host)).toBe(false)
    await expect(host.quota()).rejects.toMatchObject({ status: 401, reason: 'sign_in' })
    await expect(host.send(`${BASE}/v1/messages`, { method: 'POST', headers: {}, body: '{}' })).rejects.toThrow(/Sign in/)
    expect(p.seen).toHaveLength(0)
    // a session that ran out shows the proxy's own refusal
    const late = createBrowserMimirCloud({ base: BASE, session: () => JWT, fetch: vi.fn(async () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Sign in to use mimir.', reason: 'sign_in' } }, { status: 401 })) as unknown as typeof fetch })
    await expect(late.quota()).rejects.toMatchObject({ status: 401, reason: 'sign_in', message: 'Sign in to use mimir.' })
    // a cap keeps its code, so the chat's error line can show what fits
    const capped = createBrowserMimirCloud({ base: BASE, session: () => JWT, fetch: vi.fn(async () => Response.json({ type: 'error', error: { type: 'rate_limit_error', code: 'day_used', message: "You've used today's free mimir." } }, { status: 429 })) as unknown as typeof fetch })
    await expect(capped.send(`${BASE}/v1/messages`, { method: 'POST', headers: {}, body: '{}' })).rejects.toMatchObject({ status: 429, code: 'day_used' })
  })

  it("streams mimir's model calls through the browser transport only while signed in", async () => {
    const p = proxy()
    const config = () => ({ provider: 'mimir-cloud' as const })
    const transport = browserTransport({ get: async () => null, has: () => false } as never, config)
    expect(await transport.available('mimir-cloud')).toBe(false)
    registerMimirCloud(createBrowserMimirCloud({ base: BASE, session: () => null, fetch: p.fetch }))
    expect(await transport.available('mimir-cloud')).toBe(false)
    registerMimirCloud(createBrowserMimirCloud({ base: BASE, session: () => JWT, fetch: p.fetch }))
    expect(await transport.available('mimir-cloud')).toBe(true)
    expect(cloudReady(edition)).toBe(true)
    let text = ''
    for await (const chunk of transport.stream({ provider: 'mimir-cloud', url: `${BASE}/v1/messages`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })) text += new TextDecoder().decode(chunk)
    expect(text).toContain('message_stop')
  })
})
