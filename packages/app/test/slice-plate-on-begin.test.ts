// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// slicePlate hands its caller the running slice's own abort controller (onBegin), once per round: auto slice keeps it
// to tell its own slice from one someone asked for (auto-slice.ts). It is the current slice while it runs and not
// after, and a round after a refused project setting hands over the new round's controller.
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type MeshHandle, type SliceResult } from '@slicerx/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { currentSlice, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set, type PlateEntry } from '../src/state/store'

/** A one-layer SXPV preview, enough for a slice to land. */
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

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] })
const part = (id: string): PlateEntry => ({ id, name: id, handle: handle(id), parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [60, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
const sliceResult = (id: string) => ({ id, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings: [], stats: { timeS: 60, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 }) as unknown as SliceResult

/** An engine whose slices wait until `release`; `refuse` makes the next one fail with the engine's message. */
function engine() {
  const waiting: { release: () => void; fail: (e: Error) => void }[] = []
  let n = 0
  const slicer = {
    loadModel: async () => handle('m'),
    release: () => undefined,
    getPreview: async () => rawPreview(),
    slice: () => new Promise<SliceResult>((done, failed) => waiting.push({ release: () => done(sliceResult(`r${++n}`)), fail: failed })),
  }
  const host = { kind: 'desktop', slicer, capabilities: { threads: 1 } } as unknown as Host
  return { host, waiting }
}

/** The controllers onBegin got, and whether each was the current slice as it was handed over. */
function begins() {
  const got: { abort: AbortController; currentThen: boolean; running: boolean }[] = []
  const onBegin = (abort: AbortController) => got.push({ abort, currentThen: currentSlice(abort), running: get().slice.status === 'running' })
  return { got, onBegin }
}

beforeEach(async () => {
  set({ printerModel: { id: 'bench', vendor: 'Prusa', model: 'MK4' }, printerId: 'bench', printerSlots: [], slotSetup: {}, layerMarks: {}, overrides: {}, objectSettings: {}, projectSettings: null, projectGcode: null, slice: { status: 'idle' }, autoSlice: false, resume: null } as never)
  set({ plate: [part('a')], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1' })
  await profileReady()
})

describe("slicePlate hands over the running slice's abort controller", () => {
  it('once, as the slice starts: current while it runs, not after it lands', async () => {
    const { host, waiting } = engine()
    const { got, onBegin } = begins()
    const done = slicePlate(host, { auto: true, onBegin })
    await vi.waitFor(() => expect(waiting).toHaveLength(1))
    expect(got).toHaveLength(1)
    // handed over after the slice began, before it shows as running
    expect(got[0]!.currentThen).toBe(true)
    expect(got[0]!.running).toBe(false)
    expect(currentSlice(got[0]!.abort)).toBe(true)
    expect(get().slice.status).toBe('running')
    waiting[0]!.release()
    await done
    expect(get().slice.status).toBe('done')
    expect(got).toHaveLength(1)
    expect(currentSlice(got[0]!.abort)).toBe(false)
    expect(got[0]!.abort.signal.aborted).toBe(false)
  })

  it('a round after a refused project setting hands over its own controller', async () => {
    set({ overrides: { wall_loops: 5 }, projectSettings: { source: 'two.3mf', keys: ['wall_loops'] } } as never)
    const { host, waiting } = engine()
    const { got, onBegin } = begins()
    const done = slicePlate(host, { auto: true, onBegin })
    await vi.waitFor(() => expect(waiting).toHaveLength(1))
    waiting[0]!.fail(new Error('config key wall_loops: 5 is more than the plate allows'))
    // the setting is dropped and the plate slices again
    await vi.waitFor(() => expect(waiting).toHaveLength(2))
    expect(get().overrides['wall_loops']).toBeUndefined()
    expect(got).toHaveLength(2)
    expect(got[1]!.abort).not.toBe(got[0]!.abort)
    expect(got[1]!.currentThen).toBe(true)
    expect(currentSlice(got[0]!.abort)).toBe(false)
    expect(currentSlice(got[1]!.abort)).toBe(true)
    waiting[1]!.release()
    await done
    expect(get().slice.status).toBe('done')
    expect(currentSlice(got[1]!.abort)).toBe(false)
  })

  it('a slice that never starts (nothing on the plate) hands over nothing', async () => {
    set({ plate: [] })
    const { host } = engine()
    const { got, onBegin } = begins()
    await slicePlate(host, { auto: true, onBegin })
    expect(got).toHaveLength(0)
  })
})
