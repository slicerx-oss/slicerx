// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { createAuth } from './index'
import type { Db } from './supabase'
import { supabaseSxlock, sxlockRefusal } from './sxlock'

const KEY = 'ab'.repeat(32)
const REF = { owner: '00000000-0000-4000-8000-000000000001', keyId: '00000000-0000-4000-8000-000000000002', salt: 'cd'.repeat(32) }

/** A client whose rpc answers from a table, or throws like a fetch with no network. */
function db(answers: Record<string, { data?: unknown; error?: { code?: string; message: string; hint?: string } } | 'down'>): Db {
  return {
    rpc: async (fn: string) => {
      const a = answers[fn]
      if (a === 'down') throw new TypeError('fetch failed')
      return { data: a?.data ?? null, error: a?.error ?? null }
    },
  } as unknown as Db
}

describe('locked project keys over Supabase', () => {
  it('maps the server hint to a reason, and no answer to offline', () => {
    expect(sxlockRefusal({ code: '42501', message: 'x', hint: 'wrong_account' }).reason).toBe('wrong_account')
    expect(sxlockRefusal({ code: '42501', message: 'x', hint: 'missing_scope' }).reason).toBe('missing_scope')
    expect(sxlockRefusal({ code: '42501', message: 'x', hint: 'revoked' }).reason).toBe('revoked')
    expect(sxlockRefusal({ message: 'TypeError: fetch failed' }).reason).toBe('offline')
    expect(sxlockRefusal({ code: 'XX000', message: 'boom' }).reason).toBe('invalid')
  })

  it('returns content keys and passes refusals through', async () => {
    const ok = supabaseSxlock(db({ sxlock_open: { data: KEY }, sxlock_seal: { data: [{ owner: REF.owner, key_id: REF.keyId, content_key: KEY }] } }), async () => true)
    expect(await ok.sxlockOpen(REF)).toEqual({ ok: true, value: KEY })
    expect(await ok.sxlockSeal(REF.salt)).toEqual({ ok: true, value: { owner: REF.owner, keyId: REF.keyId, contentKey: KEY } })
    const revoked = supabaseSxlock(db({ sxlock_open: { error: { code: '42501', message: 'revoked', hint: 'revoked' } } }), async () => true)
    expect(await revoked.sxlockOpen(REF)).toMatchObject({ ok: false, reason: 'revoked' })
    const down = supabaseSxlock(db({ sxlock_open: 'down' }), async () => true)
    expect(await down.sxlockOpen(REF)).toMatchObject({ ok: false, reason: 'offline' })
    const bad = supabaseSxlock(db({ sxlock_open: { data: 'short' } }), async () => true)
    expect(await bad.sxlockOpen(REF)).toMatchObject({ ok: false, reason: 'invalid' })
    const out = supabaseSxlock(db({}), async () => false)
    expect(await out.sxlockOpen(REF)).toMatchObject({ ok: false, reason: 'signed_out' })
  })

  it('offline builds say they have no account service, not that the network is down', async () => {
    const auth = createAuth({ offline: true })
    expect(await auth.sxlockOpen(REF)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await auth.sxlockSeal(REF.salt)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await auth.sxlockKeys()).toEqual([])
  })
})
