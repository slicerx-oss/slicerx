// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A resume with no current slice (a reopened project, a resume from the printer list) plans in the job's layers as
// the engine slices them, not in layers the app works out itself: the plate's own layer heights with a Z shrinkage
// and layers at the printer's maximum, sleipnir's plan, and a painted second filament that turns the shrinkage off.
// Each case runs the real engine through the app's own slice path: the layers the resume plans with equal the job's
// layerZ, and the resumed slice's last layer on the bed ends within half a layer of the measured height.
// The engine cases skip unless SLICERX_TEST_SX_BIN and SLICERX_SX_GEOM_BIN name built binaries
// (cargo build -p sx-cli -p sx-geom). The cancel cases run everywhere.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host, MeshHandle, MeshPart, SliceRequest, SliceResult } from '@slicerx/contracts'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setGeomProvider, toGeom } from '../src/geom/client'
import { planResume } from '../src/geom/resume'
import { boxMesh } from '../src/plate/mesh-ops'
import { setPlateLayerProfile } from '../src/plate/plates'
import { jobLayerTops, resumeLayers, sliceInputsKey, sliceState } from '../src/plate/resume-tops'
import { forgetLayerPlans } from '../src/plate/smart-layer'
import { compose } from '../src/plate/transform'
import { slicePlate } from '../src/state/actions'
import { engineErrorText } from '../src/lib/engine-errors'
import { plateLayerZ } from '../src/state/slice-plate'
import { get, set, type PlateEntry, type PaintData } from '../src/state/store'
import { binBuilt, GEOM_BUILD, SX_BUILD } from './binaries'

const sx = process.env['SLICERX_TEST_SX_BIN'] ?? ''
const geomBin = process.env['SLICERX_SX_GEOM_BIN'] ?? ''
const built = binBuilt(sx || undefined, SX_BUILD) && binBuilt(geomBin || undefined, GEOM_BUILD)
const dir = built ? mkdtempSync(join(tmpdir(), 'resume-layers-')) : ''
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }))

/** A binary STL of `p`. */
function stl(p: MeshPart): Buffer {
  const n = p.indices.length / 3
  const b = Buffer.alloc(84 + n * 50)
  b.writeUInt32LE(n, 80)
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50
    for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) b.writeFloatLE(p.positions[p.indices[t * 3 + v]! * 3 + c]!, o + 12 + v * 12 + c * 4)
  }
  return b
}

/** A host whose slices run sx on the request the app sends, with the meshes it loaded. */
function engineHost(kind: 'desktop' | 'web' = 'desktop', threads = 1): { host: Host; requests: SliceRequest[]; addMesh: (id: string, bytes: Buffer) => void } {
  const files = new Map<string, string>()
  const requests: SliceRequest[] = []
  const own = mkdtempSync(join(dir, 'host-'))
  let n = 0
  const addMesh = (id: string, bytes: Buffer) => {
    const f = join(own, `${id}.bin`)
    writeFileSync(f, bytes)
    files.set(id, f)
  }
  const slicer = {
    loadModel: async (data: ArrayBuffer, name: string): Promise<MeshHandle> => {
      const id = `m${++n}`
      addMesh(id, Buffer.from(data))
      return { id, hash: id, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }
    },
    slice: async (req: SliceRequest): Promise<SliceResult> => {
      requests.push(req)
      const id = `s${++n}`
      const out = join(own, id)
      mkdirSync(out)
      const file = join(out, 'request.json')
      writeFileSync(file, JSON.stringify({ ...req, meshes: Object.fromEntries(req.plate.objects.map((o) => [o.mesh, files.get(o.mesh)])) }))
      const v = JSON.parse(execFileSync(sx, ['slice', '--request', file, '--out-dir', out], { maxBuffer: 1 << 28 }).toString()) as { layerZ: number[]; layerTimeS?: number[]; layerCount: number; stats: SliceResult['stats']; warnings: SliceResult['warnings'] }
      return { id, engine: 'sx', layerCount: v.layerCount, layerZ: Float32Array.from(v.layerZ), layerTimeS: Float32Array.from(v.layerTimeS ?? []), stats: v.stats, warnings: v.warnings, wallMs: 1 } as unknown as SliceResult
    },
    getPreview: async (id: string) => {
      const b = readFileSync(join(own, id, 'slice.sxpv'))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
    release: () => undefined,
  }
  return { host: { kind, capabilities: { threads }, slicer } as unknown as Host, requests, addMesh }
}

const LIMITS = { layer_height: 0.2, initial_layer_print_height: 0.2, min_layer_height: [0.08], max_layer_height: [0.28], brim_width: 0 }

/** A 10 x 10 mm box `h` mm tall, alone on the plate, with `paint` when given. */
function onePlate(h: number, overrides: Record<string, unknown>, extra: Partial<PlateEntry> = {}): MeshPart {
  const part = { ...boxMesh(10, 10, h), name: 'Body', slot: 1 }
  const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'box', hash: 'box', name: 'box', triangles: 12, bboxMm: [10, 10, h], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff', '#000'], transform: compose({ position: [100, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), ...extra }
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: { ...LIMITS, ...overrides }, easy: { ...get().easy, varyLayerHeight: false } })
  return part
}

