// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The nozzle volume, an opened project's flush matrix and its G-code values (KEY_CONFIG) sit outside the slice inputs,
// and no setter marks a slice stale when they change. The profile layer sets a new printer's nozzle volume with that
// printer's profile (profile-sync.ts), and Prepare sets the same value again when it shows the printer. These tests
// write the value after the slice, as a slice stamped before either write sees it: the app's Print and Export and mimir
// must all read that slice as stale on a multi-color plate, and auto slice slices again. A single-color plate, whose
// G-code has no flush volumes, keeps its slice.
import type { Host, MeshHandle, SliceResult } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { needsSlice, sliceStamp, stampBlock } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { beginSlice, cancelSlice, endSlice, STALE_SLICE } from '../src/state/actions'
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

/** A printer change, then the new printer's nozzle volume written after it, as the profile layer and Prepare set it. */
function newPrinter() {
  set({ printerModel: { id: 'xl', vendor: 'Prusa', model: 'XL' } } as never)
  set({ printerNozzleVolume: 140 })
}

// The watcher's own slice: it starts, shows as running and stays running until `finish`, so a test can change the
// nozzle volume while it runs; `fail` ends it with an error instead. Slices started any other way are the real ones.
type AutoRun = { abort: AbortController; finish: () => void; fail: () => void }
const auto = vi.hoisted(() => ({ started: 0, runs: [] as AutoRun[], abort: null as AbortController | null, finish: null as null | (() => void) }))
vi.mock('../src/state/actions', async (orig) => {
  const real = await orig<typeof import('../src/state/actions')>()
  const { set: put } = await import('../src/state/store')
  return {
    ...real,
    slicePlate: (_host: unknown, opts?: { auto?: boolean; onBegin?: (abort: AbortController) => void }) => {
      if (!opts?.auto) return real.slicePlate(_host as never, opts)
      auto.started++
      const abort = real.beginSlice()
      opts.onBegin?.(abort)
      auto.abort = abort
      put({ slice: { status: 'running', progress: null, startedAt: auto.started } } as never)
      return new Promise<void>((done, failed) => {
        const run = {
          abort,
          finish: () => {
            real.endSlice(abort)
            done()
          },
          fail: () => {
            real.endSlice(abort)
            failed(new Error('engine gone'))
          },
        }
        auto.runs.push(run)
        auto.finish = run.finish
      })
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  auto.started = 0
  auto.runs = []
  auto.abort = null
  auto.finish = null
})

describe("a nozzle volume that lands after the slice", () => {
  it('on a two-color plate: Print, Export and mimir all read the slice as stale', () => {
    sliced([part('a', 60, 1), part('b', 120, 2)])
    const fingerprint = plateFingerprint(get(), 1)
    const done = get()
    expect(stampBlock(done, done.slice.status === 'done' ? done.slice.stamp : undefined)).toBeNull()
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
      // the stamp check loads with the slice code
      await vi.dynamicImportSettled()
      const s = get().slice
      expect(s.status === 'done' && s.stale).toBe(true)
      // the auto slice is scheduled (stop clears it before it runs)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('with auto slice on, an auto slice running when the nozzle volume changes stops, and a new one is scheduled', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    try {
      // an edit starts an auto slice, which is still running
      set({ overrides: {} })
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(1)
      expect(get().slice.status).toBe('running')
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(auto.abort?.signal.aborted).toBe(true)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    } finally {
      stop()
      auto.finish?.()
      vi.useRealTimers()
    }
  })

  it('a slice someone asked for (Slice, mimir) running when the nozzle volume changes is left to land, then goes stale and auto slice slices again', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    // not an auto slice: started outside the watcher, as the Slice button or mimir's app.slice does, stamped as it starts
    const abort = beginSlice()
    const stamp = sliceStamp(get())
    set({ slice: { status: 'running', progress: null, startedAt: 100 } } as never)
    try {
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(abort.signal.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      // it lands with the stamp of the old nozzle volume
      endSlice(abort)
      set({ slice: { status: 'done', result, stale: false, stamp } } as never)
      await vi.dynamicImportSettled()
      const s = get()
      expect(stampBlock(s, s.slice.status === 'done' ? s.slice.stamp : undefined)).toBe(STALE_SLICE)
      expect(needsSlice(s)).toBe(true)
      expect(s.slice.status === 'done' && s.slice.stale).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(1)
    } finally {
      stop()
      endSlice(abort)
      for (const r of auto.runs) r.finish()
      vi.useRealTimers()
    }
  })

  it('an auto slice that finished: a slice someone starts next is left to land when the nozzle volume changes', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    const abort = { current: null as AbortController | null }
    try {
      set({ overrides: {} })
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(1)
      auto.runs[0]!.finish()
      set({ slice: { status: 'done', result, stale: false, stamp: sliceStamp(get()) } } as never)
      await vi.advanceTimersByTimeAsync(1)
      abort.current = beginSlice()
      set({ slice: { status: 'running', progress: null, startedAt: 100 } } as never)
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(abort.current.signal.aborted).toBe(false)
      expect(auto.started).toBe(1)
    } finally {
      stop()
      if (abort.current) endSlice(abort.current)
      vi.useRealTimers()
    }
  })

  it('an auto slice that failed: a slice someone starts next is left to land when the nozzle volume changes', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    const abort = { current: null as AbortController | null }
    try {
      set({ overrides: {} })
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(1)
      auto.runs[0]!.fail()
      set({ slice: { status: 'error', message: 'engine gone' } } as never)
      await vi.advanceTimersByTimeAsync(1)
      abort.current = beginSlice()
      set({ slice: { status: 'running', progress: null, startedAt: 100 } } as never)
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(abort.current.signal.aborted).toBe(false)
      expect(auto.started).toBe(1)
    } finally {
      stop()
      if (abort.current) endSlice(abort.current)
      vi.useRealTimers()
    }
  })

  it('an edit while an auto slice runs: the newer auto slice is the one a nozzle volume change stops', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    try {
      set({ overrides: {} })
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(1)
      // the edit stops the first and starts a second
      set({ overrides: { wall_loops: 3 } })
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.runs[0]!.abort.signal.aborted).toBe(true)
      expect(auto.started).toBe(2)
      // the first unwinds late; the second is still the auto slice
      auto.runs[0]!.finish()
      await vi.advanceTimersByTimeAsync(0)
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(auto.runs[1]!.abort.signal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(3)
    } finally {
      stop()
      for (const r of auto.runs) r.finish()
      vi.useRealTimers()
    }
  })

  it('a slice someone starts while a canceled auto slice unwinds is left to land when the nozzle volume changes', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1), part('b', 120, 2)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    const abort = { current: null as AbortController | null }
    try {
      set({ overrides: {} })
      await vi.advanceTimersByTimeAsync(1)
      expect(auto.started).toBe(1)
      // Cancel: the auto slice is told to stop but has not unwound yet
      cancelSlice({ quiet: true })
      // Slice, or mimir's app.slice, starts a slice of its own
      abort.current = beginSlice()
      set({ slice: { status: 'running', progress: null, startedAt: 100 } } as never)
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(abort.current.signal.aborted).toBe(false)
      expect(auto.started).toBe(1)
    } finally {
      stop()
      if (abort.current) endSlice(abort.current)
      for (const r of auto.runs) r.finish()
      vi.useRealTimers()
    }
  })

  it('a slice running on a single-color plate keeps going', async () => {
    vi.useFakeTimers()
    const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
    sliced([part('a', 60, 1)])
    set({ autoSlice: true, autoSliceBySize: false } as never)
    const stop = startAutoSlice(host, 0)
    const abort = beginSlice()
    set({ slice: { status: 'running' } } as never)
    try {
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      expect(abort.signal.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      stop()
      endSlice(abort)
      vi.useRealTimers()
    }
  })
})

