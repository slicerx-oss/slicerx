// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finishing an emailed sign-in link against a fake auth server: the verifier sent, a link handed over twice,
// a link that names its flow, and what a failure tells the person.
import { describe, expect, it } from 'vitest'
import { createAuth } from './index'
import { memoryAuthStorage } from './callbacks'
import { AUTH_STORAGE_KEY, signInError } from './supabase'

const URL_ = 'http://127.0.0.1:54321'
const ANON = 'test-anon-key-000000000000'
const user = { id: '1832dedf-8c8e-51cb-b929-c0baad95dfae', aud: 'authenticated', role: 'authenticated', email: 'qa@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-06-01T00:00:00Z' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function server(answer: (verifier: string) => Response) {
  const tokenCalls: { code: string; verifier: string }[] = []
  const otp: { redirect: string | null; challenge: string }[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/auth/v1/otp') {
      const body = JSON.parse(String(init?.body)) as { code_challenge: string }
      otp.push({ redirect: url.searchParams.get('redirect_to'), challenge: body.code_challenge })
      return json({})
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      const body = JSON.parse(String(init?.body)) as { auth_code: string; code_verifier: string }
      tokenCalls.push({ code: body.auth_code, verifier: body.code_verifier })
      return answer(body.code_verifier)
    }
    if (url.pathname.startsWith('/rest/v1/')) return json([])
    return json({ message: 'not found' }, 404)
  }
  return { fetchFn, tokenCalls, otp }
}

const ok = () => json({ access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user })

function client(fetchFn: typeof fetch) {
  const storage = memoryAuthStorage()
  const auth = createAuth({ url: URL_, anonKey: ANON, fetch: fetchFn, auth: { redirectUrl: () => 'slicerx://auth/callback', storage } })
  return { auth, storage }
}

describe('finishing an emailed sign-in link', () => {
  it('asks for the link back at the deep link and exchanges the code with that request verifier', async () => {
    const s = server(() => ok())
    const { auth, storage } = client(s.fetchFn)
    expect((await auth.signInWithEmail('qa@example.com')).ok).toBe(true)
    expect(s.otp[0]?.redirect).toBe('slicerx://auth/callback')
    const stored = await storage.getItem(`${AUTH_STORAGE_KEY}-code-verifier`)
    const r = await auth.completeSignIn('slicerx://auth/callback?code=c1')
    expect(r).toMatchObject({ ok: true, value: { email: 'qa@example.com' } })
    expect(s.tokenCalls).toEqual([{ code: 'c1', verifier: JSON.parse(stored ?? '""') }])
  })

  it('exchanges a link handed over twice only once', async () => {
    const s = server(() => ok())
    const { auth } = client(s.fetchFn)
    await auth.signInWithEmail('qa@example.com')
    const [a, b] = await Promise.all([auth.completeSignIn('slicerx://auth/callback?code=c2'), auth.completeSignIn('slicerx://auth/callback?code=c2')])
    expect(a.ok && b.ok).toBe(true)
    expect(s.tokenCalls).toHaveLength(1)
  })

  it('uses the verifier of the request the link names, even after a newer request', async () => {
    const s = server(() => ok())
    const { auth, storage } = client(s.fetchFn)
    await auth.signInWithEmail('qa@example.com')
    const index = JSON.parse((await storage.getItem(`${AUTH_STORAGE_KEY}-flows-code-verifier`)) ?? '[]') as string[]
    const first = index[0] ?? ''
    const firstVerifier = JSON.parse((await storage.getItem(`${AUTH_STORAGE_KEY}-flow-${first}-code-verifier`)) ?? '""') as string
    await auth.signInWithEmail('qa@example.com')
    const index2 = JSON.parse((await storage.getItem(`${AUTH_STORAGE_KEY}-flows-code-verifier`)) ?? '[]') as string[]
    expect(await auth.completeSignIn(`slicerx://auth/callback?code=c3&sb_flow_id=${first}`)).toMatchObject({ ok: true })
    expect(s.tokenCalls[0]?.verifier).toBe(firstVerifier)
    // Signed in, every pending request's verifier is cleared.
    for (const id of index2) expect(await storage.getItem(`${AUTH_STORAGE_KEY}-flow-${id}-code-verifier`)).toBeNull()
    expect(await storage.getItem(`${AUTH_STORAGE_KEY}-flows-code-verifier`)).toBeNull()
    expect(await storage.getItem(`${AUTH_STORAGE_KEY}-code-verifier`)).toBeNull()
  })

  it('says what to do when the link answers an older request', async () => {
    const s = server(() => json({ code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier', error_code: 'bad_code_verifier' }, 400))
    const { auth } = client(s.fetchFn)
    await auth.signInWithEmail('qa@example.com')
    expect(await auth.completeSignIn('slicerx://auth/callback?code=c4')).toMatchObject({ ok: false, message: 'This link answers an earlier request. Open the newest sign-in email, or send a new link.' })
  })

  it('turns a superseded link into a plain message and still signs in with the newest one', async () => {
    const s = server(() => ok())
    const { auth, storage } = client(s.fetchFn)
    await auth.signInWithEmail('qa@example.com')
    await auth.signInWithEmail('qa@example.com')
    const newest = JSON.parse((await storage.getItem(`${AUTH_STORAGE_KEY}-code-verifier`)) ?? '""') as string
    // Supabase invalidated the first email's link when the second was sent.
    const old = await auth.completeSignIn('slicerx://auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
    expect(old).toMatchObject({ ok: false, message: 'This link has expired, or a newer one was sent. Use the newest email, or send a new link.' })
    expect(s.tokenCalls).toHaveLength(0)
    expect(await auth.completeSignIn('slicerx://auth/callback?code=c5')).toMatchObject({ ok: true })
    expect(s.tokenCalls).toEqual([{ code: 'c5', verifier: newest }])
  })

  it('maps expired and used links, and keeps other messages', () => {
    expect(signInError({ code: 'flow_state_not_found', message: 'invalid flow state, no valid flow state found' })).toBe('This link has expired or was already used. Send a new link.')
    expect(signInError({ message: 'Email rate limit exceeded' })).toBe('Email rate limit exceeded')
  })
})