/**
 * The resume as the dialog runs it with no current slice: the job's layers (resumeLayers), the plan at `measured` in
 * them, then the stored plan sliced. Checks the layers are the job's as the engine slices it, and where it lands.
 */
async function resumeAt(engine: ReturnType<typeof engineHost>, part: MeshPart, measured: number): Promise<{ tops: number[]; job: number[]; z: number[]; at: number }> {
  const { host, requests } = engine
  engine.addMesh('box', stl(part))
  const layers = (await resumeLayers(host, new AbortController().signal))!
  expect(layers.plate).toBe('plate-1')
  const planning = requests.slice()
  // The job, sliced as the app slices it: the layers are its layers.
  await slicePlate(host)
  const done = get().slice
  if (done.status !== 'done') throw new Error(`the job did not slice: ${JSON.stringify(done)}`)
  const job = Array.from(done.result.layerZ)
  expect(layers.tops).toEqual(job)
  // The plan in those layers, stored as the dialog's Slice the rest stores it, and sliced.
  const plan = await planResume([{ mesh: toGeom(part), transform: get().plate[0]!.transform }], { measuredHeightMm: measured, layerHeightMm: 0.2, firstLayerHeightMm: 0.2, layerTopsMm: layers.tops, includeRemainingMesh: false })
  set({ slice: { status: 'idle' }, resume: { plan: { resumeLayer: plan.resumeLayer, printedHeightMm: plan.printedHeightMm }, layerTopsMm: layers.tops } })
  await slicePlate(host)
  const sent = requests.at(-1)!.options!
  expect(sent).toMatchObject({ resumeFromLayer: plan.resumeLayer, layerTopsExact: true, layerTopsSliced: true })
  const resumed = get().slice
  if (resumed.status !== 'done') throw new Error(`the resume did not slice: ${JSON.stringify(resumed)}`)
  const z = Array.from(resumed.result.layerZ)
  const at = plan.resumeLayer
  // Every layer where the job printed it, and the last one on the bed within half its thickness of the measurement.
  expect(z.length).toBe(job.length)
  z.forEach((v, i) => expect(Math.abs(v - job[i]!), `layer ${i}`).toBeLessThan(1e-4))
  expect(Math.abs(z[at - 1]! - measured), `the bed holds ${z[at - 1]} mm`).toBeLessThanOrEqual((z[at - 1]! - z[at - 2]!) / 2 + 1e-4)
  // The layers took one engine run, the slice's own request with no resume, for its layers only.
  expect(planning).toHaveLength(1)
  expect(planning[0]!.options).toMatchObject({ emitGcode: false, emitPreview: false })
  expect(planning[0]!.options).not.toHaveProperty('resumeFromLayer')
  return { tops: layers.tops, job, z, at }
}

