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
import type { StepParams } from '@slicerx/cad-history'
import { geomOpClass, geomStepName, type GeomOpClass } from '@slicerx/contracts/geom-limits'

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

  it("stops a replay step's limit while another call runs, and goes on with what was left after it ends", async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const replay = api.call('history.replay', {}).catch((e: Error) => e)
    const other = api.call('repair', {})
    const w = workers[0]!
    w.start(0)
    const id = w.calls()[0]!.id
    w.send({ step: id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    vi.advanceTimersByTime(600)
    // the worker runs the repair while the replay's step waits (a load inside it)
    w.start(1)
    vi.advanceTimersByTime(900)
    expect(w.terminate).not.toHaveBeenCalled()
    w.answer(1)
    await expect(other).resolves.toEqual({ op: 'repair' })
    // 400 ms of the step's limit were left, with no further word from the worker
    vi.advanceTimersByTime(399)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await replay).toMatchObject({ message: 'The step "Fillet 2 mm" ran past its 1 s limit and was stopped; try a smaller version: fewer copies or a simpler part' })
  })

  it("never gives a replay step more than its whole limit when the clock is set back while it runs", async () => {
    const workers = manual()
    setGeomCallLimit((op) => (op === 'repair' ? 60_000 : 1000))
    const api = geom()
    const replay = api.call('history.replay', {}).catch((e: Error) => e)
    const other = api.call('repair', {})
    const w = workers[0]!
    w.start(0)
    const id = w.calls()[0]!.id
    w.send({ step: id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    vi.advanceTimersByTime(300)
    // the computer's clock goes back an hour, then another call stops the step's limit
    vi.setSystemTime(Date.now() - 3_600_000)
    w.start(1)
    w.answer(1)
    await expect(other).resolves.toEqual({ op: 'repair' })
    vi.advanceTimersByTime(999)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await replay).toMatchObject({ message: expect.stringMatching(/^The step "Fillet 2 mm" ran past its 1 s limit/) })
  })

  it('starts a replay limit only once a call already running ends', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const other = api.call('repair', {})
    const replay = api.call('history.replay', {}).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    w.start(1)
    w.send({ step: w.calls()[1]!.id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    vi.advanceTimersByTime(900)
    w.answer(0)
    await expect(other).resolves.toEqual({ op: 'repair' })
    vi.advanceTimersByTime(999)
    expect(w.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await replay).toMatchObject({ message: expect.stringMatching(/^The step "Fillet 2 mm" ran past its 1 s limit/) })
  })

  it('leaves no timer behind when a replay ends while another call runs', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const replay = api.call('history.replay', {})
    const other = api.call('repair', {})
    const w = workers[0]!
    w.start(0)
    w.send({ step: w.calls()[0]!.id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    w.start(1)
    w.answer(0)
    await expect(replay).resolves.toEqual({ op: 'history.replay' })
    w.answer(1)
    await expect(other).resolves.toEqual({ op: 'repair' })
    // only the idle timer that ends an unused worker is left
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it("keeps a replay's limit off between its steps, while another replay's step runs", async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const first = api.call('history.replay', { n: 1 })
    const second = api.call('history.replay', { n: 2 })
    const w = workers[0]!
    const [a, b] = [w.calls()[0]!.id, w.calls()[1]!.id]
    w.start(0)
    w.send({ step: a, op: 'edge.fillet', name: 'Fillet 2 mm' })
    vi.advanceTimersByTime(500)
    // the first replay waits between its steps; the second one's step runs meanwhile
    w.send({ yielded: a })
    w.start(1)
    w.send({ step: b, op: 'edge.chamfer', name: 'Chamfer 1 mm' })
    vi.advanceTimersByTime(900)
    w.answer(1)
    await expect(second).resolves.toEqual({ op: 'history.replay' })
    vi.advanceTimersByTime(900)
    expect(w.terminate).not.toHaveBeenCalled()
    // its next step gets a whole limit
    w.send({ step: a, op: 'face.push', name: 'Pull 5 mm' })
    vi.advanceTimersByTime(999)
    w.answer(0)
    await expect(first).resolves.toEqual({ op: 'history.replay' })
    vi.advanceTimersByTime(5000)
    expect(w.terminate).not.toHaveBeenCalled()
  })

  it('refuses a replay that is stopped again after it was sent on, without sending it a third time', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const replay = api.call('history.replay', {}).catch((e: Error) => e)
    const stuck = api.call('array', {}).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    w.start(1)
    vi.advanceTimersByTime(1000)
    expect(await stuck).toMatchObject({ message: expect.stringMatching(/^The step "Array"/) })
    const fresh = workers[1]!
    fresh.start(0)
    fresh.send({ step: fresh.calls()[0]!.id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    vi.advanceTimersByTime(1000)
    expect(fresh.terminate).toHaveBeenCalledOnce()
    expect(await replay).toMatchObject({ message: expect.stringMatching(/^The step "Fillet 2 mm" ran past its 1 s limit/) })
    expect(workers).toHaveLength(2)
  })

  it('sends a replay to a fresh worker from its start when another call there is stopped', async () => {
    const workers = manual()
    setGeomCallLimit(() => 1000)
    const api = geom()
    const replay = api.call('history.replay', { steps: 3 })
    const stuck = api.call('array', {}).catch((e: Error) => e)
    const w = workers[0]!
    w.start(0)
    w.send({ step: w.calls()[0]!.id, op: 'edge.fillet', name: 'Fillet 2 mm' })
    w.start(1)
    vi.advanceTimersByTime(1000)
    expect(w.terminate).toHaveBeenCalledOnce()
    expect(await stuck).toMatchObject({ message: expect.stringMatching(/^The step "Array" ran past its 1 s limit/) })
    const fresh = workers[1]!
    expect(fresh.calls().map((c) => [c.op, c.request])).toEqual([['history.replay', { steps: 3 }]])
    fresh.start(0)
    vi.advanceTimersByTime(999)
    fresh.answer(0)
    await expect(replay).resolves.toEqual({ op: 'history.replay' })
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

  it('gives every history step operation the class chosen for it, and a name', () => {
    const HISTORY: Record<StepParams['op'], GeomOpClass> = {
      'array.merged': 'model',
      boolean: 'model',
      'edge.chamfer': 'model',
      'edge.fillet': 'model',
      'face.push': 'model',
      'hole.apply': 'model',
      hollow: 'mesh',
      mirror: 'model',
      paint: 'mesh',
      'parts.add': 'model',
      'parts.order': 'model',
      'parts.slot': 'model',
      pattern: 'model',
      'plane.cut': 'mesh',
      repair: 'mesh',
      'shape.extrude': 'model',
      shell: 'model',
      simplify: 'mesh',
      'sketch.loft': 'model',
      'sketch.revolve': 'model',
      'sketch.sweep': 'model',
      split: 'mesh',
      subtract: 'model',
      'thread.apply': 'model',
    }
    for (const [op, cls] of Object.entries(HISTORY)) {
      expect([op, geomOpClass(op)]).toEqual([op, cls])
      expect([op, geomStepName(op)]).toEqual([op, expect.any(String)])
    }
  })
})
