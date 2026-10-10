// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice by size: Auto slices a quick plate after an edit and holds a big one for Slice, Always slices both, Off
// neither. A saved on from before reads as Auto, a saved off as Off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { AUTO_SLICE_DELAY_MS, startAutoSlice } from '../src/state/auto-slice'
import { autoSliceFields, autoSliceMode } from '../src/state/auto-slice-mode'
import { normalizePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
/** An object of `tris` triangles: 700k is a big slice (about 1.75 s by the per-triangle factor), 1k a quick one. */
const entry = (x: number, tris: number) => ({ id: 'a', name: 'a', handle, parts: [{ indices: new Uint32Array(tris * 3), positions: new Float32Array(9) }], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] }) as never

function host() {
  const requests: SliceRequest[] = []
  const h = {
    kind: 'web',
    capabilities: { threads: 1 },
    slicer: {
      loadParts: async () => handle,
      loadModel: async () => handle,
      slice: (r: SliceRequest) => {
        requests.push(r)
        return new Promise(() => {})
      },
    },
  } as unknown as Host
  return { h, requests }
}

beforeEach(() => {
  vi.useFakeTimers()
  set({ plate: [entry(10, 1000)], ...autoSliceFields('auto'), sliceHeld: false, liveEdit: false, historyEdit: null, plateLoading: false, slice: { status: 'idle' }, resume: null, calibration: {}, layerMarks: {} })
})
afterEach(() => void vi.useRealTimers())

/** An edit, and the pause after it. */
async function edit(plate: unknown): Promise<void> {
  set({ plate: plate as never })
  await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 20)
}

describe('auto slice by size', () => {
  it('Auto slices a quick plate after an edit', async () => {
    const { h, requests } = host()
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await edit([entry(20, 1000)])
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(get().sliceHeld).toBe(false)
    stop()
  })

  it('Auto holds a big plate for Slice and says so, and lets go when the plate is quick again', async () => {
    const { h, requests } = host()
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await edit([entry(20, 700_000)])
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(0)
    expect(get().sliceHeld).toBe(true)
    await edit([entry(30, 1000)])
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(get().sliceHeld).toBe(false)
    stop()
  })

  it('Always slices a big plate too', async () => {
    const { h, requests } = host()
    set(autoSliceFields('always'))
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await edit([entry(20, 700_000)])
    await vi.advanceTimersByTimeAsync(50)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(get().sliceHeld).toBe(false)
    stop()
  })

  it('going from Auto to Always slices the held plate', async () => {
    const { h, requests } = host()
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await edit([entry(20, 700_000)])
    expect(get().sliceHeld).toBe(true)
    set(autoSliceFields('always'))
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 50)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    stop()
  })

  it('Off slices nothing and holds nothing', async () => {
    const { h, requests } = host()
    set(autoSliceFields('off'))
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await edit([entry(20, 700_000)])
    await edit([entry(30, 1000)])
    expect(requests).toHaveLength(0)
    expect(get().sliceHeld).toBe(false)
    stop()
  })
})

describe('the auto slice choice', () => {
  it('reads the two saved flags as one of three modes', () => {
    expect(autoSliceMode(autoSliceFields('auto'))).toBe('auto')
    expect(autoSliceMode(autoSliceFields('always'))).toBe('always')
    expect(autoSliceMode(autoSliceFields('off'))).toBe('off')
  })

  it('keeps a saved choice from before: on is Auto now, off stays Off', () => {
    const on = normalizePrefs({ autoSlice: true })
    expect(on.autoSlice).toBe(true)
    expect(on.autoSliceBySize).toBeUndefined()
    expect(autoSliceMode({ autoSlice: on.autoSlice!, autoSliceBySize: on.autoSliceBySize ?? true })).toBe('auto')
    const off = normalizePrefs({ autoSlice: false })
    expect(autoSliceMode({ autoSlice: off.autoSlice!, autoSliceBySize: off.autoSliceBySize ?? true })).toBe('off')
    expect(normalizePrefs({ autoSlice: true, autoSliceBySize: false }).autoSliceBySize).toBe(false)
  })
})