describe.skipIf(!built)('a resume with no current slice, real engine', () => {
  beforeEach(() => {
    forgetLayerPlans()
    setGeomProvider({ call: async (op, request) => JSON.parse(execFileSync(geomBin, [op], { input: JSON.stringify(request), maxBuffer: 1 << 28 }).toString()) })
  })

  it("plans in the engine's layers where own layers sit at the maximum and a 99 percent Z shrinkage stretches the rest", async () => {
    // 0.28 mm (the maximum) to 20 mm, 0.1 mm above. The engine keeps the 0.28 mm layers and stretches the thin ones,
    // so the part stopped on the layer that ends at 20.08 mm still has that height.
    const part = onePlate(40, { filament_shrinkage_compensation_z: ['99%'] })
    setPlateLayerProfile('plate-1', [[0, 0.28], [19.9, 0.28], [20.2, 0.1], [40, 0.1]])
    const { job, z, at } = await resumeAt(engineHost(), part, 20.08)
    expect(job.at(-1)).toBeCloseTo(40 / 0.99, 3)
    expect(job[10]! - job[9]!).toBeCloseTo(0.28, 4)
    expect(z[at - 1]).toBeCloseTo(20.08, 4)
  }, 120_000)

  it('gives the same layers through the web pool, which slices in shards', async () => {
    const part = onePlate(40, { filament_shrinkage_compensation_z: ['99%'] })
    setPlateLayerProfile('plate-1', [[0, 0.28], [19.9, 0.28], [20.2, 0.1], [40, 0.1]])
    const web = engineHost('web', 4)
    const { job } = await resumeAt(web, part, 20.08)
    // The layer run keeps the slice's shards, and its layers are the ones a single run on the desktop gives.
    expect(web.requests[0]!.options).toMatchObject({ shards: 4, emitGcode: false })
    const desk = engineHost()
    desk.addMesh('box', stl(part))
    set({ resume: null, slice: { status: 'idle' } })
    const one = await resumeLayers(desk.host, new AbortController().signal)
    expect(desk.requests[0]!.options).toMatchObject({ shards: 1 })
    expect(one!.tops).toEqual(job)
  }, 120_000)

  it("plans a sleipnir plate in the engine's layers", async () => {
    const part = onePlate(20, { smart_layer_min_height: 0.08, smart_layer_max_height: 0.28 })
    set({ easy: { ...get().easy, varyLayerHeight: true } })
    const { tops, at } = await resumeAt(engineHost(), part, 10)
    // Not even layers of layer_height: sleipnir thins the layers under the top, so 20 mm takes more than 100.
    expect(tops.length).toBeGreaterThan(100)
    expect(tops.slice(1).some((t, i) => Math.abs(t - tops[i]! - 0.2) > 0.01)).toBe(true)
    expect(at).toBeGreaterThan(0)
  }, 120_000)

  it('leaves the layers unstretched when a painted filament has another Z shrinkage, as the engine does', async () => {
    // The part is on filament 1 (99 percent in Z) with its bottom painted in filament 2 (100 percent): the engine
    // compensates only when every filament the plate uses agrees, so nothing stretches.
    const paint: PaintData = { 0: { color: { 0: '8', 1: '8' } } }
    const part = onePlate(40, { filament_shrinkage_compensation_z: ['99%', '100%'] }, { paint })
    set({ slotSetup: { 1: { type: 'PLA', brand: '', color: '#ffffff' }, 2: { type: 'PLA', brand: '', color: '#000000' } } as never })
    setPlateLayerProfile('plate-1', [[0, 0.28], [19.9, 0.28], [20.2, 0.1], [40, 0.1]])
    const engine = engineHost()
    const { job } = await resumeAt(engine, part, 20.08)
    expect(engine.requests[0]!.config['filament_shrinkage_compensation_z']).toEqual(['99%', '100%'])
    // The paint went with the part: the plate slices a painted copy, not the plain mesh.
    expect(engine.requests[0]!.plate.objects[0]!.mesh).not.toBe('box')
    expect(job.at(-1)).toBeCloseTo(40, 3)
  }, 120_000)
})

