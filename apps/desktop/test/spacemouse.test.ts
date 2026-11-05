// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The desktop 3D mouse: the shell's reader starts only after the page listens, its raw reports reach the app as
// bytes, its statuses read as the setting expects, and stopping lets the device go.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ calls: [] as string[], handlers: new Map<string, (e: { payload: unknown }) => void>(), unlistened: [] as string[], failListen: false }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    // the reader starts only once both events are listened to
    tauri.calls.push(`${cmd}:${[...tauri.handlers.keys()].sort().join(',')}`)
    return null
  },
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, h: (e: { payload: unknown }) => void) => {
    if (tauri.failListen) throw new Error('no event bridge')
    tauri.handlers.set(name, h)
    return () => {
      tauri.handlers.delete(name)
      tauri.unlistened.push(name)
    }
  },
}))

const { createTauriSpaceMouse, statusOf } = await import('../src/host/spacemouse')
const flush = () => new Promise((r) => setTimeout(r, 0))

const reset = () => {
  tauri.calls = []
  tauri.handlers.clear()
  tauri.unlistened = []
  tauri.failListen = false
}

describe('desktop 3D mouse', () => {
  beforeEach(reset)

  it('stops a reader a reloaded page left running as the page loads, before any start', async () => {
    const src = createTauriSpaceMouse()
    await flush()
    expect(tauri.calls).toEqual(['spacemouse_stop:'])
    const stop = src.start(
      () => {},
      () => {},
    )
    await flush()
    expect(tauri.calls.map((c) => c.split(':')[0])).toEqual(['spacemouse_stop', 'spacemouse_start'])
    stop()
  })

  it('never starts the reader when stopped before it was listening', async () => {
    const stop = createTauriSpaceMouse().start(
      () => {},
      () => {},
    )
    stop()
    await flush()
    expect(tauri.calls.filter((c) => c.startsWith('spacemouse_start'))).toEqual([])
    expect(tauri.unlistened.sort()).toEqual(['sx-spacemouse-report', 'sx-spacemouse-status'])
  })

  it('starts again after a stop, and says so when it cannot listen', async () => {
    const src = createTauriSpaceMouse()
    src.start(() => {}, () => {})()
    await flush()
    const statuses: unknown[] = []
    const stop = src.start(() => {}, (s) => statuses.push(s))
    await flush()
    expect(tauri.calls.map((c) => c.split(':')[0]).slice(-2)).toEqual(['spacemouse_stop', 'spacemouse_start'])
    stop()
    tauri.failListen = true
    const failed: unknown[] = []
    createTauriSpaceMouse().start(() => {}, (s) => failed.push(s))
    await flush()
    expect(failed.at(-1)).toMatchObject({ state: 'error' })
  })

  it('starts the reader after listening, passes reports and statuses on, and stops it', async () => {
    const reports: number[][] = []
    const statuses: unknown[] = []
    const stop = createTauriSpaceMouse().start(
      (b) => reports.push([...b]),
      (s) => statuses.push(s),
    )
    await flush()
    expect(tauri.calls).toEqual(['spacemouse_stop:', 'spacemouse_start:sx-spacemouse-report,sx-spacemouse-status'])
    tauri.handlers.get('sx-spacemouse-status')!({ payload: { state: 'connected', name: 'SpaceMouse Wireless' } })
    tauri.handlers.get('sx-spacemouse-report')!({ payload: [1, 175, 0, 0, 0, 0, 0] })
    expect(statuses).toEqual([{ state: 'none' }, { state: 'connected', name: 'SpaceMouse Wireless' }])
    expect(reports).toEqual([[1, 175, 0, 0, 0, 0, 0]])
    stop()
    await flush()
    expect(tauri.calls.at(-1)).toMatch(/^spacemouse_stop/)
    expect(tauri.unlistened.sort()).toEqual(['sx-spacemouse-report', 'sx-spacemouse-status'])
  })

  it('reads the shell statuses, an unknown one as an error', () => {
    expect(statusOf({ state: 'none' })).toEqual({ state: 'none' })
    expect(statusOf({ state: 'busy', name: 'SpaceMouse Pro' })).toEqual({ state: 'busy', name: 'SpaceMouse Pro' })
    expect(statusOf({ state: 'connected', name: '' })).toEqual({ state: 'connected', name: '3D mouse' })
    expect(statusOf({ state: 'error', message: 'No permission to read SpaceMouse.' })).toEqual({ state: 'error', message: 'No permission to read SpaceMouse.' })
    expect(statusOf(null)).toEqual({ state: 'error', message: "Can't read the 3D mouse." })
  })
})
