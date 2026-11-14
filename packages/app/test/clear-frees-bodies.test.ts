// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cleared plate frees the solids its designs' replays kept: exact replays on the B-rep kernel's wasm module, sent as
// the app sends them (history.replay) to a provider that runs them as the geometry worker and the native provider do,
// then the plate cleared. Before, every clear left the last design's bodies held, so the count went 5, 10, 15 over
// three designs; now each clear takes it back to 0 with no further replay. A replay running at the clear keeps its
// bodies until it ends, and keeps none after.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDENTITY, clearReplayCache, releaseReplayCache, replayHistory, type EngineCall, type History, type ReplayRequest, type Step, type StepParams } from '@slicerx/cad-history'
import init from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'
import { geom, setGeomProvider, type GeomProvider } from '../src/geom/client'
import { clearProject } from '../src/project/new'

const wasm = readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url))

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }

/** A block with a hole, a rounded edge and a cut, its width from `i`: four steps, five kept bodies. */
function design(i: number): History {
  return {
    version: 1,
    base: [],
    steps: [
      step('box', { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20 + i, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams),
      step('hole', { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 2, heightMm: 5 }], label: 'Hole' } as StepParams),
      step('round', { op: 'edge.fillet', edges: [{ a: [10 + i / 2, -5, 0], b: [10 + i / 2, -5, 5], face: [1, 0, 0] }], radiusMm: 1 }),
      step('cut', { op: 'plane.cut', plane: { point: [0, 0, 2], normal: [0, 0, 1] }, keep: 'both' } as StepParams),
    ],
  }
}

let live: () => number
let engine: EngineCall
/** Runs before each step of the next replay, when set. */
let beforeStep: (() => Promise<void>) | null = null

beforeEach(async () => {
  clearReplayCache()
  const kernel = brepModule(await init({ wasmBinary: wasm }))
  live = () => (kernel.call('count', {}) as { bodies: number }).bodies
  engine = async (op, r) => {
    if (!op.startsWith('brep.')) throw new Error(`no mesh engine here (${op})`)
    return kernel.call(op.slice('brep.'.length), r)
  }
  // replays and the release run where the bodies are kept, as the geometry worker and the native provider run them
  const provider: GeomProvider = {
    runsJobs: true,
    call: (async (op: string, request: unknown) => {
      if (op === 'history.replay') return replayHistory(engine, request as ReplayRequest, { keepsBodies: true, ...(beforeStep ? { yieldStep: beforeStep } : {}) })
      if (op === 'history.release') return releaseReplayCache(engine)
      return engine(op, request)
    }) as GeomProvider['call'],
  }
  setGeomProvider(provider)
})

afterEach(() => {
  beforeStep = null
  setGeomProvider(null)
  clearReplayCache()
})

/** An exact replay of `h`, sent as the app sends it. */
const replay = (h: History) => geom().call<{ status: { state: string }[] }>('history.replay', { history: h, exact: true })

it('frees the bodies of each design when the plate is cleared, with no further replay', async () => {
  expect(live()).toBe(0)
  for (const i of [0, 1, 2]) {
    const r = await replay(design(i))
    expect(r.status.every((s) => s.state === 'done')).toBe(true)
    // the design's bodies stay for its next edit
    expect(live()).toBe(5)
    clearProject()
    await vi.waitFor(() => expect(live()).toBe(0), { timeout: 2000 })
  }
}, 60_000)

it('keeps the bodies of a replay running at the clear until it ends, and none after', async () => {
  let reached!: () => void
  const atRound = new Promise<void>((r) => (reached = r))
  let go!: () => void
  const resume = new Promise<void>((r) => (go = r))
  let steps = 0
  beforeStep = async () => {
    // paused before its third step, with the first two steps' bodies made
    if (++steps === 3) {
      reached()
      await resume
    }
  }
  const running = replay(design(3))
  await atRound
  const made = live()
  expect(made).toBeGreaterThan(0)
  clearProject()
  // the release ran: nothing it could free was left, and the running replay's bodies are still there
  await new Promise((r) => setTimeout(r, 50))
  expect(live()).toBe(made)
  go()
  const r = await running
  expect(r.status.every((s) => s.state === 'done')).toBe(true)
  // it ended after the clear, so it kept nothing: every body it had is freed
  expect(live()).toBe(0)
}, 60_000)