describe('the job layers a resume waits for', () => {
  /** A host whose slice answers when the test says, with these layers. */
  function heldHost(): { host: Host; release: () => void; calls: () => number; local: (boolean | undefined)[] } {
    let go = () => undefined as void
    let calls = 0
    const local: (boolean | undefined)[] = []
    const host = {
      kind: 'desktop',
      capabilities: { threads: 1 },
      slicer: {
        loadModel: async () => ({ id: 'm', hash: 'm', name: 'm', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }),
        release: () => undefined,
        slice: (_r: SliceRequest, o?: { signal?: AbortSignal; local?: boolean }) => {
          calls++
          local.push(o?.local)
          return new Promise<SliceResult>((res, rej) => {
            o?.signal?.addEventListener('abort', () => rej(new DOMException('Slice canceled', 'AbortError')))
            go = () => res({ id: 'r', layerZ: Float32Array.from([0.2, 0.4]), warnings: [] } as unknown as SliceResult)
          })
        },
      },
    } as unknown as Host
    return { host, release: () => go(), calls: () => calls, local }
  }

  /** A host whose slices answer in turn: an Error rejects with its message, an array is the layers. */
  function scriptedHost(answers: (Error | number[])[]): { host: Host; requests: SliceRequest[] } {
    const requests: SliceRequest[] = []
    const host = {
      kind: 'desktop',
      capabilities: { threads: 1 },
      slicer: {
        loadModel: async () => ({ id: 'm', hash: 'm', name: 'm', triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }),
        release: () => undefined,
        slice: async (r: SliceRequest) => {
          requests.push(r)
          const a = answers.shift()
          if (!a) throw new Error('stop')
          if (a instanceof Error) throw a
          return { id: `r${requests.length}`, layerZ: Float32Array.from(a), warnings: [] } as unknown as SliceResult
        },
      },
    } as unknown as Host
    return { host, requests }
  }
  const started = (h: { calls: () => number }) => vi.waitFor(() => expect(h.calls()).toBe(1))

  beforeEach(() => {
    onePlate(10, {})
  })

  it("uses the job's layers without the engine when the app has them", async () => {
    set({ resume: { plan: { resumeLayer: 3, printedHeightMm: 0.6 }, layerTopsMm: [0.2, 0.4, 0.6, 0.8] } })
    const h = heldHost()
    expect(await resumeLayers(h.host, new AbortController().signal)).toMatchObject({ plate: 'plate-1', tops: [0.2, 0.4, 0.6, 0.8] })
    expect(h.calls()).toBe(0)
  })

  it("uses a current slice's layers, and the engine's when that slice is stale", async () => {
    const result = { id: 'r', layerZ: Float32Array.from([0.2, 0.5]), warnings: [] } as unknown as SliceResult
    set({ slice: { status: 'done', result, stale: false } })
    const h = heldHost()
    expect((await resumeLayers(h.host, new AbortController().signal))?.tops).toEqual(Array.from(result.layerZ))
    expect(h.calls()).toBe(0)
    set({ slice: { status: 'done', result, stale: true } })
    const p = resumeLayers(h.host, new AbortController().signal)
    await started(h)
    h.release()
    expect((await p)?.tops.length).toBe(2)
    expect((await p)?.tops[1]).toBeCloseTo(0.4, 6)
  })

  it('gives the engine layers once they land', async () => {
    const h = heldHost()
    const p = resumeLayers(h.host, new AbortController().signal)
    await started(h)
    h.release()
    const l = await p
    expect(l?.plate).toBe('plate-1')
    // On this device: never a cloud slice, which would spend the account's cloud slices on a layer probe.
    expect(h.local).toEqual([true])
    expect(l?.tops[0]).toBeCloseTo(0.2, 6)
    expect(l?.tops[1]).toBeCloseTo(0.4, 6)
  })

  it('drops the layers when the dialog closes before they land', async () => {
    const h = heldHost()
    const ac = new AbortController()
    const p = resumeLayers(h.host, ac.signal)
    await started(h)
    ac.abort()
    expect(await p).toBeNull()
  })

  it('drops the layers when another plate shows before they land', async () => {
    const h = heldHost()
    const p = resumeLayers(h.host, new AbortController().signal)
    await started(h)
    set({ activePlate: 'plate-2' })
    h.release()
    expect(await p).toBeNull()
  })

  it('drops a setting the opened project brought that the engine refuses, and slices again', async () => {
    set({ overrides: { ...get().overrides, raft_first_layer_expansion: -1 }, projectSettings: { source: 'the opened project', keys: ['raft_first_layer_expansion'] } })
    const e = scriptedHost([new Error('config key raft_first_layer_expansion: -1 is outside 0 to 100'), [0.2, 0.4, 0.6]])
    const tops = await plateLayerZ(e.host, new AbortController().signal)
    expect(tops.map((t) => Math.round(t * 10) / 10)).toEqual([0.2, 0.4, 0.6])
    expect(e.requests).toHaveLength(2)
    expect(e.requests[0]!.config).toHaveProperty('raft_first_layer_expansion', -1)
    expect(e.requests[1]!.config['raft_first_layer_expansion']).not.toBe(-1)
    expect(get().overrides).not.toHaveProperty('raft_first_layer_expansion')
    expect(get().projectSettings?.keys).toEqual([])
  })

  it("throws any other refusal in a slice's words", async () => {
    const raw = 'blocked by the safety preflight: the start G-code heats past the printer limit'
    const e = scriptedHost([new Error(raw)])
    await expect(plateLayerZ(e.host, new AbortController().signal)).rejects.toThrow(engineErrorText(raw))
    expect(engineErrorText(raw)).not.toBe(raw)
    expect(e.requests).toHaveLength(1)
  })
})

