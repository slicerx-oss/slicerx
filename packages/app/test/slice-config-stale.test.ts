// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The nozzle volume, an opened project's flush matrix and its G-code values (KEY_CONFIG) sit outside the slice inputs,
// and no setter marks a slice stale when they change. After a printer change, the new printer's nozzle volume lands
// after the slice (Prepare sets it once the printer's profile data loads): the app's Print and Export and mimir must all
// read that slice as stale on a multi-color plate, and auto slice slices again. A single-color plate, whose G-code has
// no flush volumes, keeps its slice.
import type { Host, MeshHandle, SliceResult } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { needsSlice, sliceStamp, stampBlock } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { STALE_SLICE } from '../src/state/actions'
import { startAutoSlice } from '../src/state/auto-slice'
import { get, set, type PlateEntry } from '../src/state/store'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'

const handle = (id: string, slot: number): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot, triangles: 12 }] })
const part = (id: string, x: number, slot: number): PlateEntry => ({ id, name: id, handle: handle(id, slot), parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot }], colors: ['#ffffff'], transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const result = { id: 'r1', engine: 'sx', layerCount: 1, layerZ: new Float32Array(), layerTimeS: new Float32Array(), warnings: [], stats: { timeS: 60, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 } as unknown as SliceResult

/** `plate` on screen with a finished slice of it, stamped as slicePlate stamps one, on the first printer. */
function sliced(plate: PlateEntry[]) {
  set({ printerModel: { id: 'mk4', vendor: 'Prusa', model: 'MK4' }, printerNozzleVolume: 107, projectFlush: null, projectScriptKeys: null, autoSlice: false, layerMarks: {}, resume: null } as never)
  set({ plate, plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1' })
  set({ slice: { status: 'done', result, stale: false, stamp: sliceStamp(get()) } } as never)
}

/** A printer change, and the new printer's nozzle volume as Prepare sets it once that printer's profile data loads. */
function newPrinter() {
  set({ printerModel: { id: 'xl', vendor: 'Prusa', model: 'XL' } } as never)
  set({ printerNozzleVolume: 140 })
}

afterEach(() => vi.restoreAllMocks())

describe("a nozzle volume that lands after the slice", () => {
  it('on a two-color plate: Print, Export and mimir all read the slice as stale', () => {
    sliced([part('a', 60, 1), part('b', 120, 2)])
    const fingerprint = plateFingerprint(get(), 1)
    expect(stampBlock(get(), get().slice.status === 'done' ? get().slice.stamp : undefined)).toBeNull()
    newPrinter()
    const s = get()
    expect(stampBlock(s, s.slice.status === 'done' ? s.slice.stamp : undefined)).toBe(STALE_SLICE)
    expect(needsSlice(s)).toBe(true)
    expect(plateFingerprint(s, 1)).not.toBe(fingerprint)
  })

  it("on a single-color plate the slice stays current: its G-code has no flush volumes", () => {
    sliced([part('a', 60, 1)])
    const fingerprint = plateFingerprint(get(), 1)
    set({ printerNozzleVolume: 140 })
    const s = get()
    expect(stampBlock(s, s.slice.status === 'done' ? s.slice.stamp : undefined)).toBeNull()
    expect(needsSlice(s)).toBe(false)
    expect(plateFingerprint(s, 1)).toBe(fingerprint)
  })

  it("an opened project's flush matrix changing does the same", () => {
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ projectFlush: { slots: [{ color: '#ffffff', type: 'PLA' }, { color: '#000000', type: 'PLA' }], n: 2, matrix: [0, 300, 300, 0], multiplier: 1 } } as never)
    expect(needsSlice(get())).toBe(true)
  })

  it('with auto slice on, the slice goes stale and a new one is scheduled', async () => {
    vi.useFakeTimers()
    const slice = vi.fn(async () => result)
    const host = { slicer: { slice }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    try {
      set({ printerNozzleVolume: 140 })
      const s = get().slice
      expect(s.status === 'done' && s.stale).toBe(true)
      // the auto slice is scheduled (stop clears it before it runs)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})
