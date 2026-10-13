// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { keyUpdate, registerKeyHash } from './mimir-key'

describe('mimir registration keys', () => {
  it('hashes as public.mimir_token_hash does (the pgTAP suite checks the same value)', () => {
    expect(registerKeyHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('sets, rotates and refuses keys the function would not take', () => {
    const k = 'slicerx-0123456789abcdef'
    expect(keyUpdate(k, null, false)).toEqual({ register_key_hash: registerKeyHash(k) })
    expect(keyUpdate(k, 'f'.repeat(64), true)).toEqual({ register_key_hash: registerKeyHash(k), register_key_prev_hash: 'f'.repeat(64) })
    expect(() => keyUpdate(k, null, true)).toThrow('nothing to rotate')
    expect(() => keyUpdate(k, registerKeyHash(k), true)).toThrow('already the current key')
    expect(() => keyUpdate('short', null, false)).toThrow('16 to 128')
    expect(() => keyUpdate('has a space in it here', null, false)).toThrow('16 to 128')
  })
})
