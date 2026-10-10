// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkCodeFrom, linkKeyFrom, readAgentCode, readHubKey } from '../src/link-code'

describe('the sx-link agent code stays off the command line', () => {
  it('refuses --link-code', () => {
    expect(() => linkCodeFrom({ argvCode: 'ABCD-EFGH', stateDir: undefined, envCode: undefined, needed: true })).toThrow(/no longer accepted/)
  })

  it('reads the hub file only when other users cannot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-hub-'))
    const file = join(dir, 'agent-code')
    writeFileSync(file, 'WXYZ-2345\n')
    chmodSync(file, 0o600)
    expect(readAgentCode(dir)).toBe('WXYZ-2345')
    expect(linkCodeFrom({ argvCode: undefined, stateDir: dir, envCode: undefined, needed: true })).toBe('WXYZ-2345')
    expect(linkCodeFrom({ argvCode: undefined, stateDir: dir, envCode: 'FROM-ENVV', needed: true })).toBe('FROM-ENVV')
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644)
      expect(() => readAgentCode(dir)).toThrow(/readable by other users/)
    }
    expect(readAgentCode(join(dir, 'missing'))).toBeUndefined()
  })
  it('takes a partner app key in its own format and never repeats a bad one', () => {
    const key = `sxp_${'0123456789abcdef'.repeat(4)}`
    expect(linkKeyFrom(` ${key}\n`)).toBe(key)
    for (const bad of ['sxp_short', 'f'.repeat(64), `sxp_${'G'.repeat(64)}`, `${key}x`]) {
      expect(() => linkKeyFrom(bad)).toThrow(/not a SlicerX partner app key/)
      try {
        linkKeyFrom(bad)
      } catch (e) {
        expect((e as Error).message).not.toContain(bad)
      }
    }
  })
  it('reads the hub key the client checks before sending the code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-hub-'))
    expect(readHubKey(dir)).toBeUndefined()
    writeFileSync(join(dir, 'hub-key.pub'), 'AAAA\n')
    expect(readHubKey(dir)).toBe('AAAA')
  })
})
