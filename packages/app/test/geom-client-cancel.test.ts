// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Canceling any geometry call that is still running in the engine ends the shared worker, so the next call does not wait
// behind it: a synchronous engine call (a merged array can run for minutes) cannot read a cancel message. A canceled
// call that finishes on its own soon after, or that has not started yet, leaves the worker and what it keeps alone.
import { Worker as Thread } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_GRACE_MS, endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'

// A stand-in for geom-worker.ts with its protocol: it says when a call starts, and `array` spins forever.
const BUSY_ENGINE = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (m) => {
  if ('cancel' in m) return
  parentPort.postMessage({ started: m.id })
  if (m.op === 'array') for (;;) {}
  parentPort.postMessage({ id: m.id, result: { op: m.op } })
})
`

class ThreadWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  thread = new Thread(BUSY_ENGINE, { eval: true })
  started = new Set<number>()
  constructor() {
    this.thread.on('message', (data: { started?: number }) => {
      if (data.started !== undefined) this.started.add(data.started)
      this.onmessage?.({ data } as MessageEvent)
    })
    this.thread.on('error', (e) => this.onerror?.({ message: e.message } as ErrorEvent))
  }
  postMessage(m: unknown) {
    this.thread.postMessage(m)
  }
  terminate() {
    void this.thread.terminate()
  }
}

class ManualWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: { id?: number; op?: string; cancel?: number }[] = []
  postMessage(m: { id?: number; op?: string; cancel?: number }) {
    this.posted.push(m)
  }
  calls() {
    return this.posted.filter((m) => m.op !== undefined)
  }
  start(i: number) {
    this.onmessage?.({ data: { started: this.calls()[i]!.id } } as MessageEvent)
  }
  answer(i: number) {
    const m = this.calls()[i]!
    this.onmessage?.({ data: { id: m.id, result: { op: m.op } } } as MessageEvent)
  }
  terminate = vi.fn()
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> => Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])

afterEach(() => {
  endIdleGeomWorker()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setGeomProvider(null)
})

describe('canceling a geometry call', () => {
  it('ends a worker stuck in a canceled array, so the next call gets a fresh one', async () => {
    const workers: ThreadWorker[] = []
    vi.stubGlobal('Worker', function () {
      const w = new ThreadWorker()
      workers.push(w)
      return w
    })
    try {
      const api = geom()
      const ctl = new AbortController()
      const array = api.call('array', { merge: true }, ctl.signal).catch((e: Error) => e)
      await vi.waitFor(() => expect(workers[0]?.started.size).toBe(1))
      ctl.abort()
      expect(await array).toMatchObject({ name: 'AbortError' })
      expect(await within(api.call('measure', {}), CANCEL_GRACE_MS + 3000)).toEqual({ op: 'measure' })
      expect(workers).toHaveLength(2)
    } finally {
      await Promise.all(workers.map((w) => w.thread.terminate()))
    }
  })

  it('keeps the worker when a canceled call finishes within the grace time', async () => {
    vi.useFakeTimers()
    const workers: ManualWorker[] = []
    vi.stubGlobal('Worker', function () {
      const w = new ManualWorker()
      workers.push(w)
      return w
    })
    const api = geom()
    const ctl = new AbortController()
    const preview = api.call('face.push.preview', {}, ctl.signal).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    ctl.abort()
    expect(await preview).toMatchObject({ name: 'AbortError' })
    expect(w.posted).toContainEqual({ cancel: w.calls()[0]!.id })
    w.answer(0)
    vi.advanceTimersByTime(CANCEL_GRACE_MS * 2)
    expect(w.terminate).not.toHaveBeenCalled()
    const next = api.call('measure', {})
    w.start(1)
    w.answer(1)
    await expect(next).resolves.toEqual({ op: 'measure' })
    expect(workers).toHaveLength(1)
  })

  it('waits for a canceled call queued behind another to start before it ends the worker, and fails the others plainly', async () => {
    vi.useFakeTimers()
    const workers: ManualWorker[] = []
    vi.stubGlobal('Worker', function () {
      const w = new ManualWorker()
      workers.push(w)
      return w
    })
    const api = geom()
    const ctl = new AbortController()
    const first = api.call('boolean', {})
    const array = api.call('array', {}, ctl.signal).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    ctl.abort()
    expect(await array).toMatchObject({ name: 'AbortError' })
    vi.advanceTimersByTime(CANCEL_GRACE_MS * 2)
    expect(w.terminate).not.toHaveBeenCalled()
    w.answer(0)
    await expect(first).resolves.toEqual({ op: 'boolean' })
    const third = api.call('measure', {}).catch((e: Error) => e)
    w.start(1)
    vi.advanceTimersByTime(CANCEL_GRACE_MS - 1)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await third).toMatchObject({ message: expect.stringMatching(/interrupted.*retry/i) })
    const fresh = api.call('measure', {})
    workers[1]!.answer(0)
    await expect(fresh).resolves.toEqual({ op: 'measure' })
  })
})
