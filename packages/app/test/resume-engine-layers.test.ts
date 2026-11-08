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
import { jobLayerTops, KEY_LEAVES_OUT, KEY_SLOT_MATCH, OBJECT_LEAVES_OUT, RESUME_VOID, resumeFor, resumeLayers, sliceInputsKey } from '../src/plate/resume-tops'
import { INPUTS } from '../src/state/slice-inputs'
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

// What the tests of the slice inputs key put in the store (a printer, its nozzles, presets, a profile) would stay for the
// tests that run after them, and a slice reads it: it makes the plate's key another one than the stored plan was made for.
const START = (({ printerModel, profile, userPresets, printerNozzles, printerExtruders, printerSlots, slotMatch, fileSlotTypes, fileSlotVendors, tower, towerFromProject, projectTowers }) => ({ printerModel, profile, userPresets, printerNozzles, printerExtruders, printerSlots, slotMatch, fileSlotTypes, fileSlotVendors, tower, towerFromProject, projectTowers }))(get())

/** A 10 x 10 mm box `h` mm tall, alone on the plate, with `paint` when given. */
function onePlate(h: number, overrides: Record<string, unknown>, extra: Partial<PlateEntry> = {}): MeshPart {
  set(START)
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
  set({ slice: { status: 'idle' }, resume: resumeFor(get(), { plan: { resumeLayer: plan.resumeLayer, printedHeightMm: plan.printedHeightMm }, layerTopsMm: layers.tops }) })
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
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 3, printedHeightMm: 0.6 }, layerTopsMm: [0.2, 0.4, 0.6, 0.8] }) })
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

  it('drops the layers when a setting changes before they land', async () => {
    const h = heldHost()
    const p = resumeLayers(h.host, new AbortController().signal)
    await started(h)
    set({ overrides: { ...get().overrides, layer_height: 0.12 } })
    h.release()
    expect(await p).toBeNull()
  })

  it('drops the layers of a run that dropped a refused project setting, and the next run keys them by the plate as it is', async () => {
    set({ overrides: { ...get().overrides, raft_first_layer_expansion: -1 }, projectSettings: { source: 'the opened project', keys: ['raft_first_layer_expansion'] } })
    const before = sliceInputsKey(get())
    const e = scriptedHost([new Error('config key raft_first_layer_expansion: -1 is outside 0 to 100'), [0.2, 0.4, 0.6], [0.2, 0.4, 0.6]])
    // The run changed the plate's settings, so its layers are for a plate that is gone.
    expect(await resumeLayers(e.host, new AbortController().signal)).toBeNull()
    expect(e.requests).toHaveLength(2)
    expect(get().overrides).not.toHaveProperty('raft_first_layer_expansion')
    expect(sliceInputsKey(get())).not.toBe(before)
    // The dialog asks again (its inputs changed): one slice, with the setting already gone.
    const l = await resumeLayers(e.host, new AbortController().signal)
    expect(e.requests).toHaveLength(3)
    expect(l?.tops.map((t) => Math.round(t * 10) / 10)).toEqual([0.2, 0.4, 0.6])
    expect(l?.inputs).toBe(sliceInputsKey(get()))
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

describe('a stored resume plan', () => {
  const TOPS = [0.2, 0.4, 0.6, 0.8, 1]
  /** Stores a plan with TOPS, declaring the height, for the shown plate as it is, as Slice the rest does. */
  const store = () => set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, declareZ: true, layerTopsMm: TOPS }) })
  /** The options the next slice sends, or, when slicePlate refused to send one, why (`refused`). */
  async function sent(): Promise<{ opts: Record<string, unknown>; refused: string | null }> {
    const e = { requests: [] as SliceRequest[] }
    const host = { kind: 'desktop', capabilities: { threads: 1 }, slicer: { loadModel: async () => ({ id: 'm' }), release: () => undefined, slice: async (r: SliceRequest) => (e.requests.push(r), Promise.reject(new Error('stop'))) } } as unknown as Host
    await slicePlate(host)
    const s = get().slice
    const refused = e.requests.length === 0 && s.status === 'error' ? s.message : null
    return { opts: (e.requests[0]?.options ?? {}) as Record<string, unknown>, refused }
  }
  /** Nothing of the plan goes out: not its layers, not the layer it starts from, not the height it declares. */
  const none = (opts: Record<string, unknown>) => {
    for (const k of ['layerTopsMm', 'layerTopsSliced', 'resumeFromLayer', 'resumeZ']) expect(opts, k).not.toHaveProperty(k)
  }

  beforeEach(() => {
    onePlate(1, {})
  })

  it('holds as one for the plate it was planned on, as it was', async () => {
    store()
    expect(jobLayerTops(get())).toEqual(TOPS)
    const { opts, refused } = await sent()
    expect(opts).toMatchObject({ layerTopsMm: TOPS, layerTopsExact: true, layerTopsSliced: true, resumeFromLayer: 2, resumeZ: { mode: 'declare', zMm: 0.4 } })
    expect(refused).toBeNull()
  })

  it('holds for none of it on another plate, which slices whole', async () => {
    store()
    set({ activePlate: 'plate-2' })
    expect(jobLayerTops(get())).toBeUndefined()
    const { opts, refused } = await sent()
    none(opts)
    expect(refused).toBeNull()
    // Back on its plate, unchanged, it holds again.
    set({ activePlate: 'plate-1' })
    expect((await sent()).opts).toMatchObject({ resumeFromLayer: 2 })
  })

  it('after an edit to the plate or its settings, holds for none of it and the plate does not slice', async () => {
    store()
    set({ overrides: { ...get().overrides, layer_height: 0.12 } })
    expect(jobLayerTops(get())).toBeUndefined()
    let r = await sent()
    expect(r.refused).toBe(RESUME_VOID)
    store()
    set({ plate: get().plate.map((e) => ({ ...e, transform: compose({ position: [120, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })) })
    expect(jobLayerTops(get())).toBeUndefined()
    r = await sent()
    expect(r.refused).toBe(RESUME_VOID)
  })

  it('holds for none of it when it does not say which plate and inputs it was made for', async () => {
    // No plate: it is no plate's plan, so the plate slices whole.
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: TOPS } })
    expect(jobLayerTops(get())).toBeUndefined()
    none((await sent()).opts)
    // This plate but no inputs: it cannot be checked, so the plate does not slice.
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: TOPS, plate: 'plate-1' } })
    expect((await sent()).refused).toBe(RESUME_VOID)
  })
})

