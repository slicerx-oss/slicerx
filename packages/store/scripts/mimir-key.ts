// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition's mimir registration key: the build carries the key, the database keeps only its
// sha256 (public.mimir_token_hash in supabase/migrations/0020_mimir_proxy.sql).
import { createHash } from 'node:crypto'

/** The keys the mimir function accepts on register (supabase/functions/mimir/handler.ts). */
export const REGISTER_KEY = /^[A-Za-z0-9_-]{16,128}$/

/** The hash public.mimir_token_hash keeps for a key: sha256 of its UTF-8 bytes, lowercase hex. */
export function registerKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * The mimir_limits change for a new key. A rotation keeps the current hash as the previous one, so
 * builds with the old key still register until they are gone.
 */
export function keyUpdate(key: string, current: string | null, rotate: boolean): { register_key_hash: string; register_key_prev_hash?: string | null } {
  if (!REGISTER_KEY.test(key)) throw new Error('the key must be 16 to 128 letters, digits, - or _')
  const hash = registerKeyHash(key)
  if (!rotate) return { register_key_hash: hash }
  if (!current) throw new Error('nothing to rotate: the edition has no key yet')
  if (current === hash) throw new Error('that is already the current key')
  return { register_key_hash: hash, register_key_prev_hash: current }
}
