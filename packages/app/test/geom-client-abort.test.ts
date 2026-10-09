// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A geometry call lets go of its abort listener once answered: a signal that outlives the call (a fit check's lives
// until the plate changes) must not keep the call's closure, and the meshes it can reach, alive.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { geom, setGeomProvider } from '../src/geom/client'

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
  terminate() {}
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
