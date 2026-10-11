// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A test build (debug, or with the agent bridge) never asks the update feed: the shell reports mode "off", so the page
// registers no updater, runs no check and shows no update sheet. Keyed on the kind of build, never its version.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const reply = vi.hoisted(() => ({ mode: 'off' as string | Error }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd !== 'update_mode') throw new Error(`unexpected ${cmd}`)
    if (reply.mode instanceof Error) throw reply.mode
    return reply.mode
  },
  Channel: class {},
}))

describe('the updater mode', () => {
  it('is null when the shell says off or cannot say, and the shell mode otherwise', async () => {
    const { updaterMode } = await import('../src/host/updater')
    reply.mode = 'off'
    expect(await updaterMode()).toBeNull()
    reply.mode = new Error('no such command')
    expect(await updaterMode()).toBeNull()
    reply.mode = 'install'
    expect(await updaterMode()).toBe('install')
    reply.mode = 'download'
    expect(await updaterMode()).toBe('download')
  })

  it('is off in a debug or agent bridge build: the shell gates the updater on the kind of build', () => {
    const updates = readFileSync(new URL('../src-tauri/src/updates.rs', import.meta.url), 'utf8')
    expect(updates).toContain('pub const TEST_BUILD: bool = cfg!(debug_assertions) || cfg!(feature = "agent-bridge");')
    const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
    expect(main).toContain('updates::checks(updates::configured(context.config()), updates::TEST_BUILD)')
    expect(main).toMatch(/if updates_on \{\s*builder\.plugin\(tauri_plugin_updater/)
    expect(main).toContain('updates::Updates::new(updates_on)')
    // and the page registers an updater only for a mode the shell reported
    const page = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/const mode = await updaterMode\(\)\s*if \(mode\) \{\s*registerUpdater/)
  })
})
