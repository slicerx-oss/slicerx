// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate with its own layer heights slices at the tops they give, in place of sleipnir's plan and the fixed layer
// height. A plate without them sends exactly the request it sent before.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest } from '@slicerx/contracts'
import { setGeomProvider } from '../src/geom/client'
import { forgetLayerPlans } from '../src/plate/smart-layer'
import { addPlate, allPlates, duplicatePlate, setPlateLayerProfile } from '../src/plate/plates'
import { appProject } from '../src/workspaces/mimir/project'
import { layerLimits, profileTops } from '../src/plate/layer-profile'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { slicePlate } from '../src/state/actions'
import { plateSliceConfig } from '../src/state/slice-plate'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 4], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }
const entry = (extra: Record<string, unknown> = {}) => ({ id: 'a', name: 'tuned', handle, parts: [{ ...boxMesh(10, 10, 4), name: 'Body', slot: 1 }], colors: [], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), ...extra }) as never
const PROFILE: [number, number][] = [[0.2, 0.08], [2, 0.08], [3, 0.24]]

function rawPreview(): ArrayBuffer {
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + 2 * 4 + 8 + SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, 1, true)
  dv.setUint32(12, 1, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  dv.setUint32(o, 0, true)
  dv.setUint32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o, 0.2, true)
  dv.setFloat32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o + 8, 10, true)
  dv.setFloat32(o + 16, 0.2, true)
  dv.setUint16(o + 20, 400, true)
  dv.setUint16(o + 22, 200, true)
  return raw
}

function engine(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  let n = 0
  const host = {
    kind: 'web',
    capabilities: { threads: 1 },
    slicer: {
      loadParts: async () => handle,
      release: () => undefined,
      slice: async (r: SliceRequest) => {
        requests.push(r)
        return { id: `r${++n}`, layerZ: Float32Array.from([0.2]), warnings: [] }
      },
      getPreview: async () => rawPreview(),
    },
  } as unknown as Host
  return { host, requests }
}

// The request keys the app sent on main for this plate (7fb56d5ef), so the request without a profile stays as it was.
const OPTION_KEYS = { on: ['emitGcode', 'emitPreview', 'layerTopsMm', 'modelName', 'plateName', 'plateNumber', 'previewFormat', 'shards'], off: ['emitGcode', 'emitPreview', 'modelName', 'plateName', 'plateNumber', 'previewFormat', 'shards'] }
const REQUEST_KEYS = ['config', 'options', 'plate']

let plans = 0
const notes = () => {
  const s = get().slice
  return s.status === 'done' ? s.result.warnings.map((w) => w.message) : [`not done: ${JSON.stringify(s)}`]
}
const expected = () => profileTops(PROFILE, 4, layerLimits(plateSliceConfig(get(), get().plates.find((p) => p.id === get().activePlate))))

beforeEach(() => {
  forgetLayerPlans()
  plans = 0
  setGeomProvider({ call: async <T,>() => (plans++, { layerTopsMm: [0.2, 0.4, 0.6] }) as T })
  set({ plate: [entry()], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {}, overrides: {}, objectSettings: {}, easy: { ...get().easy, varyLayerHeight: true } })
})

afterEach(() => {
  forgetLayerPlans()
  setGeomProvider(null)
})

