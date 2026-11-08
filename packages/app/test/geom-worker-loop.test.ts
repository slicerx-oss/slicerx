// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry worker's own message loop (worker-loop.ts, which geom-worker.ts runs) with the page's client, through a
// message channel: messages arrive in the order they were posted and only after the call that is running, as with a
// real worker. Its engine is a stand-in whose calls run synchronously.
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANCEL_GRACE_MS, endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'
import { workerLoop, type WorkerJobs, type WorkerMessage } from '../src/geom/worker-loop'

/** A stand-in engine: `slow` calls `hooks.slow` while it runs, `load` waits for `hooks.load` before it can run. */
function standIn() {
  const ran: string[] = []
  const hooks: { slow?: () => void; load?: Promise<void>; loading?: () => void; step?: (i: number) => void } = {}
  const jobs: WorkerJobs = {
    async prepare(op) {
      if (op === 'load') {
        hooks.loading?.()
        await hooks.load
      }
      return () => {
        ran.push(op)
        if (op === 'slow') hooks.slow?.()
        return { op }
      }
    },
    async replay(_request, yieldStep) {
      for (let i = 0; i < 5; i++) {
        await yieldStep()
        ran.push(`step ${i}`)
        hooks.step?.(i)
      }
      return { replayed: true }
    },
    memoryBytes: () => 0,
    transfer: () => [],
  }
  return { ran, hooks, jobs }
}

class LoopWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  /** What the loop posted, in order. */
  posted: Record<string, unknown>[] = []
  page: MessagePort
  loop: MessagePort
  constructor(jobs: WorkerJobs) {
    const { port1, port2 } = new MessageChannel()
    this.page = port1
    this.loop = port2
    const handle = workerLoop((m) => {
      this.posted.push(m as Record<string, unknown>)
      if (!this.terminated) port2.postMessage(m)
    }, jobs)
    port2.on('message', (m: WorkerMessage) => void handle(m))
    port1.on('message', (data: unknown) => {
      if (!this.terminated) this.onmessage?.({ data } as MessageEvent)
    })
  }
  postMessage(m: unknown) {
    if (!this.terminated) this.page.postMessage(m)
  }
  terminate() {
    this.terminated = true
    this.page.close()
    this.loop.close()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withLoop(jobs: WorkerJobs): LoopWorker[] {
  const workers: LoopWorker[] = []
  vi.stubGlobal('Worker', function () {
    const w = new LoopWorker(jobs)
    workers.push(w)
    return w
  })
  return workers
}

afterEach(() => {
  endIdleGeomWorker()
  vi.unstubAllGlobals()
  setGeomProvider(null)
})

describe('the geometry worker loop', () => {
  it('skips a call canceled while it waited behind a running one, and keeps the worker', async () => {
    const e = standIn()
    const workers = withLoop(e.jobs)
    const api = geom()
    const ctl = new AbortController()
    const slow = api.call('slow', {})
    const array = api.call('array', {}, ctl.signal).catch((err: Error) => err)
    // the person cancels the array while the slow call runs, so its cancel arrives after its request
    e.hooks.slow = () => ctl.abort()
    await expect(slow).resolves.toEqual({ op: 'slow' })
    expect(await array).toMatchObject({ name: 'AbortError' })
    await expect(api.call('measure', {})).resolves.toEqual({ op: 'measure' })
    await sleep(CANCEL_GRACE_MS + 200)
    expect(e.ran).toEqual(['slow', 'measure'])
    expect(workers[0]!.posted.filter((m) => 'started' in m)).toHaveLength(2)
    expect(workers).toHaveLength(1)
    expect(workers[0]!.terminated).toBe(false)
  })

  it('answers a call canceled while its engine build loads without running it, and keeps the worker', async () => {
    const e = standIn()
    const workers = withLoop(e.jobs)
    let release!: () => void
    e.hooks.load = new Promise<void>((r) => (release = r))
    const loading = new Promise<void>((r) => (e.hooks.loading = r))
    const api = geom()
    const ctl = new AbortController()
    const call = api.call('load', {}, ctl.signal).catch((err: Error) => err)
    await loading
    ctl.abort()
    expect(await call).toMatchObject({ name: 'AbortError' })
    await sleep(CANCEL_GRACE_MS + 200)
    expect(workers[0]!.terminated).toBe(false)
    release()
    await expect(api.call('measure', {})).resolves.toEqual({ op: 'measure' })
    expect(e.ran).toEqual(['measure'])
    // the load was the first call
    expect(workers[0]!.posted).not.toContainEqual({ started: 1 })
    expect(workers).toHaveLength(1)
  })

  it('says a call started before the engine runs it', async () => {
    const e = standIn()
    const workers = withLoop(e.jobs)
    let startedFirst = false
    e.hooks.slow = () => (startedFirst = workers[0]!.posted.some((m) => 'started' in m))
    await expect(geom().call('slow', {})).resolves.toEqual({ op: 'slow' })
    expect(startedFirst).toBe(true)
  })

  it('stops a canceled replay between its steps', async () => {
    const e = standIn()
    const posted: unknown[] = []
    const handle = workerLoop((m) => posted.push(m), e.jobs)
    e.hooks.step = (i) => {
      if (i === 1) void handle({ cancel: 1 })
    }
    await handle({ id: 1, op: 'history.replay', request: {} })
    expect(posted).toEqual([{ started: 1 }, { id: 1, error: 'Canceled', memoryBytes: 0 }])
    expect(e.ran).toEqual(['step 0', 'step 1'])
  })
})
