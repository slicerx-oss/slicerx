// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A geometry call lets go of its abort listener once answered: a signal that outlives the call (a fit check's lives
// until the plate changes) must not keep the call's closure, and the meshes it can reach, alive.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'

class EchoWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: { id: number; op: string }[] = []
  postMessage(m: { id: number; op: string; cancel?: number }) {
    if (m.cancel !== undefined) return
    this.posted.push(m)
  }
  answer(i = 0) {
    const m = this.posted[i]!
    this.onmessage?.({ data: { id: m.id, result: { op: m.op } } } as MessageEvent)
  }
  terminate = vi.fn()
}

function tracked(signal: AbortSignal): Set<unknown> {
  const live = new Set<unknown>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((t: string, f: EventListener, o?: AddEventListenerOptions) => (live.add(f), add(t, f, o))) as typeof signal.addEventListener
  signal.removeEventListener = ((t: string, f: EventListener) => (live.delete(f), remove(t, f))) as typeof signal.removeEventListener
  return live
}

afterEach(() => {
  endIdleGeomWorker()
  vi.unstubAllGlobals()
  setGeomProvider(null)
})

describe('geometry calls and their abort signal', () => {
  it('removes the listener once the call is answered, and an abort after that changes nothing', async () => {
    let w: EchoWorker | null = null
    vi.stubGlobal('Worker', function (this: unknown) {
      return (w = new EchoWorker())
    })
    setGeomProvider(null)
    const ctl = new AbortController()
    const live = tracked(ctl.signal)
    const answer = geom().call<{ op: string }>('fit.check', { mesh: new Float32Array(4) }, ctl.signal)
    expect(live.size).toBe(1)
    w!.answer()
    await expect(answer).resolves.toEqual({ op: 'fit.check' })
    expect(live.size).toBe(0)
    ctl.abort()
  })

  it('still cancels a call that is not answered yet', async () => {
    let w: EchoWorker | null = null
    vi.stubGlobal('Worker', function (this: unknown) {
      return (w = new EchoWorker())
    })
    setGeomProvider(null)
    const ctl = new AbortController()
    const answer = geom().call('fit.check', {}, ctl.signal)
    ctl.abort()
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    // A late answer is dropped.
    w!.answer()
  })
})


it('terminates a canceled replay, sends the calls it never started on, and restarts without stale replies', async () => {
  const workers: EchoWorker[] = []
  vi.stubGlobal('Worker', function () {
    const worker = new EchoWorker()
    workers.push(worker)
    return worker
  })
  setGeomProvider(null)
  const api = geom()
  const ctl = new AbortController()
  const live = tracked(ctl.signal)
  const replay = api.call('history.replay', { exact: true }, ctl.signal).catch((e: Error) => e)
  const queued = api.call('fit.check', {}).catch((e: Error) => e)
  const old = workers[0]!
  ctl.abort()
  expect(old.terminate).toHaveBeenCalledOnce()
  expect(await replay).toMatchObject({ name: 'AbortError' })
  expect(live.size).toBe(0)
  // the queued call never started in the ended worker, so the next one gets it
  const next = workers[1]!
  expect(next.posted.map((m) => m.op)).toEqual(['fit.check'])
  const fresh = api.call('history.replay', { exact: true })
  old.onerror?.({ message: 'stale failure' } as ErrorEvent)
  old.onmessage?.({ data: { id: next.posted[1]!.id, result: 'stale result' } } as MessageEvent)
  next.answer(0)
  next.answer(1)
  await expect(queued).resolves.toEqual({ op: 'fit.check' })
  await expect(fresh).resolves.toEqual({ op: 'history.replay' })
  expect(next.terminate).not.toHaveBeenCalled()
})

it('does not start a worker for an already canceled request', async () => {
  const make = vi.fn(function () { return new EchoWorker() })
  vi.stubGlobal('Worker', make)
  setGeomProvider(null)
  const ctl = new AbortController()
  ctl.abort()
  await expect(geom().call('history.replay', {}, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(make).not.toHaveBeenCalled()
})

it('terminates a failed worker and releases every affected abort listener', async () => {
  const worker = new EchoWorker()
  vi.stubGlobal('Worker', function () { return worker })
  setGeomProvider(null)
  const ctl = new AbortController()
  const live = tracked(ctl.signal)
  const answer = geom().call('history.replay', {}, ctl.signal).catch((e: Error) => e)
  worker.onerror?.({ message: 'kernel failed' } as ErrorEvent)
  expect(await answer).toMatchObject({ message: 'kernel failed' })
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(live.size).toBe(0)
})