describe("a stored resume's layers", () => {
  const TOPS = [0.2, 0.4, 0.6, 0.8, 1]
  /** Stores a plan with TOPS for the shown plate as it is, as Slice the rest does. */
  const store = () => set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: TOPS, plate: get().activePlate, inputs: sliceInputsKey(sliceState(get())) } })
  /** The options the next slice sends. */
  async function sent(): Promise<Record<string, unknown>> {
    const e = { requests: [] as SliceRequest[] }
    const host = { kind: 'desktop', capabilities: { threads: 1 }, slicer: { loadModel: async () => ({ id: 'm' }), release: () => undefined, slice: async (r: SliceRequest) => (e.requests.push(r), Promise.reject(new Error('stop'))) } } as unknown as Host
    await slicePlate(host)
    return (e.requests[0]?.options ?? {}) as Record<string, unknown>
  }

  beforeEach(() => {
    onePlate(1, {})
  })

  it('hold for the plate they were planned on, as it was', async () => {
    store()
    expect(jobLayerTops(get())).toEqual(TOPS)
    expect(await sent()).toMatchObject({ layerTopsMm: TOPS, layerTopsExact: true, layerTopsSliced: true, resumeFromLayer: 2 })
  })

  it('are left out after a switch to another plate', async () => {
    store()
    set({ activePlate: 'plate-2' })
    expect(jobLayerTops(get())).toBeUndefined()
    const opts = await sent()
    expect(opts).not.toHaveProperty('layerTopsMm')
    expect(opts).not.toHaveProperty('layerTopsSliced')
  })

  it('are left out after an edit to the plate or its settings', async () => {
    store()
    set({ overrides: { ...get().overrides, layer_height: 0.12 } })
    expect(jobLayerTops(get())).toBeUndefined()
    expect(await sent()).not.toHaveProperty('layerTopsSliced')
    store()
    set({ plate: get().plate.map((e) => ({ ...e, transform: compose({ position: [120, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })) })
    expect(jobLayerTops(get())).toBeUndefined()
    expect(await sent()).not.toHaveProperty('layerTopsSliced')
  })
})
