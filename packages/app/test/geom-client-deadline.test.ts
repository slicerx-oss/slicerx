// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every geometry call has a time limit once the engine starts it (@slicerx/contracts geom-limits.ts). A call still
// running at its limit ends the shared worker, the calls queued behind it go to a fresh one, and the call itself is
// refused with which step it was and a smaller version to try; it is never sent again. A replay's limit counts from
// each of its steps, and a call in a worker of its own (soloCall) has one too. geom-client-cancel.test.ts covers the
// same worker ending on a cancel.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { endIdleGeomWorker, geom, setGeomCallLimit, setGeomProvider, soloCall } from '../src/geom/client'
import { busyWorkers } from './geom-busy-engine'

type Posted = { id?: number; op?: string; request?: unknown; gate?: boolean }

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
  send(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
  start(i: number) {
    this.send({ started: this.calls()[i]!.id })
  }
  answer(i: number) {
    const m = this.calls()[i]!
    this.send({ id: m.id, result: { op: m.op } })
  }
  terminate = vi.fn()
}

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

/** The answer, or what it failed with, or 'still waiting' after `ms` of real time. */
const within = <T,>(p: Promise<T>, ms: number): Promise<T | Error | 'still waiting'> =>
  Promise.race([p.catch((e: Error) => e), new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])

const STUCK = /^The step "Array" ran past its 0\.4 s limit and was stopped; try a smaller version: fewer copies or a simpler part$/

afterEach(() => {
  endIdleGeomWorker()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setGeomProvider(null)
  setGeomCallLimit(null)
})

describe('a geometry call past its time limit', () => {
  it('is refused within its limit, and the calls queued behind it finish on a fresh worker', async () => {
    const { workers, end } = busyWorkers()
    setGeomCallLimit((op) => (op === 'array' ? 400 : 60_000))
    try {
      const api = geom()
      const t = performance.now()
      const array = api.call('array', { merge: true })
      // queued behind the stuck call: the worker never reads them
      const first = api.call('measure', { n: 1 })
      const second = api.call('measure', { n: 2 }, new AbortController().signal)
      const refused = await within(array, 5000)
      expect(refused).toBeInstanceOf(Error)
      expect((refused as Error).message).toMatch(STUCK)
      // a loose bound: the worker's start and stop are in it too
      expect(performance.now() - t).toBeGreaterThanOrEqual(400)
      expect(performance.now() - t).toBeLessThan(5000)
      expect(await within(first, 3000)).toEqual({ op: 'measure' })
      expect(await within(second, 3000)).toEqual({ op: 'measure' })
      expect(workers).toHaveLength(2)
      // the stuck call is never sent again
      expect(workers.flatMap((w) => w.ops).filter((op) => op === 'array')).toHaveLength(1)
    } finally {
      await end()
    }
  })

  it('counts from when the engine starts the call, so a call queued behind a long one is not refused for waiting', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const long = api.call('array', { merge: true })
    const queued = api.call('boolean', {})
    const w = workers[0]!
    w.start(0)
    vi.advanceTimersByTime(999)
    // a long legitimate call that answers inside its limit keeps its worker
    w.answer(0)
    await expect(long).resolves.toEqual({ op: 'array' })
    w.start(1)
    vi.advanceTimersByTime(999)
    expect(w.terminate).not.toHaveBeenCalled()
    w.answer(1)
    await expect(queued).resolves.toEqual({ op: 'boolean' })
    vi.advanceTimersByTime(5000)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it('ends the worker at the limit and fails nothing else that was running', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const stuck = api.call('boolean', {}).catch((e: Error) => e)
    const next = api.call('measure', {})
    const w = workers[0]!
    w.start(0)
    vi.advanceTimersByTime(1000)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await stuck).toMatchObject({ message: 'The step "Join" ran past its 1 s limit and was stopped; try a smaller version: fewer copies or a simpler part' })
    const fresh = workers[1]!
    expect(fresh.calls().map((c) => c.op)).toEqual(['measure'])
    fresh.answer(0)
    await expect(next).resolves.toEqual({ op: 'measure' })
  })

  it('gives each step of a replay its own limit', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const replay = api.call('history.replay', {}).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    const id = w.calls()[0]!.id
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900)
      w.send({ step: id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    }
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await replay).toMatchObject({ message: 'The step "Fillet 2 mm" ran past its 1 s limit and was stopped; try a smaller version: fewer copies or a simpler part' })
    // a replay past its limit is not run again on the next worker
    expect(workers).toHaveLength(1)
  })

  it('leaves a canceled call to the cancel path', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const ctl = new AbortController()
    const preview = api.call('face.push.preview', {}, ctl.signal).catch((e: Error) => e)
    const w = workers[0]!
    w.send({ ready: w.calls()[0]!.id })
    w.start(0)
    ctl.abort()
    expect(await preview).toMatchObject({ name: 'AbortError' })
    w.answer(0)
    vi.advanceTimersByTime(5000)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it('ends a call in a worker of its own at its limit', async () => {
    const workers = manual()
    setGeomCallLimit((op) => (op === 'layers.plan' ? 2000 : 60_000))
    const { answer } = soloCall('layers.plan', {})
    const refused = answer.catch((e: Error) => e)
    const w = workers[0]!
    w.send({ started: 1 })
    vi.advanceTimersByTime(1999)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await refused).toMatchObject({ message: 'The step "Layer plan" ran past its 2 s limit and was stopped; try a smaller version: a coarser mesh' })
  })

  it('gives a replay step the limit of its own class', async () => {
    const workers = manual()
    const api = geom()
    const replay = api.call('history.replay', {}).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    w.send({ step: w.calls()[0]!.id, op: 'simplify', name: 'Simplify to 25 %' })
    vi.advanceTimersByTime(180_001)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300_000 - 180_001)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await replay).toMatchObject({ message: 'The step "Simplify to 25 %" ran past its 5 min limit and was stopped; try a smaller version: a coarser mesh' })
  })

  it('stops a quick call at 30 s and lets a model call run 179 s, with the default limits', async () => {
    const workers = manual()
    const api = geom()
    const join = api.call('boolean', {})
    const w = workers[0]!
    w.start(0)
    vi.advanceTimersByTime(179_000)
    w.answer(0)
    await expect(join).resolves.toEqual({ op: 'boolean' })
    const measure = api.call('measure', {}).catch((e: Error) => e)
    w.start(1)
    vi.advanceTimersByTime(29_999)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await measure).toMatchObject({ message: 'The step "Measure" took too long (over its 30 s limit) and was stopped; try it again' })
  })
})
