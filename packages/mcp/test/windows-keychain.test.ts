// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { readKeychainKey } from '../src/link-code'
import { withWindowsCredential } from './helpers/windows-credential'

describe.skipIf(process.platform !== 'win32')('Windows remembered-client credentials', () => {
  it('reads the desktop keyring format from an isolated item and refuses it after removal', async () => {
    let removed: [string, string] | undefined
    await withWindowsCredential('test password \u00e9 \ud801\udc00', (ref, identifier) => {
      expect(readKeychainKey(ref, undefined, identifier)).toBe('test password \u00e9 \ud801\udc00')
      removed = [ref, identifier]
    })
    expect(() => readKeychainKey(removed![0], undefined, removed![1])).toThrow(/Connect this app again/)
  })

  it('rejects empty, odd-length and invalid UTF-16 items without exposing their bytes', async () => {
    await withWindowsCredential('', (ref, identifier) => {
      expect(() => readKeychainKey(ref, undefined, identifier)).toThrow(/item .* is empty/)
    })
    for (const bytes of [new Uint8Array([65]), new Uint8Array([0, 216])]) {
      await withWindowsCredential(bytes, (ref, identifier) => {
        expect(() => readKeychainKey(ref, undefined, identifier)).toThrow(/No hub credential/)
      })
    }
  })

  it('restricts names before starting PowerShell and sanitizes helper failures', () => {
    const run = () => { throw new Error('private-value not supported') }
    expect(() => readKeychainKey('other-item', run)).toThrow(/not an agent credential/)
    expect(() => readKeychainKey('slicerx-agent-cursor', run, "app.test';bad")).toThrow(/not an app identifier/)
    try { readKeychainKey('slicerx-agent-cursor', run); expect.fail('expected failure') } catch (error) {
      expect(String(error)).toContain('Connect this app again')
      expect(String(error)).not.toContain('private-value')
    }
  })
})
