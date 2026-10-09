// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A canceled slice on the desktop: the engine is told to stop, and a result that lands anyway is released, so the
// shell does not keep finished G-code nobody will read.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[], slice: null as null | ((args: { job: number }) => Promise<unknown>) }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    tauri.calls.push({ cmd, args })
    if (cmd === 'slice' && tauri.slice) return tauri.slice(args as { job: number })
    return null
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriSlicer } = await import('../src/host/slicer')

const report = { id: 41, layerCount: 2, layerZ: [0.2, 0.4], layerTimeS: [1, 1], stats: { timeS: 2, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, warnings: [] }
const req = { plate: { objects: [] }, config: {} } as never

beforeEach(() => {
  tauri.calls.length = 0
  tauri.slice = null
})

describe('canceling a desktop slice', () => {
  it('asks the engine to stop that job and rejects with AbortError', async () => {
    const ac = new AbortController()
    tauri.slice = (args) =>
      new Promise((_, reject) => {
        // The engine stops when told and answers with its error.
        const t = setInterval(() => {
          if (tauri.calls.some((c) => c.cmd === 'cancel_slice' && (c.args as { job: number }).job === args.job)) {
            clearInterval(t)
            reject(new Error('slicing was canceled'))
          }
        }, 1)
      })
    const p = createTauriSlicer().slice(req, { signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    const job = (tauri.calls.find((c) => c.cmd === 'slice')!.args as { job: number }).job
    expect(tauri.calls.filter((c) => c.cmd === 'cancel_slice')).toEqual([{ cmd: 'cancel_slice', args: { job } }])
  })

  it('releases a result that lands after the cancel', async () => {
    const ac = new AbortController()
    tauri.slice = () => new Promise((resolve) => setTimeout(() => resolve(report), 10))
    const p = createTauriSlicer().slice(req, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(tauri.calls.filter((c) => c.cmd === 'release')).toEqual([{ cmd: 'release', args: { id: 41 } }])
  })

  it('a slice that is not canceled keeps its result and sends no cancel', async () => {
    tauri.slice = async () => report
    const r = await createTauriSlicer().slice(req, { signal: new AbortController().signal })
    expect(r.id).toBe('41')
    expect(tauri.calls.map((c) => c.cmd)).toEqual(['slice'])
  })
})