// A slice someone asked for (Slice, mimir) that was running when the nozzle volume changed is checked once, as it lands:
// sliced again only when it lands done and read the old value, and never more than once.
describe('a slice someone asked for, checked as it lands', () => {
  const host = { slicer: { slice: vi.fn() }, capabilities: { threads: 1 } } as unknown as Host
  let stop: () => void = () => undefined
  let abort: AbortController | null = null

  /** Auto slice on, and a slice someone asked for running on `plate`, stamped as it starts. */
  function running(plate: PlateEntry[]) {
    vi.useFakeTimers()
    sliced(plate)
    set({ autoSlice: true, autoSliceBySize: false } as never)
    stop = startAutoSlice(host, 0)
    abort = beginSlice()
    const stamp = sliceStamp(get())
    set({ slice: { status: 'running', progress: null, startedAt: 100 } } as never)
    return stamp
  }

  /** The running slice ends as `slice`. */
  function land(slice: object) {
    endSlice(abort!)
    set({ slice } as never)
  }

  /** Lets the stamp check load and any slice scheduled start. */
  async function settle() {
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.dynamicImportSettled()
  }

  afterEach(() => {
    stop()
    if (abort) endSlice(abort)
    abort = null
    for (const r of auto.runs) r.finish()
    vi.useRealTimers()
  })

  it('a slice that read the old nozzle volume is sliced again once, and the new slice landing current ends it', async () => {
    const stamp = running([part('a', 60, 1), part('b', 120, 2)])
    set({ printerNozzleVolume: 140 })
    await vi.dynamicImportSettled()
    land({ status: 'done', result, stale: false, stamp })
    await settle()
    expect(auto.started).toBe(1)
    // the auto slice lands current: nothing more is scheduled, however long it waits
    auto.runs[0]!.finish()
    set({ slice: { status: 'done', result, stale: false, stamp: sliceStamp(get()) } } as never)
    await settle()
    await settle()
    expect(auto.started).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    const s = get()
    expect(s.slice.status === 'done' && s.slice.stale).toBe(false)
  })

  it('a slice that read the new nozzle volume lands current and nothing slices again', async () => {
    running([part('a', 60, 1), part('b', 120, 2)])
    set({ printerNozzleVolume: 140 })
    await vi.dynamicImportSettled()
    // stamped after the change, as a slice that waited for the profile is
    land({ status: 'done', result, stale: false, stamp: sliceStamp(get()) })
    await settle()
    expect(auto.started).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const s = get()
    expect(s.slice.status === 'done' && s.slice.stale).toBe(false)
  })

  it('a slice that landed stale already is not sliced again by the check', async () => {
    const stamp = running([part('a', 60, 1), part('b', 120, 2)])
    set({ printerNozzleVolume: 140 })
    await vi.dynamicImportSettled()
    land({ status: 'done', result, stale: true, stamp })
    await settle()
    expect(auto.started).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a slice that lands with no stamp is left as it is', async () => {
    running([part('a', 60, 1), part('b', 120, 2)])
    set({ printerNozzleVolume: 140 })
    await vi.dynamicImportSettled()
    land({ status: 'done', result, stale: false })
    await settle()
    expect(auto.started).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const s = get()
    expect(s.slice.status === 'done' && s.slice.stale).toBe(false)
  })

  it('a slice that fails, or is canceled, after the change: nothing is scheduled, and the next slice to land is not checked', async () => {
    for (const end of [{ status: 'error', message: 'refused' }, { status: 'idle' }]) {
      const stamp = running([part('a', 60, 1), part('b', 120, 2)])
      set({ printerNozzleVolume: 140 })
      await vi.dynamicImportSettled()
      land(end)
      await settle()
      expect(auto.started).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      // a later slice that lands with the old stamp, with no nozzle volume change during it, is not this check's
      abort = beginSlice()
      set({ slice: { status: 'running', progress: null, startedAt: 200 } } as never)
      land({ status: 'done', result, stale: false, stamp })
      await settle()
      expect(auto.started).toBe(0)
      const s = get()
      expect(s.slice.status === 'done' && s.slice.stale).toBe(false)
      stop()
    }
  })

  it('auto slice turned off before the slice lands: nothing is checked or scheduled', async () => {
    const stamp = running([part('a', 60, 1), part('b', 120, 2)])
    set({ printerNozzleVolume: 140 })
    await vi.dynamicImportSettled()
    set({ autoSlice: false } as never)
    land({ status: 'done', result, stale: false, stamp })
    await settle()
    expect(auto.started).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const s = get()
    expect(s.slice.status === 'done' && s.slice.stale).toBe(false)
  })

  it('on a single-color plate the nozzle volume is not in the configuration: the slice lands current and nothing is checked', async () => {
    const stamp = running([part('a', 60, 1)])
    set({ printerNozzleVolume: 140 })
    await vi.dynamicImportSettled()
    land({ status: 'done', result, stale: false, stamp })
    await settle()
    expect(auto.started).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const s = get()
    expect(s.slice.status === 'done' && s.slice.stale).toBe(false)
  })
})
