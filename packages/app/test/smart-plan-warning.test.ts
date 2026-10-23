// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When the app plans the smart layers itself it sends their tops with the slice, so the engine plans none and says
// nothing about an object whose own layer height they replace. The app says it, once per slice, with the engine's wording.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest, type SliceWarning } from '@slicerx/contracts'
import { setGeomProvider } from '../src/geom/client'
import { forgetLayerPlans } from '../src/plate/smart-layer'
import { slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'lid', slot: 1, triangles: 1 }] }
const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const part = () => ({ name: 'lid', slot: 1, positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) })
const entry = (extra: Record<string, unknown> = {}) => ({ id: 'a', name: 'tuned', handle, parts: [part()], colors: [], transform: id, ...extra }) as never

/** One layer of one move, enough for the app to read. */
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

/** A host whose slice lands at once with the warnings the engine would give, and records the request. */
function engine(warnings: SliceWarning[] = []): { host: Host; requests: SliceRequest[] } {
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
        return { id: `r${++n}`, layerZ: Float32Array.from([0.2]), warnings: [...warnings] }
      },
      getPreview: async () => rawPreview(),
    },
  } as unknown as Host
  return { host, requests }
}

const SMART = /^Smart layer heights replace the layer heights objects set for themselves/
const smartNotes = (): string[] => {
  const s = get().slice
  return s.status === 'done' ? s.result.warnings.map((w) => w.message).filter((m) => SMART.test(m)) : ['not done']
}

beforeEach(() => {
  forgetLayerPlans()
  // The app's own plan: the geometry engine answers the layer tops the slice then carries.
  setGeomProvider({ call: async <T,>() => ({ layerTopsMm: [0.2, 0.4, 0.6] }) as T })
  set({ plate: [entry()], resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {}, overrides: {}, objectSettings: {}, easy: { ...get().easy, varyLayerHeight: true } })
})

afterEach(() => {
  forgetLayerPlans()
  setGeomProvider(null)
})

describe('smart layers over a layer height an object sets', () => {
  it('names the object and its height among the slice warnings when the app sends its own plan', async () => {
    set({ objectSettings: { a: { layer_height: 0.3 } } })
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options?.layerTopsMm).toEqual([0.2, 0.4, 0.6])
    expect(smartNotes()).toEqual(['Smart layer heights replace the layer heights objects set for themselves (tuned 0.3 mm).'])
    const s = get().slice
    expect(s.status === 'done' && s.result.warnings.find((w) => SMART.test(w.message))?.code).toBe('unsupported_setting')
  })

  it('reads a height held as text', async () => {
    set({ objectSettings: { a: { layer_height: '0.3' } } })
    await slicePlate(engine().host)
    expect(smartNotes()).toEqual(['Smart layer heights replace the layer heights objects set for themselves (tuned 0.3 mm).'])
  })

  it('names the object only, not a part that sets a layer height too', async () => {
    set({ plate: [entry({ partSettings: { lid: { layer_height: 0.25 } } })], objectSettings: { a: { layer_height: 0.3 } } })
    await slicePlate(engine().host)
    expect(smartNotes()).toEqual(['Smart layer heights replace the layer heights objects set for themselves (tuned 0.3 mm).'])
  })

  it('says nothing for a part that sets a layer height when the object sets none', async () => {
    set({ plate: [entry({ partSettings: { lid: { layer_height: 0.25 } } })] })
    await slicePlate(engine().host)
    expect(smartNotes()).toEqual([])
  })

  it('keeps the engine\'s own warnings, and says it once per slice', async () => {
    set({ objectSettings: { a: { layer_height: 0.3 } } })
    const { host } = engine([{ code: 'thin_wall', message: 'Thin wall.' }])
    await slicePlate(host)
    await slicePlate(host)
    const s = get().slice
    expect(s.status === 'done' && s.result.warnings.map((w) => w.message)).toEqual(['Thin wall.', 'Smart layer heights replace the layer heights objects set for themselves (tuned 0.3 mm).'])
  })

  it('does not say it twice when the engine already did', async () => {
    set({ objectSettings: { a: { layer_height: 0.3 } } })
    const said = { code: 'unsupported_setting' as const, message: 'Smart layer heights replace the layer heights objects set for themselves (tuned 0.3 mm).' }
    await slicePlate(engine([said]).host)
    expect(smartNotes()).toHaveLength(1)
  })

  it('says nothing when no object sets a layer height', async () => {
    set({ objectSettings: { a: { wall_loops: 5 } } })
    await slicePlate(engine().host)
    expect(smartNotes()).toEqual([])
  })

  it('says nothing with smart layers off, where each object keeps its own height', async () => {
    set({ objectSettings: { a: { layer_height: 0.3 } }, easy: { ...get().easy, varyLayerHeight: false } })
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests[0]!.options?.layerTopsMm).toBeUndefined()
    expect(smartNotes()).toEqual([])
  })

  it('says nothing for an object set not to print', async () => {
    set({ plate: [entry({ printable: false }), entry({ id: 'b', name: 'plain' })], objectSettings: { a: { layer_height: 0.3 } }, overrides: { print_sequence: 'by object' } })
    await slicePlate(engine().host)
    expect(smartNotes()).toEqual([])
  })
})
