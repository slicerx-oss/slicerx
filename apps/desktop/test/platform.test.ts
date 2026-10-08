// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const invoked = vi.hoisted(() => [] as string[])
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    invoked.push(cmd)
    return 'x86_64'
  },
}))

describe('the shell CPU', () => {
  it('asks the shell_arch command', async () => {
    const { shellArch } = await import('../src/host/platform')
    expect(await shellArch()).toBe('x86_64')
    expect(invoked).toEqual(['shell_arch'])
  })

  it('is registered with the shell and with the app', () => {
    const rs = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
    expect(rs).toContain('platform::shell_arch')
    const page = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    expect(page).toContain('registerShellArch(shellArch)')
  })
})
