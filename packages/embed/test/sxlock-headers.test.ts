// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { tokenKeys } from '../src/sxlock'

function capture() {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return new Response(JSON.stringify('ab'.repeat(32)), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const ref = { owner: '00000000-0000-4000-8000-000000000001', keyId: '00000000-0000-4000-8000-000000000002', salt: 'cd'.repeat(32) }

describe('the account service calls', () => {
  it('send a publishable key as apikey only, and the account token in the body', async () => {
    const { calls, fetch } = capture()
    await tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'sb_publishable_abc', token: 'sxk_t', fetch }).open(ref)
    expect(calls[0]?.headers).toEqual({ apikey: 'sb_publishable_abc', 'content-type': 'application/json' })
    expect(calls[0]?.body['p_token']).toBe('sxk_t')
  })

  it('send a legacy anon JWT as the bearer too', async () => {
    const { calls, fetch } = capture()
    await tokenKeys({ supabaseUrl: 'https://db.example', anonKey: 'eyJhbGciOi.anon', token: 'sxk_t', fetch }).open(ref)
    expect(calls[0]?.headers['authorization']).toBe('Bearer eyJhbGciOi.anon')
  })
})
