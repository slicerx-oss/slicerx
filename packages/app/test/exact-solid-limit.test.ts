// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The largest solid a part keeps is the engine's when it gives one (exact.ops answers `maxSolidText`), and
// MAX_SOLID_TEXT when it does not. A solid past it says so with the size and the limit (solidTooBig), whether the
// replay found it too big itself or the engine refused it (an error reply with `tooBig: { size, limit }`, which the
// page's geometry client and the worker carry on the Error). An older engine's refusal, with no size and limit,
// keeps its own sentence. exact-solid-cap.test.ts covers the limit itself.
import { MessageChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXACT_FELL_BACK, EXACT_OPS, IDENTITY, MAX_SOLID_TEXT, clearReplayCache, replayHistory, solidTooBig, tooBigOf, withTooBig, type History, type Step, type StepParams } from '@slicerx/cad-history'
import { endIdleGeomWorker, geom, setGeomProvider } from '../src/geom/client'
import { workerLoop, type WorkerJobs, type WorkerMessage } from '../src/geom/worker-loop'

const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
const faces = { faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
const OLD_SENTENCE = 'brep: the body is too big for the kernel'

/**
 * An engine whose cut makes a solid text `chars` long, or refuses the cut (`refuse`: with a size and limit, or as an
 * older engine does, with its sentence alone). `limit` is its answer's maxSolidText; `keeps` whether it holds bodies.
 */
function engine(o: { chars?: number; limit?: unknown; refuse?: 'tooBig' | 'old'; keeps?: boolean } = {}) {
  const ops: string[] = []
  let n = 2 ** 31
  const call = async (op: string, request: unknown) => {
    ops.push(op)
    const req = request as Record<string, unknown>
    if (op === EXACT_OPS) return { ops: [], ...(o.limit !== undefined ? { maxSolidText: o.limit } : {}) }
    if (op === 'brep.tessellate') return { ...tri, ...faces }
    if (op === 'brep.subtract' && o.refuse) {
      const error = new Error(OLD_SENTENCE)
      throw o.refuse === 'tooBig' ? withTooBig(error, { error: OLD_SENTENCE, tooBig: { size: 9_000_000, limit: 5_000_000 } }) : error
    }
    if (op.startsWith('brep.') && o.keeps && req['withKeys']) return { body: n++, bodyKeys: [77] }
    if (op === 'brep.subtract') return { bodySmb: 'x'.repeat(o.chars ?? 10) }
    if (op.startsWith('brep.')) return { bodySmb: `${op}-solid` }
    return { mesh: { ...tri, positions: [1, 0, 0, 10, 0, 0, 0, 10, 0] }, removedVolumeMm3: 1 }
  }
  return { call, ops }
}

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const box = step('box', { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } })
const hole = (id: string) => step(id, { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams)
const history = (exact?: true): History => ({ version: 1, base: [], steps: [box, hole('hole-1'), hole('hole-2')], ...(exact ? { exact } : {}) })
const kept = { keepsBodies: true }

beforeEach(() => clearReplayCache())

describe('the limit', () => {
  it("is the engine's when exact.ops gives one", async () => {
    const at = engine({ chars: 1000, limit: 1000 })
    const r = await replayHistory(at.call, { history: history(), exact: true })
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done' }])
    expect(at.ops.filter((o) => o === EXACT_OPS)).toHaveLength(1)
    clearReplayCache()
    const past = await replayHistory(engine({ chars: 1001, limit: 1000 }).call, { history: history(), exact: true })
    expect(past.status[1]).toEqual({ state: 'done', note: solidTooBig(1001, false, 1000) })
    expect(solidTooBig(1001, false, 1000)).toContain('(Size 0.001001 million, limit 0.001 million.)')
    clearReplayCache()
    const strict = await replayHistory(engine({ chars: 1001, limit: 1000 }).call, { history: history(true) })
    expect(strict.status[1]).toEqual({ state: 'broken', message: solidTooBig(1001, true, 1000) })
  })

  it('is MAX_SOLID_TEXT when the engine gives none, or none that is a size', async () => {
    for (const limit of [undefined, 'big', 0, 1.5]) {
      clearReplayCache()
      const r = await replayHistory(engine({ chars: MAX_SOLID_TEXT + 1, limit }).call, { history: history(), exact: true })
      expect(r.status[1]).toEqual({ state: 'done', note: solidTooBig(MAX_SOLID_TEXT + 1, false) })
    }
  })
})

describe("the engine's refusal", () => {
  it('with a size and limit, says them on the step, and the part is built as a mesh from there', async () => {
    const e = engine({ refuse: 'tooBig', keeps: true })
    const r = await replayHistory(e.call, { history: history(), exact: true }, kept)
    expect(r.status[1]).toEqual({ state: 'done', note: solidTooBig(9_000_000, false, 5_000_000) })
    expect(r.exactFellBack).toEqual(['hole-1'])
    expect(e.ops).toContain('subtract')
  })

  it('with a size and limit, stops a design that must stay exact with the same sentence', async () => {
    const r = await replayHistory(engine({ refuse: 'tooBig', keeps: true }).call, { history: history(true) }, kept)
    expect(r.status[1]).toEqual({ state: 'broken', message: solidTooBig(9_000_000, true, 5_000_000) })
    expect(r.status[2]).toEqual({ state: 'skipped' })
  })

  it("from an older engine, with no size and limit, keeps the engine's sentence", async () => {
    const r = await replayHistory(engine({ refuse: 'old', keeps: true }).call, { history: history(), exact: true }, kept)
    expect(r.status[1]).toEqual({ state: 'done', note: EXACT_FELL_BACK })
    clearReplayCache()
    const strict = await replayHistory(engine({ refuse: 'old', keeps: true }).call, { history: history(true) }, kept)
    expect(strict.status[1]).toEqual({ state: 'broken', message: `Exact operation failed: ${OLD_SENTENCE}` })
  })
})

describe("the engine's refusal of an exact loft", () => {
  /** An engine that makes exact lofts, and refuses this one's body as too big (with a size and limit, or not). */
  const lofts = (tooBig: boolean) => {
    const sent: { op: string; exact: unknown }[] = []
    const call = async (op: string, request: unknown) => {
      const req = request as Record<string, unknown>
      sent.push({ op, exact: req['exact'] })
      if (op === EXACT_OPS) return { ops: ['sketch.loft'] }
      if (op === 'sketch.loft' && req['exact'] === true) {
        const error = new Error(OLD_SENTENCE)
        throw tooBig ? withTooBig(error, { tooBig: { size: 9_000_000, limit: 5_000_000 } }) : error
      }
      return { mesh: tri, report: { touches: true, volumeChangeMm3: 1, watertight: true } }
    }
    return { call, sent }
  }
  const loft = step('loft-1', { op: 'sketch.loft', profiles: [{ loops: [] }, { frame: { origin: [0, 0, 20], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [] }], operation: 'new', name: 'Hull' } as StepParams)

  it('with a size and limit, makes the loft on the mesh and says them on the step', async () => {
    const e = lofts(true)
    const r = await replayHistory(e.call, { history: { version: 1, base: [], steps: [loft] }, exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done', note: solidTooBig(9_000_000, false, 5_000_000) }])
    expect(r.parts[0]!.positions).toEqual(tri.positions)
    // asked once exact, then made as today's mesh loft
    expect(e.sent.filter((x) => x.op === 'sketch.loft').map((x) => x.exact)).toEqual([true, undefined])
    clearReplayCache()
    const strict = await replayHistory(lofts(true).call, { history: { version: 1, base: [], steps: [loft], exact: true } }, kept)
    expect(strict.status[0]).toEqual({ state: 'broken', message: solidTooBig(9_000_000, true, 5_000_000) })
  })

  it('from an older engine, with no size and limit, is the step failing with its own sentence, as before', async () => {
    const r = await replayHistory(lofts(false).call, { history: { version: 1, base: [], steps: [loft] }, exact: true }, kept)
    expect(r.status[0]).toMatchObject({ state: 'broken' })
    expect((r.status[0] as { message: string }).message).toContain(OLD_SENTENCE)
  })
})

describe('the size and limit on an engine error', () => {
  it('are read only when both are whole numbers', () => {
    expect(tooBigOf(withTooBig(new Error('x'), { tooBig: { size: 9, limit: 8 } }))).toEqual({ size: 9, limit: 8 })
    expect(tooBigOf(withTooBig(new Error('x'), { tooBig: { size: 9 } }))).toBeUndefined()
    expect(tooBigOf(withTooBig(new Error('x'), { tooBig: { size: '9', limit: 8 } }))).toBeUndefined()
    expect(tooBigOf(withTooBig(new Error('x'), { error: 'x' }))).toBeUndefined()
    expect(tooBigOf(withTooBig(new Error('x'), undefined))).toBeUndefined()
  })
})

/** The page's worker, running the worker's own loop over a message channel with a stand-in engine. */
class LoopWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  private page
  private loop
  constructor(jobs: WorkerJobs) {
    const { port1, port2 } = new MessageChannel()
    this.page = port1
    this.loop = port2
    const handle = workerLoop((m) => port2.postMessage(m), jobs)
    port2.on('message', (m: WorkerMessage) => void handle(m))
    port1.on('message', (data: unknown) => this.onmessage?.({ data } as MessageEvent))
  }
  postMessage(m: unknown) {
    this.page.postMessage(m)
  }
  terminate() {
    this.page.close()
    this.loop.close()
  }
}

describe("the page's geometry client", () => {
  afterEach(() => {
    endIdleGeomWorker()
    vi.unstubAllGlobals()
    setGeomProvider(null)
  })

  it("rejects with the engine's sentence and its size and limit, or with the sentence alone from an older engine", async () => {
    const jobs: WorkerJobs = {
      async prepare(op) {
        return () => {
          if (op === 'new') throw withTooBig(new Error(OLD_SENTENCE), { tooBig: { size: 9_000_000, limit: 5_000_000 } })
          throw new Error(OLD_SENTENCE)
        }
      },
      async replay() {
        return {}
      },
      memoryBytes: () => 0,
      transfer: () => [],
    }
    vi.stubGlobal('Worker', function () {
      return new LoopWorker(jobs)
    })
    const refused = await geom().call('new', {}).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(OLD_SENTENCE)
    expect(tooBigOf(refused)).toEqual({ size: 9_000_000, limit: 5_000_000 })
    const old = await geom().call('old', {}).catch((e: unknown) => e)
    expect((old as Error).message).toBe(OLD_SENTENCE)
    expect(old).not.toHaveProperty('tooBig')
  })
})
