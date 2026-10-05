// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const invoked = vi.hoisted(() => [] as [string, unknown][])
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    invoked.push([cmd, args])
    return cmd === 'crash_take' ? { reports: [], pageLoads: 1, os: 'macOS 15.1 (aarch64)' } : undefined
  },
}))

describe('the crash host', () => {
  it('maps to the shell commands', async () => {
    const { createTauriCrash } = await import('../src/host/crash')
    const host = createTauriCrash()
    expect(await host.take(true)).toEqual({ reports: [], pageLoads: 1, os: 'macOS 15.1 (aarch64)' })
    await host.ack(['crash-1-2-3.json'])
    await host.testPanic()
    expect(invoked).toEqual([
      ['crash_take', { pageLoad: true }],
      ['crash_ack', { files: ['crash-1-2-3.json'] }],
      ['crash_test_panic', undefined],
    ])
  })

  it('registers every crash command with the shell', () => {
    const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
    for (const c of ['crash::crash_take', 'crash::crash_ack', 'crash::crash_test_panic', 'crash::install_hook()']) expect(main, c).toContain(c)
  })

  it('keeps the base connect-src the edition config extends', async () => {
    const { DESKTOP_CONNECT_SRC } = await import('@slicerx/edition-config')
    const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: Record<string, string> } } }
    expect(conf.app.security.csp['connect-src']).toBe(DESKTOP_CONNECT_SRC)
  })

  it('lets the shell open the Discord bug-reports channel', () => {
    const caps = readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8')
    expect(caps).toContain('https://discord.com/channels/1555048815881355324/*')
  })
})
