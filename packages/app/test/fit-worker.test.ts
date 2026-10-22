// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check runs in a worker of its own (geom/fit-client.ts). The engine runs a check synchronously, so a canceled
// check must not hold up the next geometry call: its worker ends, and the shared worker never ran it.
import { Worker as Thread } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import type { GeomMesh } from '../src/geom/client'

const arrays = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) })
// the app's worker takes typed arrays as they are (fit-run.ts, fitMesh)
const item = () => ({ mesh: arrays() as unknown as GeomMesh })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('frees the engine within 1 s of a canceled fit check that would run for 5 s', async () => {
  const threads: Thread[] = []
  let started: () => void = () => undefined
  class ThreadWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    thread = new Thread(new URL('./fixtures/fit-busy-worker.mjs', import.meta.url))
    constructor() {
      threads.push(this.thread)
      this.thread.on('message', (data: { started?: boolean }) => (data.started ? started() : this.onmessage?.({ data } as MessageEvent)))
    }
    postMessage(message: unknown) {
      this.thread.postMessage(message)
    }
    terminate() {
      void this.thread.terminate()
    }
  }
  vi.stubGlobal('Worker', ThreadWorker)
  const { fitCheck } = await import('../src/geom/cad')
  const { endIdleGeomWorker, geom, setGeomProvider } = await import('../src/geom/client')
  setGeomProvider(null)
  try {
    await geom().call('measure', {})
    const ctl = new AbortController()
    const running = new Promise<void>((resolve) => (started = resolve))
    // the stand-in engine checks for minGapMm seconds
    const check = fitCheck([item(), item()], { minGapMm: 5 }, ctl.signal).catch((e: Error) => e)
    await running
    ctl.abort()
    expect(await check).toMatchObject({ name: 'AbortError' })
    let from = performance.now()
    await expect(geom().call('measure', {})).resolves.toEqual({ op: 'measure' })
    expect(performance.now() - from).toBeLessThan(1000)
    from = performance.now()
    await expect(fitCheck([item(), item()], { minGapMm: 0 })).resolves.toMatchObject({ pieces: 0 })
    expect(performance.now() - from).toBeLessThan(1000)
  } finally {
    endIdleGeomWorker()
    setGeomProvider(null)
    await Promise.all(threads.map((t) => t.terminate()))
  }
}, 20_000)

class FitStub {
  static made: FitStub[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: Record<string, unknown>[] = []
  terminate = vi.fn()
  constructor() {
    FitStub.made.push(this)
  }
  postMessage(m: Record<string, unknown>) {
    this.posted.push(m)
  }
  /** Answers the last check posted. */
  answer(memoryBytes = 0) {
    const m = this.posted.filter((p) => 'id' in p).at(-1)!
    this.onmessage?.({ data: { id: m['id'], result: {}, memoryBytes } } as MessageEvent)
  }
  last(): Record<string, unknown> {
    return (this.posted.filter((p) => 'id' in p).at(-1)!['request'] as { mesh: Record<string, unknown> }).mesh
  }
}

it('sends a mesh once, names it by key after that, and sends it again once the plate dropped it', async () => {
  FitStub.made = []
  vi.stubGlobal('Worker', FitStub)
  const { fitCall, keepFitMeshes } = await import('../src/geom/fit-client')
  const m = arrays()
  const first = fitCall({ mesh: m })
  const w = FitStub.made[0]!
  expect(w.posted[0]).toEqual({ start: null })
  expect(w.last()).toMatchObject({ meshKey: 1, positions: m.positions })
  w.answer()
  await first
  const again = fitCall({ mesh: m })
  expect(w.last()).toEqual({ meshKey: 1 })
  w.answer()
  await again
  keepFitMeshes([])
  expect(w.posted.at(-1)).toEqual({ keep: [] })
  const sent = fitCall({ mesh: m })
  expect(w.last()).toMatchObject({ meshKey: 1, positions: m.positions })
  w.answer()
  await sent
  expect(FitStub.made).toHaveLength(1)
})

it('ends like the shared worker when idle, and starts the next one from the module the first compiled', async () => {
  FitStub.made = []
  vi.useFakeTimers()
  vi.stubGlobal('Worker', FitStub)
  const { BIG_BYTES, BIG_IDLE_MS, IDLE_MS } = await import('../src/geom/client')
  const { fitCall } = await import('../src/geom/fit-client')
  const compiled = { compiled: true }
  const m = arrays()
  const small = fitCall({ mesh: m })
  const w = FitStub.made[0]!
  w.onmessage?.({ data: { module: compiled } } as MessageEvent)
  w.answer(1024)
  await small
  vi.advanceTimersByTime(BIG_IDLE_MS + 1)
  expect(w.terminate).not.toHaveBeenCalled()
  const big = fitCall({ mesh: m })
  w.answer(BIG_BYTES + 1)
  await big
  vi.advanceTimersByTime(BIG_IDLE_MS - 1)
  expect(w.terminate).not.toHaveBeenCalled()
  vi.advanceTimersByTime(2)
  expect(w.terminate).toHaveBeenCalledOnce()
  const next = fitCall({ mesh: m })
  const fresh = FitStub.made[1]!
  expect(fresh.posted[0]).toEqual({ start: compiled })
  // the new worker has none of the old one's meshes
  expect(fresh.last()).toMatchObject({ meshKey: 1, positions: m.positions })
  fresh.answer(1024)
  await next
  vi.advanceTimersByTime(IDLE_MS + 1)
  expect(fresh.terminate).toHaveBeenCalledOnce()
})
