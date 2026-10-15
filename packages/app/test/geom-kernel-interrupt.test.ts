// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Worker as Thread } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { clearReplayCache, IDENTITY, replayHistory, type History } from '@slicerx/cad-history'
import { endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'

it('ends a busy real kernel worker and starts again without its body handles', async () => {
  const workers: KernelWorker[] = []
  class KernelWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    terminated = false
    thread: Thread
    started: Promise<number>
    exited: Promise<number>
    constructor() {
      this.thread = new Thread(new URL('./fixtures/brep-busy-worker.mjs', import.meta.url))
      this.started = new Promise((resolve) => {
        this.thread.on('message', (data: { started?: boolean; body?: number }) => {
          if (data.started) resolve(data.body!)
          else this.onmessage?.({ data } as MessageEvent)
        })
      })
      this.exited = new Promise((resolve) => this.thread.once('exit', resolve))
      this.thread.on('error', (error) => this.onerror?.({ message: error.message } as ErrorEvent))
      workers.push(this)
    }
    postMessage(message: unknown) { this.thread.postMessage(message) }
    terminate() { this.terminated = true; void this.thread.terminate() }
  }
  vi.stubGlobal('Worker', KernelWorker)
  setGeomProvider(null)
  try {
    const api = geom()
    const ctl = new AbortController()
    const replay = api.call('history.replay', { exact: true }, ctl.signal).catch((e: Error) => e)
    const old = workers[0]!
    expect(await old.started).toBeGreaterThan(0)
    const queued = api.call('brep.count', {}).catch((e: Error) => e)
    ctl.abort()
    expect(old.terminated).toBe(true)
    expect(await replay).toMatchObject({ name: 'AbortError' })
    expect(await queued).toMatchObject({ message: expect.stringMatching(/interrupted.*retry/i) })
    await old.exited
    await expect(api.call('brep.count', {})).resolves.toEqual({ bodies: 0 })
    expect(workers).toHaveLength(2)
    const history: History = { version: 1, base: [], steps: [{ id: 'recovered-box', part: 0, transform: [...IDENTITY], params: {
      op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
      shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' },
    } }] }
    const saved = JSON.stringify(history)
    const operations: string[] = []
    clearReplayCache()
    const recovered = await replayHistory((op, request) => { operations.push(op); return api.call(op, request) }, { history: JSON.parse(saved) as History, exact: true })
    expect(recovered.status).toEqual([{ state: 'done' }])
    expect(operations).toEqual(['brep.extrude', 'brep.tessellate'])
    const positions = recovered.parts[0]!.positions
    for (const axis of [0, 1, 2]) {
      const values = positions.filter((_, index) => index % 3 === axis)
      expect(Math.max(...values) - Math.min(...values)).toBeCloseTo([20, 10, 5][axis]!, 6)
    }
    expect(JSON.stringify(history)).toBe(saved)
  } finally {
    clearReplayCache()
    endIdleGeomWorker()
    await Promise.all(workers.map((worker) => worker.thread.terminate()))
    setGeomProvider(null)
    vi.unstubAllGlobals()
  }
}, 20_000)

