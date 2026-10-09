// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A binary STL shown from its own triangles slices while its open still runs. When the engine's import then changes
// the mesh, that early slice never stands as the plate's slice: it is canceled or stale, and the slice of the mesh
// the import made replaces it. When the import changes nothing, the early slice is the plate's slice, sliced once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest } from '@slicerx/contracts'
import type { AutoImport } from '../src/geom/cad'
import { scanStl } from '../src/export/stl-scan'
import { startAutoSlice } from '../src/state/auto-slice'
import { addAutoImport } from '../src/state/import-auto'
import { appStore, get, set } from '../src/state/store'
import { noteSliceTiming } from '../src/state/slice-estimate'
import { fitSettled } from '../src/plate/fit-state'

const CORNERS = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
const TRIS = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]

function stl(): ArrayBuffer {
  const buf = new ArrayBuffer(84 + TRIS.length * 50)
  const v = new DataView(buf)
  v.setUint32(80, TRIS.length, true)
  TRIS.forEach((t, i) => t.forEach((c, k) => CORNERS[c]!.forEach((x, a) => v.setFloat32(84 + i * 50 + 12 + k * 12 + a * 4, x, true))))
  return buf
}

function answer(mesh: { positions: number[]; indices: number[] }): AutoImport {
  return {
    name: 'cube.stl',
    format: 'stl',
    objects: [{ name: 'cube.stl', parts: [{ name: 'cube.stl', slot: 1, color: null, mesh, watertight: true }], repair: {} as never }],
    unit: { unit: 'millimeter', scale: 1, confidence: 'none', autoApply: false, reason: '', sizeBefore: [10, 10, 10], sizeAfter: [10, 10, 10] },
    summary: [],
    warnings: [],
    slotColors: [],
  } as AutoImport
}

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

/** A host that names each loaded mesh, records each slice and lands it when the test says. */
function host() {
  const requests: SliceRequest[] = []
  const pending: (() => void)[] = []
  let meshes = 0
  const h = {
    kind: 'web',
    capabilities: { threads: 1 },
    slicer: {
      loadParts: async (name: string) => ({ id: `mesh${++meshes}`, hash: name, name, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name, slot: 1, triangles: 12 }] }),
      release: () => undefined,
      slice: (r: SliceRequest) => {
        requests.push(r)
        const id = `r${requests.length}`
        return new Promise((resolve) => pending.push(() => resolve({ id, layerZ: Float32Array.from([0.2]), warnings: [] })))
      },
      getPreview: async () => rawPreview(),
    },
  } as unknown as Host
  return { h, requests, land: () => pending.shift()?.() }
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

/** Every slice that stood as the plate's slice (done and not stale), by result id. */
function standing(): { ids: string[]; stop: () => void } {
  const ids: string[] = []
  const stop = appStore.subscribe((s) => {
    if (s.slice.status === 'done' && !s.slice.stale && !ids.includes(s.slice.result.id)) ids.push(s.slice.result.id)
  })
  return { ids, stop }
}

let stops: (() => void)[] = []
beforeEach(() => set({ plate: [], autoSlice: true, liveEdit: false, historyEdit: null, plateLoading: true, sliceDuringOpen: false, slice: { status: 'idle' }, resume: null, calibration: {}, layerMarks: {} }))
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

describe('slicing a binary STL while its open runs', () => {
  it('when the import changes the mesh, the early slice never stands and the new mesh is sliced', async () => {
    const { h, requests, land } = host()
    stops.push(startAutoSlice(h, 0))
    const seen = standing()
    stops.push(seen.stop)
    let reply: (r: AutoImport) => void = () => undefined
    const open = addAutoImport(h, 'cube.stl', stl(), () => new Promise((r) => (reply = r)))
    // The shown mesh slices before the engine has answered.
    await until(() => requests.length === 1)
    expect(requests[0]!.plate.objects[0]!.mesh).toBe('mesh1')
    // The import repairs it: a different mesh takes its place, and the plate stops loading.
    const repaired = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
    reply(answer(repaired))
    await open
    set({ plateLoading: false, sliceDuringOpen: false })
    await until(() => requests.length === 2)
    expect(requests[1]!.plate.objects[0]!.mesh).toBe('mesh2')
    // The early slice lands after the change, then the real one.
    land()
    land()
    await until(() => get().slice.status === 'done' && !(get().slice as { stale?: boolean }).stale)
    expect(seen.ids).toEqual(['r2'])
  })

  it('when the import changes nothing, the early slice is the plate\'s slice, sliced once', async () => {
    const { h, requests, land } = host()
    stops.push(startAutoSlice(h, 0))
    const seen = standing()
    stops.push(seen.stop)
    let reply: (r: AutoImport) => void = () => undefined
    const open = addAutoImport(h, 'cube.stl', stl(), () => new Promise((r) => (reply = r)))
    await until(() => requests.length === 1)
    const shown = scanStl(new Uint8Array(stl()))!
    reply(answer({ positions: [...shown.positions], indices: [...shown.indices] }))
    await open
    set({ plateLoading: false, sliceDuringOpen: false })
    land()
    await until(() => get().slice.status === 'done')
    await new Promise((r) => setTimeout(r, 50))
    expect(requests).toHaveLength(1)
    expect(seen.ids).toEqual(['r1'])
  })
})

describe('a big slice (slice-estimate.ts)', () => {
  // The last slice of this plate took a minute on the same 12 triangles: the cube's slice now counts as big.
  beforeEach(() => noteSliceTiming(get().activePlate, { triangles: 12, ms: 60_000 }))
  afterEach(() => noteSliceTiming(get().activePlate, { triangles: 12, ms: 1 }))

  it('does not start while the file opens, and waits for the fit check after', async () => {
    const { h, requests, land } = host()
    stops.push(startAutoSlice(h, 0, 60_000))
    let reply: (r: AutoImport) => void = () => undefined
    const open = addAutoImport(h, 'cube.stl', stl(), () => new Promise((r) => (reply = r)))
    await until(() => get().plate.length === 1)
    expect(get().sliceDuringOpen).toBe(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(requests).toHaveLength(0)
    const shown = scanStl(new Uint8Array(stl()))!
    reply(answer({ positions: [...shown.positions], indices: [...shown.indices] }))
    await open
    set({ plateLoading: false })
    // Open over: the slice still waits for the plate's fit check.
    await new Promise((r) => setTimeout(r, 50))
    expect(requests).toHaveLength(0)
    fitSettled(get().plate)
    await until(() => requests.length === 1)
    land()
    await until(() => get().slice.status === 'done')
  })

  it('goes anyway when the fit check never reports', async () => {
    const { h, requests } = host()
    stops.push(startAutoSlice(h, 0, 100))
    const shown = scanStl(new Uint8Array(stl()))!
    await addAutoImport(h, 'cube.stl', stl(), async () => answer({ positions: [...shown.positions], indices: [...shown.indices] }))
    set({ plateLoading: false })
    await new Promise((r) => setTimeout(r, 40))
    expect(requests).toHaveLength(0)
    await until(() => requests.length === 1)
  })

  it('a small slice does not wait for the fit check', async () => {
    noteSliceTiming(get().activePlate, { triangles: 12, ms: 1 })
    const { h, requests } = host()
    stops.push(startAutoSlice(h, 0, 60_000))
    const shown = scanStl(new Uint8Array(stl()))!
    await addAutoImport(h, 'cube.stl', stl(), async () => answer({ positions: [...shown.positions], indices: [...shown.indices] }))
    set({ plateLoading: false })
    await until(() => requests.length >= 1)
  })
})
