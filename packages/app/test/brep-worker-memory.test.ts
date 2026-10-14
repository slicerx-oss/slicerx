// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ bytes: 0, loads: 0 }))
vi.mock('../src/geom/brep', () => ({ loadBrep: async () => { state.loads++; return { memoryBytes: () => state.bytes, call: (op: string) => { if (op === 'fail') throw new Error('failed'); return {} } } } }))
vi.mock('../src/geom/modules', () => ({ engineModules: () => ({ run: async () => ({}), full: async () => ({}) }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules() })

it('reports the lazy exact heap after growth and on error replies', async () => {
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((e: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  await import('../src/geom/geom-worker')
  const send = async (op: string) => { await worker.onmessage!({ data: { id: 1, op, request: {} } }); return postMessage.mock.lastCall![0] as { memoryBytes: number; error?: string } }
  expect((await send('mesh.info')).memoryBytes).toBe(0)
  expect(state.loads).toBe(0)
  state.bytes = 16 * 1024 * 1024
  expect((await send('brep.count')).memoryBytes).toBe(state.bytes)
  state.bytes = 300 * 1024 * 1024
  expect(await send('brep.fail')).toMatchObject({ error: 'failed', memoryBytes: state.bytes })
  expect((await send('mesh.info')).memoryBytes).toBe(state.bytes)
  expect(state.loads).toBe(1)
})

it.each([[256 * 1024 * 1024, 30_000], [300 * 1024 * 1024, 2_000]])('recycles an exact worker holding %i bytes after %i ms', async (memoryBytes, idleMs) => {
  vi.useFakeTimers()
  const workers: { terminate: ReturnType<typeof vi.fn>; onmessage?: (e: unknown) => void; postMessage: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('Worker', class {
    terminate = vi.fn()
    onmessage?: (e: unknown) => void
    postMessage = vi.fn((r: { id: number }) => { this.onmessage?.({ data: { id: r.id, result: {}, memoryBytes } }) })
    constructor() { workers.push(this) }
  })
  const { geom, setGeomProvider, endIdleGeomWorker } = await import('../src/geom/client')
  setGeomProvider(null)
  await geom().call('history.replay', { history: { version: 2, base: [], steps: [] }, exact: true })
  await vi.advanceTimersByTimeAsync(idleMs! - 1)
  expect(workers[0]!.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  await geom().call('history.replay', { history: { version: 2, base: [], steps: [] }, exact: true })
  expect(workers).toHaveLength(2)
  expect(workers[1]!.postMessage.mock.calls[0]![0].op).toBe('history.replay')
  endIdleGeomWorker()
  setGeomProvider(null)
})
