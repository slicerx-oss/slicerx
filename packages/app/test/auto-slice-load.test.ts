// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice started before its code has loaded: an edit made while it loads slices exactly once, and no edit slices nothing.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest } from '@slicerx/contracts'
import { AUTO_SLICE_DELAY_MS, autoSlicePending, startAutoSlice } from '../src/state/auto-slice'
import { startAutoSliceLoaded } from '../src/state/auto-slice-load'
import { cancelSlice } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = (x: number) => ({ id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] }) as never

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

/** A host that records each slice and lands it when the test says. */
function host() {
  const requests: SliceRequest[] = []
  const pending: (() => void)[] = []
  const h = {
    kind: 'web',
    capabilities: { threads: 1 },
    slicer: {
      loadParts: async () => handle,
      loadModel: async () => handle,
      slice: (r: SliceRequest, o?: { signal?: AbortSignal }) => {
        requests.push(r)
        // lands when the test says; a canceled one stops, as the engine's does
        return new Promise((resolve, reject) => {
          o?.signal?.addEventListener('abort', () => reject(new DOMException('Slice canceled', 'AbortError')))
          pending.push(() => resolve({ id: `r${requests.length}`, layerZ: Float32Array.from([0.2]), warnings: [] }))
        })
      },
      getPreview: async () => rawPreview(),
    },
  } as unknown as Host
  return { h, requests, land: () => pending.shift()?.() }
}

/** A stand-in for the code's dynamic import that resolves only when the test opens it. */
function loader() {
  let open: () => void = () => undefined
  const loaded = new Promise<{ startAutoSlice: typeof startAutoSlice }>((resolve) => (open = () => resolve({ startAutoSlice })))
  return { load: () => loaded, open }
}

// The slice reads the profile first, through modules loaded on demand. Load them before the clock that matters starts: a
// cold worker on a busy machine takes tens of seconds to transform them, so the waits below allow for that.
beforeAll(async () => void (await Promise.all([import('../src/state/slice-plate'), import('../src/state/profile-sync'), import('../src/adapters/profile')])))

beforeEach(() => {
  vi.useFakeTimers()
  set({ plate: [entry(10)], autoSlice: true, liveEdit: false, historyEdit: null, plateLoading: false, revealHold: false, exampleSeeding: false, slice: { status: 'idle' }, resume: null, calibration: {}, layerMarks: {} })
})
// each watch a test starts stops after it, even when the test fails partway
const stops: (() => void)[] = []
const started = (stop: () => void): void => void stops.push(stop)

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  // the slice a test leaves running stops, so the next test's slices do not wait for it
  cancelSlice({ quiet: true })
  vi.useRealTimers()
})

describe('auto slice while its code loads', () => {
  it('slices once for an edit made before the code arrived', async () => {
    const { h, requests } = host()
    const { load, open } = loader()
    started(startAutoSliceLoaded(h, load))
    set({ plate: [entry(20)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS * 10)
    // nothing watches yet, so nothing slices
    expect(requests).toHaveLength(0)
    open()
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 45_000 })
    await vi.waitFor(() => expect(autoSlicePending()).toBe(false), { timeout: 45_000 })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS * 10)
    expect(requests).toHaveLength(1)
  })

  it('slices nothing when nothing changed while it loaded, and then follows edits as usual', async () => {
    const { h, requests } = host()
    const { load, open } = loader()
    started(startAutoSliceLoaded(h, load))
    open()
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS * 10)
    expect(autoSlicePending()).toBe(false)
    expect(requests).toHaveLength(0)
    expect(get().slice.status).toBe('idle')
    // the watch is running: the next edit slices once
    set({ plate: [entry(30)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 45_000 })
  })

  it('never starts when stopped before the code arrived', async () => {
    const { h, requests } = host()
    const { load, open } = loader()
    startAutoSliceLoaded(h, load)()
    set({ plate: [entry(40)] })
    open()
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS * 10)
    expect(autoSlicePending()).toBe(false)
    expect(requests).toHaveLength(0)
  })
})
