// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The invoke wrapper keeps the name of the last shell command that failed, never its arguments, for crash reports;
// the crash host names where the app runs from by a coarse label, never its path.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'open_file') throw 'unknown path'
    return 'ok'
  },
}))

describe('the invoke wrapper', () => {
  it('records the command that rejected, by name only, and passes the rejection on', async () => {
    const { invoke, lastFailedCommand, tracked } = await import('../src/host/invoke')
    expect(lastFailedCommand()).toBeNull()
    expect(await invoke('crash_take', { pageLoad: true })).toBe('ok')
    expect(lastFailedCommand()).toBeNull()
    await expect(invoke('open_file', { path: '/Users/sean/Downloads/plate.3mf' })).rejects.toBe('unknown path')
    expect(lastFailedCommand()).toBe('open_file')
    // a path resolver call from the API's own modules is tracked under its command
    const resolve = tracked('resolve_resource', async (_p: string) => Promise.reject('unknown path'))
    await expect(resolve('/Users/sean/x')).rejects.toBe('unknown path')
    expect(lastFailedCommand()).toBe('resolve_resource')
    expect(JSON.stringify(lastFailedCommand())).not.toMatch(/sean|plate/)
  })
})

describe('where the app runs from', () => {
  it('is a coarse label with no path', async () => {
    const { runsFromOf } = await import('../src/host/crash')
    expect(runsFromOf('/Applications/SlicerX.app/Contents/Resources')).toBe('Applications folder')
    expect(runsFromOf('/Volumes/SlicerX 0.2.16/SlicerX.app/Contents/Resources')).toBe('disk image')
    expect(runsFromOf('/private/var/folders/x/T/AppTranslocation/ABC/d/SlicerX.app/Contents/Resources')).toBe('elsewhere (moved by macOS on first open)')
    expect(runsFromOf('/Users/sean/Downloads/SlicerX.app/Contents/Resources')).toBe('elsewhere')
    expect(runsFromOf('C:\\Program Files\\SlicerX')).toBe('elsewhere')
  })

  it("says the app's resources are missing when the shell cannot find them", async () => {
    const { createTauriCrash } = await import('../src/host/crash')
    const host = createTauriCrash(async () => Promise.reject('unknown path'))
    expect(await host.runsFrom?.()).toBe("its resources are missing (moved or ejected while it ran)")
    const there = createTauriCrash(async () => '/Applications/SlicerX.app/Contents/Resources')
    expect(await there.runsFrom?.()).toBe('Applications folder')
  })
})
