// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Access token handling against a fake auth server: no network, no stack.
import { describe, expect, it } from 'vitest'
import { createAuth } from './index'
import { memoryAuthStorage, webAuthStorage, type AuthStorage } from './callbacks'
import { AUTH_STORAGE_KEY } from './supabase'

const URL_ = 'http://127.0.0.1:54321'
const ANON = 'test-anon-key-000000000000'
const user = { id: '1832dedf-8c8e-51cb-b929-c0baad95dfae', aud: 'authenticated', role: 'authenticated', email: 'rv@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-06-01T00:00:00Z' }

function session(token: string, expiresInS: number) {
  const now = Math.floor(Date.now() / 1000)
  return { access_token: token, refresh_token: `refresh-${token}`, token_type: 'bearer', expires_in: expiresInS, expires_at: now + expiresInS, user }
}

/** A fake GoTrue that answers refresh and logout, and records the calls. */
function fakeAuthServer() {
  const calls: string[] = []
  let n = 0
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      n += 1
      return new Response(JSON.stringify(session(`fresh-${n}`, 3600)), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  return { fetchFn, calls }
}

function fakeLocalStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m }
}

const adapters: [string, () => AuthStorage][] = [
  ['native (keychain-style) storage', () => memoryAuthStorage()],
  ['web storage', () => webAuthStorage(fakeLocalStorage())],
]

const tick = () => new Promise((r) => setTimeout(r, 20))

describe.each(adapters)('access tokens with %s', (_name, makeStorage) => {
  const client = async (stored: ReturnType<typeof session> | null) => {
    const storage = makeStorage()
    if (stored) await storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(stored))
    const server = fakeAuthServer()
    const auth = createAuth({ url: URL_, anonKey: ANON, fetch: server.fetchFn, auth: { redirectUrl: () => `${URL_}/cb`, storage } })
    return { auth, storage, server }
  }

  it('returns null when signed out', async () => {
    const { auth } = await client(null)
    expect(await auth.getAccessToken()).toBeNull()
  })

  it('returns a valid stored token without a refresh', async () => {
    const { auth, server } = await client(session('valid', 3600))
    expect(await auth.getAccessToken()).toBe('valid')
    expect(await auth.accessToken()).toBe('valid')
    expect(server.calls.filter((c) => c.includes('grant_type=refresh_token'))).toEqual([])
  })

  it('refreshes a token that is about to expire and stores the new one', async () => {
    const { auth, storage, server } = await client(session('stale', 20))
    const token = await auth.getAccessToken()
    expect(token).toMatch(/^fresh-\d+$/)
    expect(server.calls.some((c) => c.includes('grant_type=refresh_token'))).toBe(true)
    expect(JSON.parse((await storage.getItem(AUTH_STORAGE_KEY)) ?? '{}').access_token).toBe(token)
  })

  it('tells listeners about the token and about sign-out', async () => {
    const { auth } = await client(session('valid', 3600))
    const seen: (string | null)[] = []
    const off = auth.onTokenChange((t) => seen.push(t))
    await tick()
    await auth.signOut()
    await tick()
    off()
    expect(seen).toEqual(['valid', null])
    expect(await auth.getAccessToken()).toBeNull()
  })
})

describe('offline access tokens', () => {
  it('has none', async () => {
    const auth = createAuth({ offline: true })
    expect(await auth.getAccessToken()).toBeNull()
    const off = auth.onTokenChange(() => {})
    off()
  })
})
