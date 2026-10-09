// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finished slices leave their G-code and preview in the slicer, and nothing released them, so a session kept every
// slice it made. A slice is now released once the view and the plates out of view no longer hold it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SliceResult } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { clearProject } from '../src/project/new'
import { appStore, set, type PlateEntry } from '../src/state/store'
import { forgetPlateSlices, keptSliceIds, trackPlateSlices } from '../src/workspaces/preview/plate-slices'
import { startSliceRelease } from '../src/workspaces/preview/slice-release'

let n = 0
const result = (): SliceResult => ({ id: `slice-${++n}`, engine: 'sx', layerCount: 1, layerZ: new Float32Array([0.2]), layerTimeS: new Float32Array([1]), stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] })
const entry = (id: string): PlateEntry => ({ id, name: id, handle: { id: `m-${id}`, hash: 'h', name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts: [boxMesh(10, 10, 10)], colors: ['#ffffff'], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1] })
const preview = {} as never

function slicer() {
  const live = new Set<string>()
  return { live, made: (r: SliceResult) => (live.add(r.id), r), release: (id: string) => void live.delete(id) }
}

/** A slice of the plate in view finishing. */
function sliced(sl: ReturnType<typeof slicer>): SliceResult {
  const r = sl.made(result())
  set((s) => ({ slice: { status: 'running', progress: null, startedAt: 0, ...(s.slice.status === 'done' ? { last: s.slice.result } : {}) } }))
  set({ slice: { status: 'done', result: r, stale: false }, preview })
  return r
}

let stopTrack = () => {}
beforeEach(() => {
  vi.useFakeTimers()
  forgetPlateSlices()
  stopTrack = trackPlateSlices()
  set({ plate: [entry('a')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [entry('b')], settings: {} }], activePlate: 'p1', slice: { status: 'idle' }, preview: null })
})
afterEach(() => {
  stopTrack()
  vi.useRealTimers()
})

describe('releasing slices', () => {
  it('lets go of a slice once a newer one replaces it, after the delay', () => {
    const sl = slicer()
    const stop = startSliceRelease(sl, { delayMs: 100 })
    const first = sliced(sl)
    vi.advanceTimersByTime(200)
    const second = sliced(sl)
    vi.advanceTimersByTime(50)
    // A read that started just before the new slice landed still has the old one.
    expect(sl.live.has(first.id)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(sl.live.has(first.id)).toBe(false)
    expect(sl.live.has(second.id)).toBe(true)
    stop()
  })

  it('keeps the slice of a plate out of view, and lets it go with the project', () => {
    const sl = slicer()
    const stop = startSliceRelease(sl, { delayMs: 10 })
    const one = sliced(sl)
    set({ activePlate: 'p2', plate: [entry('b')], slice: { status: 'idle' }, preview: null })
    vi.advanceTimersByTime(50)
    expect(keptSliceIds()).toEqual([one.id])
    expect(sl.live.has(one.id)).toBe(true)
    clearProject()
    vi.advanceTimersByTime(50)
    expect(keptSliceIds()).toEqual([])
    expect(sl.live.size).toBe(0)
    stop()
  })

  it('50 load, edit, slice and close cycles leave no slice held', () => {
    const sl = slicer()
    const stop = startSliceRelease(sl, { delayMs: 10 })
    for (let i = 0; i < 50; i++) {
      set({ plate: [entry(`a${i}`)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [entry(`b${i}`)], settings: {} }], activePlate: 'p1' })
      sliced(sl)
      vi.advanceTimersByTime(20)
      // An edit and the slice after it.
      sliced(sl)
      vi.advanceTimersByTime(20)
      // The other plate, sliced too, and back.
      set({ activePlate: 'p2', plate: [entry(`b${i}`)], slice: { status: 'idle' }, preview: null })
      sliced(sl)
      set({ activePlate: 'p1', plate: [entry(`a${i}`)] })
      vi.advanceTimersByTime(20)
      expect(sl.live.size).toBeLessThanOrEqual(2)
      clearProject()
      vi.advanceTimersByTime(20)
    }
    expect([...sl.live], JSON.stringify({ kept: keptSliceIds(), slice: appStore.getState().slice.status })).toEqual([])
    stop()
  })
})
