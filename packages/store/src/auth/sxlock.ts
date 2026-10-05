// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The account side of locked projects (.sxlock) over Supabase: content keys come from the sxlock functions in
// supabase/migrations/0010_sxlock.sql, which hold each account's secret and never send it.
import type { AuthClient, SxlockAccountKey, SxlockFailure, SxlockResult } from '@slicerx/contracts'
import { z } from 'zod'
import { isoTime } from '../map'
import { rows, type Db } from './supabase'

type SxlockMethods = Pick<AuthClient, 'sxlockSeal' | 'sxlockOpen' | 'sxlockKeys' | 'rotateSxlockKey' | 'revokeSxlockKey'>

const REASONS = new Set<string>(['signed_out', 'wrong_account', 'revoked', 'unknown_key', 'missing_scope', 'rate_limited', 'banned', 'invalid'])
const HEX64 = /^[0-9a-f]{64}$/

/** Maps an error from the sxlock functions: the server names the reason in the hint; no answer at all is offline. */
export function sxlockRefusal(e: { code?: string; message?: string; hint?: string | null }): { ok: false; reason: SxlockFailure; message: string } {
  const hint = e.hint ?? ''
  const offline = !e.code && /fetch|network|load failed/i.test(e.message ?? '')
  const reason: SxlockFailure = REASONS.has(hint) ? (hint as SxlockFailure) : offline || !e.code ? 'offline' : 'invalid'
  return { ok: false, reason, message: e.message ?? reason }
}

const keyRow = z.object({ id: z.string(), created_at: z.string(), retired_at: z.string().nullable().optional(), revoked_at: z.string().nullable().optional() })

const toKey = (r: z.infer<typeof keyRow>): SxlockAccountKey => ({
  id: r.id,
  createdAt: isoTime(r.created_at),
  ...(r.retired_at ? { retiredAt: isoTime(r.retired_at) } : {}),
  ...(r.revoked_at ? { revokedAt: isoTime(r.revoked_at) } : {}),
})

async function call<T>(q: PromiseLike<{ data: unknown; error: { code?: string; message: string; hint?: string | null } | null }>, map: (data: unknown) => T | null): Promise<SxlockResult<T>> {
  let res
  try {
    res = await q
  } catch (e) {
    return sxlockRefusal({ message: e instanceof Error ? e.message : 'fetch failed' })
  }
  if (res.error) return sxlockRefusal(res.error)
  const value = map(res.data)
  return value === null ? { ok: false, reason: 'invalid', message: 'The account service sent an answer that is not valid.' } : { ok: true, value }
}

export function supabaseSxlock(sb: Db, signedIn: () => Promise<boolean>): SxlockMethods {
  const signedOut = { ok: false as const, reason: 'signed_out' as const, message: 'Sign in first' }
  return {
    async sxlockSeal(salt) {
      if (!(await signedIn())) return signedOut
      return call(sb.rpc('sxlock_seal', { p_salt: salt }), (data) => {
        const r = rows(z.object({ owner: z.string(), key_id: z.string(), content_key: z.string() }), data)[0]
        return r && HEX64.test(r.content_key) ? { owner: r.owner, keyId: r.key_id, contentKey: r.content_key } : null
      })
    },

    async sxlockOpen(ref) {
      if (!(await signedIn())) return signedOut
      return call(sb.rpc('sxlock_open', { p_owner: ref.owner, p_key_id: ref.keyId, p_salt: ref.salt }), (data) => (typeof data === 'string' && HEX64.test(data) ? data : null))
    },

    async sxlockKeys() {
      if (!(await signedIn())) return []
      const { data, error } = await sb.rpc('sxlock_keys')
      if (error) throw new Error(`store read failed (${error.code ?? 'unknown'}): ${error.message}`)
      return rows(keyRow, data).map(toKey)
    },

    async rotateSxlockKey() {
      if (!(await signedIn())) return signedOut
      return call(sb.rpc('rotate_sxlock_key'), (data) => {
        const r = rows(keyRow, data)[0]
        return r ? toKey(r) : null
      })
    },

    async revokeSxlockKey(id) {
      if (!(await signedIn())) return signedOut
      const r = await call(sb.rpc('revoke_sxlock_key', { p_id: id }), (data) => (typeof data === 'boolean' ? data : null))
      if (!r.ok) return r
      return r.value ? { ok: true, value: undefined } : { ok: false, reason: 'unknown_key', message: 'No such key' }
    },
  }
}