describe("a plate's own layer heights", () => {
  it('slice at the tops the profile gives, and sleipnir plans nothing', async () => {
    setPlateLayerProfile('plate-1', PROFILE)
    const { host, requests } = engine()
    await slicePlate(host)
    const tops = requests[0]!.options?.layerTopsMm
    expect(tops).toEqual(expected())
    expect(tops![0]).toBe(0.2)
    expect(Number((tops![1]! - tops![0]!).toFixed(4))).toBe(0.08)
    expect(tops![tops!.length - 1]).toBeGreaterThanOrEqual(4)
    expect(plans).toBe(0)
    // Marked exact, so a multi-color plate keeps them as drawn.
    expect(requests[0]!.options?.layerTopsExact).toBe(true)
  })

  it('replace a fixed layer height too', async () => {
    set({ easy: { ...get().easy, varyLayerHeight: false } })
    setPlateLayerProfile('plate-1', PROFILE)
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options?.layerTopsMm).toEqual(expected())
    expect(requests[0]!.options?.layerTopsExact).toBe(true)
  })

  it('name an object whose own layer height they replace, in the engine words', async () => {
    set({ objectSettings: { a: { layer_height: 0.3 } } })
    setPlateLayerProfile('plate-1', PROFILE)
    await slicePlate(engine().host)
    expect(notes()).toEqual(["This plate's own layer heights replace the layer heights objects set for themselves (tuned 0.3 mm)."])
  })

  it('give way to a resume plan, which restarts the failed job at its own layers', async () => {
    setPlateLayerProfile('plate-1', PROFILE)
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: [0.2, 0.4, 0.6, 0.8] } })
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options?.layerTopsMm).toEqual([0.2, 0.4, 0.6, 0.8])
    // The job's own layers, sent as exact and sliced so the engine keeps them as the job printed them.
    expect(requests[0]!.options?.layerTopsExact).toBe(true)
    expect(requests[0]!.options?.layerTopsSliced).toBe(true)
  })

  it('resumed with no stored job layers, slice at the plate own tops, which stretch as in the job', async () => {
    // The resume dialog stores no tops when the slice is not current (a reopened project, the fleet menu).
    setPlateLayerProfile('plate-1', PROFILE)
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 } } })
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options).toMatchObject({ resumeFromLayer: 2, layerTopsMm: expected(), layerTopsExact: true })
    expect(requests[0]!.options).not.toHaveProperty('layerTopsSliced')
  })

  it('are not used on a calibration plate, which keeps its own bands', async () => {
    setPlateLayerProfile('plate-1', PROFILE)
    set({ calibration: { 'plate-1': { ranges: [] } } as never, easy: { ...get().easy, varyLayerHeight: false } })
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options?.layerTopsMm).toBeUndefined()
  })

  it('cleared, the plate slices as before', async () => {
    setPlateLayerProfile('plate-1', PROFILE)
    setPlateLayerProfile('plate-1', null)
    expect(get().plates[0]!.settings).toEqual({})
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options?.layerTopsMm).toEqual([0.2, 0.4, 0.6])
    expect(plans).toBe(1)
  })

  it('set or cleared on the shown plate, make its finished slice stale; on another plate, leave it be', async () => {
    set({ plates: [...get().plates, { id: 'plate-2', name: 'Plate 2', objects: [], settings: {} }] })
    await slicePlate(engine().host)
    const done = () => get().slice as { status: string; stale?: boolean }
    expect(done()).toMatchObject({ status: 'done', stale: false })
    setPlateLayerProfile('plate-2', PROFILE)
    expect(done().stale).toBe(false)
    setPlateLayerProfile('plate-1', PROFILE)
    expect(done().stale).toBe(true)
    await slicePlate(engine().host)
    expect(done().stale).toBe(false)
    setPlateLayerProfile('plate-1', null)
    expect(done().stale).toBe(true)
  })

  it('never go to a plate made through mimir', async () => {
    setPlateLayerProfile('plate-1', PROFILE)
    const project = appProject({ slicer: { loadParts: async () => handle } } as never)()
    project.setPlates([{ index: 1, items: [{ objectId: 'a', copies: 1 }] }, { index: 2, items: [{ objectId: 'a', copies: 1 }] }])
    const plates = allPlates()
    expect(plates).toHaveLength(2)
    expect(plates[1]!.objects).toHaveLength(1)
    expect(plates[0]!.settings.layerProfile).toEqual(PROFILE)
    expect(plates[1]!.settings.layerProfile).toBeUndefined()
  })

  it('stay with a duplicated plate but never go to a new one', () => {
    setPlateLayerProfile('plate-1', PROFILE)
    const copy = duplicatePlate('plate-1')!
    expect(get().plates.find((p) => p.id === copy)!.settings.layerProfile).toEqual(PROFILE)
    const fresh = addPlate(get().plates[0]!.settings, false)
    expect(get().plates.find((p) => p.id === fresh)!.settings.layerProfile).toBeUndefined()
  })
})

describe('a plate without its own layer heights', () => {
  it('sends the same request as before: sleipnir tops with it on, none with a fixed height', async () => {
    const on = engine()
    await slicePlate(on.host)
    expect(on.requests[0]!.options?.layerTopsMm).toEqual([0.2, 0.4, 0.6])
    // sleipnir's tops are not exact: the engine keeps its fixed layers where colors change.
    expect(on.requests[0]!.options).not.toHaveProperty('layerTopsExact')
    set({ easy: { ...get().easy, varyLayerHeight: false }, slice: { status: 'idle' } })
    const off = engine()
    await slicePlate(off.host)
    expect(off.requests[0]!.options).not.toHaveProperty('layerTopsMm')
    expect(notes()).toEqual([])
    // Only the keys a plate of this kind sent before; a profile adds nothing else to the request.
    expect(Object.keys(on.requests[0]!.options ?? {}).sort()).toEqual(OPTION_KEYS.on)
    expect(Object.keys(off.requests[0]!.options ?? {}).sort()).toEqual(OPTION_KEYS.off)
    expect(Object.keys(on.requests[0]!).sort()).toEqual(REQUEST_KEYS)
  })
})
