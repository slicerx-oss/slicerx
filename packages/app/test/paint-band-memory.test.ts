// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A thin height band splits each triangle it crosses into thousands of painted pieces. Its preview picture once kept
// every piece at once, so one band preview grew the engine's WebAssembly memory past BIG_BYTES, and the app's worker
// then ended 2 s after every answer: each later edit started a new worker that replayed the whole design. The picture
// now draws each piece as it reads it, so the worker stays under the line and the next edit finds it, with the design's
// replay cache, still there. Runs on the live engine only: a recorded reply has no memory to measure.
import { afterEach, expect, it, vi } from 'vitest'
import { liveEngine, wasmGeom } from './geom-engine'

/** A cylinder 80 mm across and 20 mm tall, its side in `n` tall strips of two triangles: every one crosses the band. */
function cylinder(n: number) {
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    positions.push(40 * Math.cos(a), 40 * Math.sin(a), 0, 40 * Math.cos(a), 40 * Math.sin(a), 20)
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    indices.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1)
  }
  return { positions, indices }
}

/** The paint and picture requests of a preview of the band 7.85 to 8.15 mm on the cylinder. */
const band = { kind: 'height', from: 7.85, to: 8.15 }

type Engine = Awaited<ReturnType<typeof wasmGeom>>

/** The app's shared worker, its engine the live module in this thread: it answers each call with the module's memory. */
function workerOn(engine: Engine) {
  const made: { terminate: ReturnType<typeof vi.fn> }[] = []
  class EngineWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    terminate = vi.fn()
    constructor() {
      made.push(this)
    }
    postMessage(m: { id?: number; op?: string; request?: unknown }) {
      if (m.id === undefined || m.op === undefined) return
      const { id, op, request } = m
      void (async () => {
        this.onmessage?.({ data: { started: id } } as MessageEvent)
        try {
          const result = await engine.call(op, request)
          this.onmessage?.({ data: { id, result, memoryBytes: engine.memoryBytes() } } as MessageEvent)
        } catch (e) {
          this.onmessage?.({ data: { id, error: (e as Error).message, memoryBytes: engine.memoryBytes() } } as MessageEvent)
        }
      })()
    }
  }
  return { EngineWorker, made }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it.skipIf(!liveEngine)('a thin band preview keeps the engine under BIG_BYTES, and the worker for the next edit', async () => {
  const engine = await wasmGeom()
  vi.useFakeTimers()
  const { EngineWorker, made } = workerOn(engine)
  vi.stubGlobal('Worker', EngineWorker)
  const { BIG_BYTES, BIG_IDLE_MS, IDLE_MS, geom, setGeomProvider } = await import('../src/geom/client')
  setGeomProvider(null)
  // 4000 strips: the picture once held about 300 MB of pieces for it
  const mesh = cylinder(4000)
  const picked = await geom().call<{ changed: Record<string, string>; changedTriangles: number }>('paint.select', { mesh, paint: {}, target: band, state: 1 })
  expect(picked.changedTriangles).toBe(8000)
  await geom().call('render', { objects: [{ mesh, paint: picked.changed, slot: 2 }], view: 'fit', image: false })
  expect(engine.memoryBytes()).toBeLessThan(BIG_BYTES)
  // past the big worker's idle time: the worker that drew the preview is still there for the edit after it
  vi.advanceTimersByTime(BIG_IDLE_MS + 1)
  expect(made[0]!.terminate).not.toHaveBeenCalled()
  await geom().call('paint.select', { mesh, paint: picked.changed, target: { kind: 'part' }, state: 2 })
  expect(made).toHaveLength(1)
  // a worker nobody calls still ends after its idle time
  await geom().call('render', { objects: [{ mesh, slot: 2 }], view: 'iso', image: false })
  vi.advanceTimersByTime(IDLE_MS + 1)
  expect(made[0]!.terminate).toHaveBeenCalledOnce()
})
