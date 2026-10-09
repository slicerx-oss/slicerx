// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice starts soon after an edit, slices a drag once on release, and never lets a slice pass for a plate that
// changed while it ran.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest } from '@slicerx/contracts'
import { slicePlate } from '../src/state/actions'
import { AUTO_SLICE_DELAY_MS, startAutoSlice } from '../src/state/auto-slice'
import { beginLiveEdit, endLiveEdit } from '../src/state/live-edit'
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
      slice: (r: SliceRequest) => {
        requests.push(r)
        return new Promise((resolve) => pending.push(() => resolve({ id: `r${requests.length}`, layerZ: Float32Array.from([0.2]), warnings: [] })))
      },
      getPreview: async () => rawPreview(),
    },
  } as unknown as Host
  return { h, requests, land: () => pending.shift()?.() }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  set({ plate: [entry(10)], autoSlice: true, liveEdit: false, historyEdit: null, plateLoading: false, slice: { status: 'idle' }, resume: null, calibration: {}, layerMarks: {} })
})
afterEach(() => {
  endLiveEdit()
  vi.useRealTimers()
})

describe('auto slice timing', () => {
  it('starts a slice a short pause after an edit', async () => {
    const { h, requests } = host()
    const stop = startAutoSlice(h)
    set({ plate: [entry(20)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS - 10)
    expect(requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(20)
    // The slice reads the profile first, through a module loaded on demand.
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(AUTO_SLICE_DELAY_MS).toBeLessThanOrEqual(200)
    stop()
  })

  it('slices a drag once, on release, however long it pauses', async () => {
    const { h, requests } = host()
    const stop = startAutoSlice(h)
    beginLiveEdit()
    for (let x = 11; x < 20; x++) {
      set({ plate: [entry(x)] })
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(requests).toHaveLength(0)
    endLiveEdit()
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(1)
    stop()
  })

  it('marks a slice stale when the plate changed before it showed as running', async () => {
    const { h, land } = host()
    const run = slicePlate(h)
    await flush()
    // The slice read the plate at x 10; the edit lands while the engine works, with nothing watching to cancel it.
    set({ plate: [entry(30)] })
    land()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
  })

  it('shows a slice as current when nothing changed', async () => {
    const { h, land } = host()
    const run = slicePlate(h)
    await flush()
    land()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
  })
})
