// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sleipnir plan is asked for again only when something it reads changes: an edit that leaves the layer heights
// alone reuses the last plan, and one that changes them, or the plate's meshes, plans again. The plan runs in a
// geometry worker of its own, so the fit check never waits behind it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { goalEasy } from '../src/adapters/config'
import { geom, setGeomProvider } from '../src/geom/client'
import { forgetLayerPlans, planSmartLayers, PLAN_GRACE_MS } from '../src/plate/smart-layer'
import { slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const part = () => ({ name: 'a', slot: 1, positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) })
const entry = (parts = [part()], transform = id) => ({ id: 'a', name: 'a', handle, parts, colors: [], transform }) as never

/** A geometry provider that counts the layer plans asked for and answers each with its settings' thinnest layer. */
function planner() {
  const plans: { request: { options: { minHeightMm: number } }; signal: AbortSignal | undefined }[] = []
  setGeomProvider({
    call: async <T,>(op: string, request: unknown, signal?: AbortSignal): Promise<T> => {
      if (op !== 'layers.plan') throw new Error(`unexpected ${op}`)
      plans.push({ request: request as never, signal })
      const min = (request as { options: { minHeightMm: number } }).options.minHeightMm
      return { layerTopsMm: [0.2, 0.2 + min, 0.2 + 2 * min] } as T
    },
  })
  return plans
}

