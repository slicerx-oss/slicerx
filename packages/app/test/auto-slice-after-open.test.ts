// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened project stays on Slice plate: no auto slice right after the open, whatever the plate's size, so the view
// does not switch to the toolpaths and the right pane stays as it was. A later edit auto-slices under the setting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { AUTO_SLICE_DELAY_MS, startAutoSlice } from '../src/state/auto-slice'
import { autoSliceFields } from '../src/state/auto-slice-mode'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
/** A quick object (1k triangles), well under the big-slice size. */
const entry = (x: number) => ({ id: 'a', name: 'a', handle, parts: [{ indices: new Uint32Array(3000), positions: new Float32Array(9) }], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] }) as never

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
  set({ plate: [], ...autoSliceFields('auto'), sliceHeld: false, heldByOpenedProject: false, liveEdit: false, historyEdit: null, plateLoading: false, revealHold: false, sliceDuringOpen: false, slice: { status: 'idle' }, resume: null, calibration: {}, layerMarks: {}, workspace: 'prepare', modelMode: 'slice', preview: null })
})
afterEach(() => void vi.useRealTimers())

/** A project open as the app runs one: held and loading, its objects placed, then both end in one change. */
async function openProject(): Promise<void> {
  set({ plateLoading: true, revealHold: true })
  set({ plate: [entry(10)] })
  await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS - 50)
  set({ plateLoading: false, sliceDuringOpen: false, revealHold: false })
  await settle()
}

/** Long enough for a slice to start if one was going to: its timers, then the modules it loads on the way. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS * 4)
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 400))
  vi.useFakeTimers()
}

describe('auto slice after an opened project', () => {
  for (const mode of ['auto', 'always'] as const) {
    it(`does not slice a small opened project (${mode}), so the view and the right pane stay as they were`, async () => {
      const { h, requests } = host()
      set(autoSliceFields(mode))
      const rails = get().rails
      const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
      await openProject()
      expect(requests).toHaveLength(0)
      expect(get().slice.status).toBe('idle')
      // Slice is the action until the person presses it (the footer's Slice plate)
      expect(get().sliceHeld).toBe(true)
      // the footer names the open as the reason, not the plate's size
      expect(get().heldByOpenedProject).toBe(true)
      expect({ workspace: get().workspace, modelMode: get().modelMode, preview: get().preview }).toEqual({ workspace: 'prepare', modelMode: 'slice', preview: null })
      expect(get().rails).toBe(rails)
      stop()
    })
  }

  it('a later edit still auto-slices under the setting', async () => {
    const { h, requests } = host()
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await openProject()
    expect(requests).toHaveLength(0)
    set({ plate: [entry(20)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 20)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(get().sliceHeld).toBe(false)
    stop()
  })

  it('with Auto slice off, a later edit does not slice either', async () => {
    const { h, requests } = host()
    set(autoSliceFields('off'))
    const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
    await openProject()
    set({ plate: [entry(20)] })
    await settle()
    expect(requests).toHaveLength(0)
    stop()
  })
})
