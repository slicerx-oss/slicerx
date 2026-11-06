// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry workers alive and the engine memory each holds, as the agent bridge reads them (geom/worker-memory.ts):
// a worker shows with what it last reported, and once its idle time passes it ends and its memory goes from the count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: { id?: number }[] = []
  terminated = false
  postMessage(m: { id?: number }) {
    this.posted.push(m)
  }
  answer(id: number, memoryBytes: number) {
    this.onmessage?.({ data: { id, result: { ok: true }, memoryBytes } } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}

let made: FakeWorker[] = []
const MB = 1024 * 1024

beforeEach(() => {
  made = []
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('Worker', function () {
    const w = new FakeWorker()
    made.push(w)
    return w
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the geometry workers report', () => {
  it('shows the shared worker with its engine memory, and drops it when it ends idle', async () => {
    const { geom, setGeomProvider, endIdleGeomWorker, IDLE_MS } = await import('../src/geom/client')
    const { geomWorkers } = await import('../src/geom/worker-memory')
    setGeomProvider(null)
    const call = geom().call('measure', {})
    made[0]!.answer(1, 140 * MB)
    await call
    expect(geomWorkers()).toMatchObject({ live: 1, memoryBytes: 140 * MB, workers: [{ kind: 'shared', memoryBytes: 140 * MB }] })
    vi.advanceTimersByTime(IDLE_MS)
    expect(made[0]!.terminated).toBe(true)
    expect(geomWorkers()).toMatchObject({ live: 0, memoryBytes: 0 })
    endIdleGeomWorker()
  })

  it('shows the fit check worker with its engine memory, and nothing once its idle time passes', async () => {
    const { fitCall } = await import('../src/geom/fit-client')
    const { IDLE_MS } = await import('../src/geom/client')
    const { geomWorkers } = await import('../src/geom/worker-memory')
    const check = fitCall({ items: [] })
    const w = made[0]!
    const id = w.posted.find((m) => typeof m.id === 'number')!.id!
    w.answer(id, 148 * MB)
    await check
    expect(geomWorkers()).toMatchObject({ live: 1, memoryBytes: 148 * MB, workers: [{ kind: 'fit', memoryBytes: 148 * MB }] })
    vi.advanceTimersByTime(IDLE_MS)
    expect(w.terminated).toBe(true)
    expect(geomWorkers()).toMatchObject({ live: 0, memoryBytes: 0 })
  })

  it('counts a one-call worker while its call runs, and not after', async () => {
    const { soloCall } = await import('../src/geom/client')
    const { geomWorkers } = await import('../src/geom/worker-memory')
    const { answer } = soloCall('format.read3mf', {})
    expect(geomWorkers()).toMatchObject({ live: 1, workers: [{ kind: 'solo' }] })
    made[0]!.answer(1, 300 * MB)
    await answer
    expect(geomWorkers()).toMatchObject({ live: 0, memoryBytes: 0 })
  })
})