/** A host whose slice records the request and then fails, which is enough to read the options. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
  return { host, requests }
}

const config = (min = 0.15) => ({ nozzle_diameter: [0.4], smart_layer_min_height: min, smart_layer_max_height: 0.3, initial_layer_print_height: 0.2 })

beforeEach(() => {
  forgetLayerPlans()
  set({ plate: [entry()], resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {}, overrides: {}, easy: { ...get().easy, varyLayerHeight: true } })
})

afterEach(() => {
  forgetLayerPlans()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setGeomProvider(null)
})

describe('a slice with sleipnir on', () => {
  it('sends no layer plan for an edit that leaves the layer heights alone, and reuses the last plan', async () => {
    const plans = planner()
    const { host, requests } = capture()
    await slicePlate(host)
    expect(plans).toHaveLength(1)
    const tops = requests[0]!.options?.layerTopsMm
    expect(tops?.length).toBeGreaterThan(1)
    set({ overrides: { wall_loops: 5, sparse_infill_density: '40%' } })
    await slicePlate(host)
    set({ easy: { ...get().easy, speed: 'fast' } })
    await slicePlate(host)
    expect(plans).toHaveLength(1)
    expect(requests[1]!.options?.layerTopsMm).toEqual(tops)
    expect(requests[2]!.options?.layerTopsMm).toEqual(tops)
  })

  it('plans again for a tile that changes the layer height, and never slices it with the old plan', async () => {
    const plans = planner()
    const { host, requests } = capture()
    set({ easy: { ...get().easy, ...goalEasy('standard'), varyLayerHeight: true } })
    await slicePlate(host)
    set({ easy: { ...get().easy, ...goalEasy('fine'), varyLayerHeight: true } })
    await slicePlate(host)
    expect(plans).toHaveLength(2)
    expect(plans[1]!.request.options.minHeightMm).not.toBe(plans[0]!.request.options.minHeightMm)
    expect(requests[1]!.options?.layerTopsMm).not.toEqual(requests[0]!.options?.layerTopsMm)
    expect(requests[1]!.options?.layerTopsMm?.[1]).toBeCloseTo(0.2 + plans[1]!.request.options.minHeightMm, 6)
  })

  it('sends no layer plan with sleipnir off', async () => {
    const plans = planner()
    set({ easy: { ...get().easy, varyLayerHeight: false } })
    await slicePlate(capture().host)
    expect(plans).toHaveLength(0)
  })
})

describe('the plan reused', () => {
  it('only while the meshes, their placement and the planner settings are the ones it planned', async () => {
    const plans = planner()
    const p = part()
    await planSmartLayers([entry([p])], config(), 'quality')
    await planSmartLayers([entry([p])], config(), 'quality')
    expect(plans).toHaveLength(1)
    await planSmartLayers([entry([p])], config(0.1), 'quality')
    expect(plans).toHaveLength(2)
    await planSmartLayers([entry([p])], config(0.1), 'strength')
    expect(plans).toHaveLength(3)
    await planSmartLayers([entry([p], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])], config(0.1), 'strength')
    expect(plans).toHaveLength(4)
    // The same shape as a new part (a repair, a cut) plans again.
    await planSmartLayers([entry([part()], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])], config(0.1), 'strength')
    expect(plans).toHaveLength(5)
  })

  it('is shared by two slices asking at once, and a plan for other inputs stops the running one', async () => {
    const plans = planner()
    const p = part()
    const a = planSmartLayers([entry([p])], config(), 'quality')
    const b = planSmartLayers([entry([p])], config(), 'quality')
    expect(await a).toEqual(await b)
    expect(plans).toHaveLength(1)
    let hold: () => void = () => undefined
    setGeomProvider({
      call: <T,>(_op: string, request: unknown, signal?: AbortSignal) => {
        plans.push({ request: request as never, signal })
        return new Promise<T>((resolve, reject) => {
          hold = () => resolve({ layerTopsMm: [0.2, 0.4] } as T)
          signal?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')))
        })
      },
    })
    const old = planSmartLayers([entry([p])], config(0.12), 'quality')
    const next = planSmartLayers([entry([p])], config(0.1), 'quality')
    await expect(old).rejects.toMatchObject({ name: 'AbortError' })
    expect(plans[1]!.signal?.aborted).toBe(true)
    hold()
    await expect(next).resolves.toEqual([0.2, 0.4])
  })
})

class PlanWorker {
  static made: PlanWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: { id: number; op: string }[] = []
  ended = false
  constructor() {
    PlanWorker.made.push(this)
  }
  postMessage(m: { id: number; op: string; cancel?: number }) {
    if (m.cancel === undefined) this.posted.push(m)
  }
  answer(result: unknown) {
    const m = this.posted[0]!
    this.onmessage?.({ data: { id: m.id, result } } as MessageEvent)
  }
  terminate() {
    this.ended = true
  }
}

describe('the plan in a worker of its own', () => {
  beforeEach(() => {
    PlanWorker.made = []
    vi.stubGlobal('Worker', PlanWorker)
    setGeomProvider(null)
  })

  it('leaves the fit check to answer while it runs, and ends with its answer', async () => {
    const plan = planSmartLayers([entry()], config(), 'quality')
    const fit = geom().call<{ ok: boolean }>('fit.check', { mesh: new Float32Array(4) })
    expect(PlanWorker.made).toHaveLength(2)
    const [planner, shared] = PlanWorker.made as [PlanWorker, PlanWorker]
    expect(planner.posted.map((m) => m.op)).toEqual(['layers.plan'])
    expect(shared.posted.map((m) => m.op)).toEqual(['fit.check'])
    shared.answer({ ok: true })
    await expect(fit).resolves.toEqual({ ok: true })
    planner.answer({ layerTopsMm: [0.2, 0.4, 0.6] })
    await expect(plan).resolves.toEqual([0.2, 0.4, 0.6])
    expect(planner.ended).toBe(true)
  })

  it('ends when its slice is canceled and no slice takes it over', async () => {
    vi.useFakeTimers()
    const ctl = new AbortController()
    const plan = planSmartLayers([entry()], config(), 'quality', ctl.signal)
    const worker = PlanWorker.made[0]!
    ctl.abort()
    await expect(plan).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.ended).toBe(false)
    vi.advanceTimersByTime(PLAN_GRACE_MS)
    expect(worker.ended).toBe(true)
  })

  it('goes on for the next slice when that one asks for the same plan', async () => {
    vi.useFakeTimers()
    const p = part()
    const first = new AbortController()
    const canceled = planSmartLayers([entry([p])], config(), 'quality', first.signal)
    first.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    const next = planSmartLayers([entry([p])], config(), 'quality', new AbortController().signal)
    vi.advanceTimersByTime(PLAN_GRACE_MS * 2)
    expect(PlanWorker.made).toHaveLength(1)
    const worker = PlanWorker.made[0]!
    expect(worker.ended).toBe(false)
    worker.answer({ layerTopsMm: [0.2, 0.4] })
    await expect(next).resolves.toEqual([0.2, 0.4])
  })
})