/** A filament preset the calibration tuned for one spool, printer and nozzle (calibration/tuned.ts). */
const TUNED = { id: 'u1', kind: 'filament', name: 'Mine', values: { filament_shrinkage_compensation_z: [100.5] }, tuned: { key: 'k1', filament: 'PLA', printerId: 'p1', nozzleMm: 0.4, results: { tolerance: { label: 'Tolerance', value: '0.1', at: 1, raw: 0.1 } } }, createdAt: 1, updatedAt: 1 }

describe('the slice inputs key', () => {
  beforeEach(() => {
    onePlate(1, {})
    set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: get().plate, settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [], settings: {} }], printerSlots: [{ id: 'A1', material: 'PLA', color: '#ffffff', remainingG: 600, remainingPct: 60, spoolUid: 'tag-1', spoolmanId: 3 }], userPresets: [TUNED, { id: 'u2', kind: 'filament', name: 'Plain', values: { nozzle_temperature: [215] }, createdAt: 1, updatedAt: 1 }, { id: 'u3', kind: 'process', name: 'Fine', values: { layer_height: 0.12 }, createdAt: 1, updatedAt: 1 }], printerModel: { id: 'p1', vendor: 'Bambu Lab', model: 'A1' }, printerNozzles: { p1: 0.4, p2: 0.4 }, printerExtruders: {}, slotMatch: {}, fileSlotTypes: [], fileSlotVendors: [], profile: { nozzle: 0.4 } } as never)
  })
  const entry = (patch: Record<string, unknown>) => set({ plate: get().plate.map((e) => ({ ...e, ...patch })) })
  const meta = (patch: Record<string, unknown>) => set({ plates: get().plates.map((p) => (p.id === 'plate-1' ? { ...p, settings: { ...p.settings, ...patch } } : p)) })
  const grow = (k: string, extra: Record<string, unknown>) => set({ [k]: { ...((get() as unknown as Record<string, object>)[k] ?? {}), ...extra } } as never)
  const slot = (patch: Record<string, unknown>) => set({ printerSlots: get().printerSlots.map((x) => ({ ...x, ...patch })) })
  /** Changes the preset with this id. */
  const preset = (id: string, patch: (p: Record<string, unknown>) => Record<string, unknown>) => set({ userPresets: (get() as unknown as { userPresets: Record<string, unknown>[] }).userPresets.map((p) => (p['id'] === id ? { ...p, ...patch(p) } : p)) } as never)
  const tuned = (patch: Record<string, unknown>) => preset('u1', (p) => ({ tuned: { ...(p['tuned'] as object), ...patch } }))

  // Each changes one slice input (the INPUTS name first) in a way that moves layers; each must change the key.
  const changes: [string, string, () => void][] = [
    ['plate', 'mesh (handle hash)', () => entry({ handle: { ...get().plate[0]!.handle, hash: 'other' } })],
    ['plate', 'placement', () => entry({ transform: compose({ position: [101, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })],
    ['plate', 'paint', () => entry({ paint: { 0: { color: { 0: '8' } } } })],
    ['plate', 'volumes', () => entry({ volumes: [{ id: 'v', name: 'v', role: 'modifier' }] })],
    ['plate', 'part settings', () => entry({ partSettings: { Body: { wall_loops: 3 } } })],
    ['plate', 'slot overrides', () => entry({ slotOverrides: { Body: 2 } })],
    ['plate', 'printable', () => entry({ printable: false })],
    ['plate', 'height ranges from a project', () => entry({ layerRanges: [{ fromMm: 0, toMm: 1, settings: { layer_height: 0.1 } }] })],
    ['plate', 'brim ears', () => entry({ brimPoints: [[0, 0, 0, 3]] })],
    ['plate', 'a part moved to another filament', () => entry({ parts: get().plate[0]!.parts.map((p) => ({ ...p, slot: 2 })) })],
    ['plate', 'a history step open for editing that hides a part', () => set({ historyEdit: { stepId: 's', objectId: 'gone', original: { ...get().plate[0]!, id: 'gone' } } } as never)],
    ['objectSettings', 'object settings', () => set({ objectSettings: { a: { layer_height: 0.12 } } })],
    ['objectSettings', "object settings of this plate's object beside another's", () => set({ objectSettings: { zz: { wall_loops: 2 }, a: { wall_loops: 4 } } })],
    ['plates', 'the plate own layer heights', () => meta({ layerProfile: [[0, 0.1]] })],
    ['plates', 'plate settings', () => meta({ sequence: 'by-object' })],
    ['activePlate', 'the shown plate', () => set({ activePlate: 'plate-2' })],
    ['calibration', 'calibration', () => set({ calibration: { 'plate-1': { ranges: [] } } } as never)],
    ['printerId', 'printer', () => set({ printerId: 'another' } as never)],
    ['profile', 'profile nozzle', () => set({ profile: { ...(get().profile ?? {}), nozzle: 0.6 } } as never)],
    ['easy', 'Easy vary layer height', () => set({ easy: { ...get().easy, varyLayerHeight: !get().easy.varyLayerHeight } })],
    ['overrides', 'overrides', () => set({ overrides: { ...get().overrides, layer_height: 0.12 } })],
    ['slotSetup', 'filament slots', () => set({ slotSetup: { 2: { type: 'PETG', brand: '', color: '#000' } } } as never)],
    ['printerSlots', "the printer's slot material", () => slot({ material: 'PETG' })],
    ['printerSlots', "the printer's slot color", () => slot({ color: '#000000' })],
    ['flush', 'flush', () => grow('flush', { x: 1 })],
    ['tower', 'prime tower', () => grow('tower', { x: 1 })],
    ['userPresets', 'a tuned filament preset value', () => preset('u1', () => ({ values: { filament_shrinkage_compensation_z: [99] } }))],
    ['userPresets', 'a tuned result measured again', () => tuned({ results: { tolerance: { label: 'Tolerance', value: '0.2', at: 1, raw: 0.2 } } })],
    ['userPresets', 'a tuned result measured again with the same value, later', () => tuned({ results: { tolerance: { label: 'Tolerance', value: '0.1', at: 5, raw: 0.1 } } })],
    ['userPresets', 'a filament tuned with no results yet', () => set({ userPresets: [...get().userPresets, { id: 'u4', kind: 'filament', name: 'New', values: {}, tuned: { key: 'k2', filament: 'PETG', printerId: 'p1', nozzleMm: 0.4, results: {} }, createdAt: 1, updatedAt: 1 }] } as never)],
    ['userPresets', 'a tuned filament preset gone', () => set({ userPresets: get().userPresets.filter((p) => p.id !== 'u1') })],
    ['printerNozzles', "the slice printer's nozzle", () => grow('printerNozzles', { p1: 0.6 })],
    ['printerExtruders', "the slice printer's extruders", () => grow('printerExtruders', { p1: [{ diameterMm: 0.4 }] })],
    ['bed', 'bed', () => set({ bed: { ...get().bed, widthMm: 300 } })],
  ]
  for (const [, name, change] of changes) {
    it(`changes with ${name}`, () => {
      const before = sliceInputsKey(get())
      change()
      expect(sliceInputsKey(get())).not.toBe(before)
    })
  }

  // What changes on its own around a failed print, or is only a name or a picture: none of it moves layers.
  const holds: [string, () => void][] = [
    ['grams left on a spool', () => slot({ remainingG: 120 })],
    ['percent left on a spool', () => slot({ remainingPct: 12 })],
    ["a reloaded spool's tag", () => slot({ spoolUid: 'tag-2' })],
    ['a spool manager id', () => slot({ spoolmanId: 9 })],
    ['an object renamed', () => entry({ name: 'Renamed' })],
    ['an object locked', () => entry({ locked: true })],
    ['a new thumbnail', () => entry({ thumb: 'data:image/png;base64,AA' })],
    ['colors shown on the object', () => entry({ colors: ['#000'] })],
    ['where the model came from', () => entry({ source: { modelId: 'm', creatorId: 'c' } })],
    ['a tuned preset renamed or saved again', () => preset('u1', () => ({ name: 'Renamed', updatedAt: 99 }))],
    ['a filament preset with no tuning changed', () => preset('u2', () => ({ values: { nozzle_temperature: [230] } }))],
    ['a process preset changed (it reaches a slice through overrides)', () => preset('u3', () => ({ values: { layer_height: 0.28 } }))],
    ['a preset added that is not a tuned filament', () => set({ userPresets: [...get().userPresets, { id: 'u0', kind: 'printer', name: 'Mine', values: {}, createdAt: 2, updatedAt: 2 }] } as never)],
    ['object settings of an object on another plate', () => set({ objectSettings: { zz: { layer_height: 0.12 } } })],
    ["another printer's nozzle", () => grow('printerNozzles', { p2: 0.8 })],
    ["another printer's extruders", () => grow('printerExtruders', { p2: [{ diameterMm: 0.6 }] })],
    ['the profile shipped G-code', () => set({ profile: { ...(get().profile ?? {}), shippedGcode: { start: 'G28' } } } as never)],
    ['a slice result and layer marks', () => set({ slice: { status: 'done', result: { id: 'r', layerZ: Float32Array.from([0.2]), warnings: [] }, stale: false }, layerMarks: { 'plate-1': [] } } as never)],
    ['copies with the same content', () => set({ overrides: { ...get().overrides }, easy: { ...get().easy }, plate: get().plate.map((e) => ({ ...e })) })],
    ['another plate shown and back', () => (set({ activePlate: 'plate-2' }), set({ activePlate: 'plate-1' }))],
  ]
  for (const [name, change] of holds) {
    it(`stays the same with ${name}`, () => {
      const before = sliceInputsKey(get())
      change()
      expect(sliceInputsKey(get())).toBe(before)
    })
  }

  // What picks a slot's filament preset outside INPUTS (so which tuned values apply): each must change the key.
  const slotMatch: [(typeof KEY_SLOT_MATCH)[number], () => void][] = [
    ['slotMatch', () => set({ slotMatch: { 1: { brand: 'Other', family: 'PLA', vendor: 'Other' } } } as never)],
    ['fileSlotTypes', () => set({ fileSlotTypes: ['PETG'] })],
    ['fileSlotVendors', () => set({ fileSlotVendors: ['Other'] })],
    ['printerModel', () => set({ printerModel: { id: 'p2', vendor: 'Bambu Lab', model: 'P1S' } })],
  ]
  for (const [name, change] of slotMatch) {
    it(`changes with ${name}`, () => {
      const before = sliceInputsKey(get())
      change()
      expect(sliceInputsKey(get())).not.toBe(before)
    })
  }

  it('covers every slice input: each is changed above or named as left out, with a reason', () => {
    const changed = new Set(changes.map(([input]) => input))
    for (const k of INPUTS) expect(changed.has(k) || k in KEY_LEAVES_OUT, k).toBe(true)
    for (const [k, why] of Object.entries(KEY_LEAVES_OUT)) expect(String(why).length, k).toBeGreaterThan(20)
    expect(new Set(slotMatch.map(([k]) => k))).toEqual(new Set(KEY_SLOT_MATCH))
  })

  // Every field of an object, each changed one way: a field that moves layers changes the key, one OBJECT_LEAVES_OUT
  // names does not. A new PlateEntry field fails to compile here until it is put in one group or the other.
  const LEFT_OUT = 'left out'
  const objectFields = {
    id: () => entry({ id: 'b' }),
    handle: () => entry({ handle: { ...get().plate[0]!.handle, hash: 'other' } }),
    parts: () => entry({ parts: get().plate[0]!.parts.map((p) => ({ ...p, slot: 3 })) }),
    transform: () => entry({ transform: compose({ position: [100, 101, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }),
    paint: () => entry({ paint: { 0: { color: { 0: '8' } } } }),
    volumes: () => entry({ volumes: [{ id: 'v', name: 'v', role: 'modifier' }] }),
    printable: () => entry({ printable: false }),
    slotOverrides: () => entry({ slotOverrides: { Body: 2 } }),
    partSettings: () => entry({ partSettings: { Body: { wall_loops: 3 } } }),
    brimPoints: () => entry({ brimPoints: [[0, 0, 0, 3]] }),
    layerRanges: () => entry({ layerRanges: [{ fromMm: 0, toMm: 1, settings: { layer_height: 0.1 } }] }),
    name: LEFT_OUT,
    colors: LEFT_OUT,
    thumb: LEFT_OUT,
    instanceOf: LEFT_OUT,
    splitOf: LEFT_OUT,
    locked: LEFT_OUT,
    source: LEFT_OUT,
    dimensions: LEFT_OUT,
    history: LEFT_OUT,
    landedAt: LEFT_OUT,
    roomMoves: LEFT_OUT,
  } satisfies Record<keyof PlateEntry, (() => void) | typeof LEFT_OUT>

  for (const [field, change] of Object.entries(objectFields)) {
    it(`${change === LEFT_OUT ? 'stays the same' : 'changes'} with the object's ${field}`, () => {
      const before = sliceInputsKey(get())
      if (change === LEFT_OUT) {
        expect(field in OBJECT_LEAVES_OUT, field).toBe(true)
        entry({ [field]: { any: 'value' } })
        expect(sliceInputsKey(get())).toBe(before)
      } else {
        expect(field in OBJECT_LEAVES_OUT, field).toBe(false)
        change()
        expect(sliceInputsKey(get())).not.toBe(before)
      }
    })
  }

  it('names a reason for every object field it leaves out, and leaves out only those', () => {
    for (const [k, why] of Object.entries(OBJECT_LEAVES_OUT)) {
      expect(objectFields[k as keyof typeof objectFields], k).toBe(LEFT_OUT)
      expect(why.length, k).toBeGreaterThan(10)
    }
  })

  it('counts a field it does not know yet, so a new one never goes unseen', () => {
    const before = sliceInputsKey(get())
    entry({ futureField: 1 })
    expect(sliceInputsKey(get())).not.toBe(before)
  })
})
