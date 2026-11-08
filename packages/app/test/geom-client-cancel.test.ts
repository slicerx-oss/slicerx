// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Canceling any geometry call that is still running in the engine ends the shared worker, so the next call does not wait
// behind it: a synchronous engine call (a merged array can run for minutes) cannot read a cancel message. A canceled
// call that finishes on its own soon after, or that has not started yet, leaves the worker and what it keeps alone, and
// calls nobody canceled go on to the next worker rather than fail. geom-worker-loop.test.ts runs the worker's own loop.
import { Worker as Thread } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_GRACE_MS, endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'

// A stand-in for geom-worker.ts with its protocol: a call that can be canceled waits for the page's go, the worker says
// when a call starts, and `array` spins forever.
const BUSY_ENGINE = `
const { parentPort } = require('node:worker_threads')
const waiting = new Map()
parentPort.on('message', (m) => {
  if ('cancel' in m) return
  if ('skip' in m) return parentPort.postMessage({ id: m.skip, error: 'Canceled' })
  if (m.gate) {
    waiting.set(m.id, m)
    return parentPort.postMessage({ ready: m.id })
  }
  if ('go' in m) m = waiting.get(m.go)
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

type Posted = { id?: number; op?: string; request?: unknown; gate?: boolean; cancel?: number; go?: number; skip?: number }

class ManualWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: Posted[] = []
  postMessage(m: Posted) {
    this.posted.push(m)
  }
  calls() {
    return this.posted.filter((m) => m.op !== undefined)
  }
  /** The worker reaches call i: a call that can be canceled asks the page whether to run it. */
  ready(i: number) {
    this.onmessage?.({ data: { ready: this.calls()[i]!.id } } as MessageEvent)
  }
  start(i: number) {
    const m = this.calls()[i]!
    if (m.gate && !this.posted.some((p) => p.go === m.id)) this.ready(i)
    this.onmessage?.({ data: { started: m.id } } as MessageEvent)
  }
  answer(i: number) {
    const m = this.calls()[i]!
    this.onmessage?.({ data: { id: m.id, result: { op: m.op } } } as MessageEvent)
  }
  terminate = vi.fn()
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> => Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])

function manual(): ManualWorker[] {
  vi.useFakeTimers()
  const workers: ManualWorker[] = []
  vi.stubGlobal('Worker', function () {
    const w = new ManualWorker()
    workers.push(w)
    return w
  })
  return workers
}

const interrupted = { message: expect.stringMatching(/interrupted.*retry/i) }

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

  it('ends a worker stuck in a canceled array and sends the calls queued behind it to a fresh one', async () => {
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
      // queued behind the stuck call: the worker never reads them
      const first = api.call('measure', { n: 1 })
      const second = api.call('measure', { n: 2 })
      ctl.abort()
      expect(await array).toMatchObject({ name: 'AbortError' })
      expect(await within(first, CANCEL_GRACE_MS + 3000)).toEqual({ op: 'measure' })
      expect(await within(second, 3000)).toEqual({ op: 'measure' })
      expect(workers).toHaveLength(2)
    } finally {
      await Promise.all(workers.map((w) => w.thread.terminate()))
    }
  })

  it('keeps the worker when a canceled call finishes within the grace time', async () => {
    const workers = manual()
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

  it('skips a call canceled while it waited behind another, without ending the worker', async () => {
    const workers = manual()
    const api = geom()
    const ctl = new AbortController()
    const first = api.call('boolean', {})
    const array = api.call('array', {}, ctl.signal).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    ctl.abort()
    expect(await array).toMatchObject({ name: 'AbortError' })
    w.answer(0)
    await expect(first).resolves.toEqual({ op: 'boolean' })
    // the worker reaches the array only now, and the page tells it to skip it
    const id = w.calls()[1]!.id
    w.ready(1)
    expect(w.posted).toContainEqual({ skip: id })
    expect(w.posted.some((m) => m.go === id)).toBe(false)
    const third = api.call('measure', {})
    w.start(2)
    w.answer(2)
    await expect(third).resolves.toEqual({ op: 'measure' })
    vi.advanceTimersByTime(CANCEL_GRACE_MS * 2)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it('sends calls the ended worker never started to the next one', async () => {
    const workers = manual()
    const api = geom()
    const ctl = new AbortController()
    const preview = api.call('face.push.preview', {}, ctl.signal).catch((e: Error) => e)
    const queued = api.call('boolean', { a: 1 })
    const w = workers[0]!
    w.start(0)
    ctl.abort()
    expect(await preview).toMatchObject({ name: 'AbortError' })
    vi.advanceTimersByTime(CANCEL_GRACE_MS)
    expect(w.terminate).toHaveBeenCalledOnce()
    const fresh = workers[1]!
    expect(fresh.calls()).toEqual([{ id: w.calls()[1]!.id, op: 'boolean', request: { a: 1 } }])
    fresh.answer(0)
    await expect(queued).resolves.toEqual({ op: 'boolean' })
  })

  it('sends a call made during the grace time once, after the canceled call answers', async () => {
    const workers = manual()
    const api = geom()
    const ctl = new AbortController()
    void api.call('face.push.preview', {}, ctl.signal).catch(() => undefined)
    const w = workers[0]!
    w.start(0)
    ctl.abort()
    const next = api.call('measure', {})
    expect(w.calls()).toHaveLength(1)
    w.answer(0)
    expect(w.calls().map((c) => c.op)).toEqual(['face.push.preview', 'measure'])
    vi.advanceTimersByTime(CANCEL_GRACE_MS * 2)
    expect(w.calls()).toHaveLength(2)
    expect(w.terminate).not.toHaveBeenCalled()
    w.start(1)
    w.answer(1)
    await expect(next).resolves.toEqual({ op: 'measure' })
  })

  it('never sends a held call that was canceled', async () => {
    const workers = manual()
    const api = geom()
    const ctl = new AbortController()
    void api.call('face.push.preview', {}, ctl.signal).catch(() => undefined)
    const w = workers[0]!
    w.start(0)
    ctl.abort()
    const later = new AbortController()
    const held = api.call('measure', {}, later.signal).catch((e: Error) => e)
    later.abort()
    expect(await held).toMatchObject({ name: 'AbortError' })
    w.answer(0)
    vi.advanceTimersByTime(CANCEL_GRACE_MS * 2)
    expect(w.calls()).toHaveLength(1)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it('sends held calls to the next worker in order, once each, and fails the call that was running', async () => {
    const workers = manual()
    const api = geom()
    const running = api.call('boolean', {}).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    const ctl = new AbortController()
    void api.call('face.push.preview', {}, ctl.signal).catch(() => undefined)
    w.start(1)
    ctl.abort()
    const b = api.call('measure', { n: 1 })
    const c = api.call('measure', { n: 2 })
    expect(w.calls()).toHaveLength(2)
    vi.advanceTimersByTime(CANCEL_GRACE_MS)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await running).toMatchObject(interrupted)
    const fresh = workers[1]!
    expect(fresh.calls().map((m) => m.request)).toEqual([{ n: 1 }, { n: 2 }])
    fresh.answer(0)
    fresh.answer(1)
    await expect(b).resolves.toEqual({ op: 'measure' })
    await expect(c).resolves.toEqual({ op: 'measure' })
    expect(workers).toHaveLength(2)
  })

  it('waits for two overlapping canceled calls before it sends a held one', async () => {
    const workers = manual()
    const api = geom()
    const one = new AbortController()
    const two = new AbortController()
    void api.call('face.push.preview', {}, one.signal).catch(() => undefined)
    void api.call('face.push.preview', {}, two.signal).catch(() => undefined)
    const w = workers[0]!
    w.start(0)
    w.start(1)
    one.abort()
    two.abort()
    const held = api.call('measure', {})
    w.answer(0)
    expect(w.calls()).toHaveLength(2)
    w.answer(1)
    expect(w.calls().map((c) => c.op)).toEqual(['face.push.preview', 'face.push.preview', 'measure'])
    w.start(2)
    w.answer(2)
    await expect(held).resolves.toEqual({ op: 'measure' })
    vi.advanceTimersByTime(CANCEL_GRACE_MS * 2)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it('sends calls held behind a canceled replay on to the next worker', async () => {
    const workers = manual()
    const api = geom()
    const replay = new AbortController()
    void api.call('history.replay', {}, replay.signal).catch(() => undefined)
    const w = workers[0]!
    w.start(0)
    const preview = new AbortController()
    void api.call('face.push.preview', {}, preview.signal).catch(() => undefined)
    w.start(1)
    preview.abort()
    const next = api.call('measure', {})
    replay.abort()
    expect(w.terminate).toHaveBeenCalledOnce()
    const fresh = workers[1]!
    expect(fresh.calls().map((c) => c.op)).toEqual(['measure'])
    fresh.answer(0)
    await expect(next).resolves.toEqual({ op: 'measure' })
  })
})
