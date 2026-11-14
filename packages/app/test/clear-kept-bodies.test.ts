// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cleared plate frees the solids its designs' replays kept, wherever the replays ran: in the app's own geometry
// worker, in the native engine (useNativeEngine), and, with no geometry client loaded yet, nowhere (nothing was kept
// and nothing loads for the clear). The project code asks through cad/waiting.ts, so the app shell does not load the
// geometry client and the history code it brings (apps/web/scripts/bundle-size.mjs).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDENTITY, clearReplayCache, releaseReplayCache, replayHistory, type EngineCall, type History, type ReplayRequest, type Step, type StepParams } from '@slicerx/cad-history'
import init from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'
import { endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'
import { decodeFrame, encodeFrame, useNativeEngine, type NativeEngine } from '../src/geom/native-provider'
import { clearProject } from '../src/project/new'

const wasm = readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url))

const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** A block with a hole, two steps and two kept bodies. */
const design: History = {
  version: 1,
  base: [],
  steps: [
    { id: 'box', part: 0, transform: [...IDENTITY], params: { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams },
    { id: 'hole', part: 0, transform: [...IDENTITY], params: { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 2, heightMm: 5 }], label: 'Hole' } as StepParams },
  ] as Step[],
}

let live: () => number
let engine: EngineCall

beforeEach(async () => {
  clearReplayCache()
  const kernel = brepModule(await init({ wasmBinary: wasm }))
  live = () => (kernel.call('count', {}) as { bodies: number }).bodies
  engine = async (op, r) => {
    if (!op.startsWith('brep.')) throw new Error(`no mesh engine here (${op})`)
    return kernel.call(op.slice('brep.'.length), r)
  }
})

afterEach(() => {
  endIdleGeomWorker()
  setGeomProvider(null)
  vi.unstubAllGlobals()
  vi.doUnmock('../src/geom/client')
  clearReplayCache()
})

/** An exact replay of the design, sent as the app sends it, then the plate cleared: its bodies go with no other replay. */
async function replayThenClear(): Promise<void> {
  const r = await geom().call<{ status: { state: string }[] }>('history.replay', { history: design, exact: true })
  expect(r.status.every((s) => s.state === 'done')).toBe(true)
  expect(live()).toBeGreaterThan(0)
  clearProject()
  await vi.waitFor(() => expect(live()).toBe(0), { timeout: 2000 })
}

it("frees them in the app's own geometry worker", async () => {
  const ops: string[] = []
  // the worker's side of its messages (geom-worker.ts): replays keep their bodies in it, and the release frees them there
  class KernelWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage(m: { id: number; op: string; request: unknown }) {
      ops.push(m.op)
      const answer = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data } as MessageEvent))
      answer({ started: m.id })
      const run = m.op === 'history.replay' ? replayHistory(engine, m.request as ReplayRequest, { keepsBodies: true }) : m.op === 'history.release' ? releaseReplayCache(engine) : engine(m.op, m.request)
      void run.then(
        (result) => answer({ id: m.id, result }),
        (e: Error) => answer({ id: m.id, error: e.message }),
      )
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', KernelWorker)
  setGeomProvider(null)
  await replayThenClear()
  expect(ops).toEqual(['history.replay', 'history.release'])
}, 60_000)

it('frees them in the native engine', async () => {
  const ops: string[] = []
  // the engine's serve loop, in this process: each frame's call runs on the kernel and answers in a frame
  const native: NativeEngine = {
    async call(f) {
      const { answer: call } = decodeFrame(f)
      const op = call['op'] as string
      ops.push(op)
      const { meshOutput: _, ...request } = call['request'] as Record<string, unknown>
      try {
        return { generation: 1, frame: encodeFrame(JSON.stringify({ id: call['id'], result: await engine(op, request) }), []) }
      } catch (e) {
        return { generation: 1, frame: encodeFrame(JSON.stringify({ id: call['id'], error: (e as Error).message }), []) }
      }
    },
    async end() {},
  }
  useNativeEngine(native)
  await replayThenClear()
  expect(ops).toContain('brep.free')
}, 60_000)

it('frees nothing and loads no geometry client when none was loaded', async () => {
  vi.resetModules()
  let loaded = false
  vi.doMock('../src/geom/client', async (actual) => {
    loaded = true
    return actual()
  })
  const fresh = await import('../src/project/new')
  expect(() => fresh.clearProject()).not.toThrow()
  await new Promise((r) => setTimeout(r, 50))
  expect(loaded).toBe(false)
  expect(live()).toBe(0)
  // the check sees a load: importing the client is one
  await import('../src/geom/client')
  expect(loaded).toBe(true)
})
