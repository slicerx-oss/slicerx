// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A launch with no file shows the example plate, which waits for Slice like an opened project: no slice request goes
// out (not even one canceled at once), the view stays on the plate, and the footer offers Slice plate. The first edit
// slices as the Auto slice setting says.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'

const handle = { id: 'x', hash: 'x', name: 'Layered X', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [{ name: 'Layered X', slot: 1, triangles: 12 }] }

function host() {
  const requests: SliceRequest[] = []
  const h = {
    kind: 'desktop',
    capabilities: { threads: 1 },
    slicer: {
      loadParts: async () => handle,
      slice: (r: SliceRequest) => {
        requests.push(r)
        return new Promise(() => {})
      },
      cancel: () => undefined,
    },
  } as unknown as Host
  return { h, requests }
}

/** A new session, as the app starts one: Auto slice on in `mode`, the plate empty, auto slice watching. */
async function launch(mode: 'auto' | 'always') {
  vi.resetModules()
  const store = await import('../src/state/store')
  const { autoSliceFields } = await import('../src/state/auto-slice-mode')
  const { startAutoSlice, AUTO_SLICE_DELAY_MS } = await import('../src/state/auto-slice')
  const actions = await import('../src/state/actions')
  store.set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', ...autoSliceFields(mode), sliceHeld: false, liveEdit: false, historyEdit: null, plateLoading: false, revealHold: false, exampleSeeding: false, sliceDuringOpen: false, slice: { status: 'idle' }, resume: null, workspace: 'prepare', modelMode: 'slice', preview: null })
  const { h, requests } = host()
  const stop = startAutoSlice(h, AUTO_SLICE_DELAY_MS, 10)
  return { ...store, ...actions, h, requests, stop, delay: AUTO_SLICE_DELAY_MS }
}

/** Long enough for a slice to start if one was going to: the auto slice pause, then the modules a slice loads. */
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms))

let stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

describe('the example plate at launch', () => {
  for (const mode of ['auto', 'always'] as const) {
    it(`sends no slice request and waits for Slice plate (${mode})`, async () => {
      const s = await launch(mode)
      stops.push(s.stop)
      const rails = s.get().rails
      await s.seedExamplePlate(s.h)
      await settle()
      expect(s.get().plate.map((p) => p.name)).toEqual(['Layered X'])
      expect(s.requests).toHaveLength(0)
      expect(s.get().slice.status).toBe('idle')
      // the footer's Slice plate
      expect(s.get().sliceHeld).toBe(true)
      expect(s.get().exampleSeeding).toBe(false)
      // the view stays on the plate: no flip to the toolpaths, the right pane as it was
      expect({ workspace: s.get().workspace, modelMode: s.get().modelMode, preview: s.get().preview }).toEqual({ workspace: 'prepare', modelMode: 'slice', preview: null })
      expect(s.get().rails).toBe(rails)
    })
  }

  it('the printer profile arriving after the plate does not start a slice either', async () => {
    // The profile layer the example's plate asks for lands inside the build `profileReady` waits on: the new resolved
    // configuration is written, then `profileReady` resolves. The test holds `profileReady` open and does both in that
    // order, so the outcome never depends on how fast the profile module loads against a timer.
    let ready!: () => void
    const layer = new Promise<void>((r) => (ready = r))
    let asked = 0
    vi.doMock('../src/state/profile-sync', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/state/profile-sync')>()),
      profileReady: () => {
        asked++
        return layer
      },
    }))
    try {
      const s = await launch('auto')
      stops.push(s.stop)
      const seeding = s.seedExamplePlate(s.h)
      await vi.waitFor(() => expect(asked).toBe(1))
      expect(s.get().plate.map((p) => p.name)).toEqual(['Layered X'])
      expect(s.get().exampleSeeding).toBe(true)
      // the profile follow's write: a new resolved configuration, then the build is done
      s.set({ overrides: { ...s.get().overrides } })
      ready()
      await seeding
      expect(s.get().exampleSeeding).toBe(false)
      await settle()
      expect(s.requests).toHaveLength(0)
      expect(s.get().sliceHeld).toBe(true)
    } finally {
      vi.doUnmock('../src/state/profile-sync')
    }
  })

  it('the measured flush tables landing after the plate do not start a slice, with the sleipnir line on', async () => {
    // The footer's sleipnir line works out the plate's slice settings on its first render, which makes the first flush
    // calculation and loads the measured flush tables; when they land the flush settings are written again, unchanged.
    const s = await launch('auto')
    stops.push(s.stop)
    await s.seedExamplePlate(s.h)
    await settle()
    expect(s.get().sliceHeld).toBe(true)
    const { sleipnirCapText } = await import('../src/plate/sleipnir-cap')
    const { goalEasy } = await import('../src/adapters/config')
    await import('../src/filament/flush')
    const { flushDataReady, loadFlushData } = await import('@slicerx/settings/flush')
    expect(flushDataReady()).toBe(false)
    // the line as the footer reads it, for 0.28 mm layers on a 0.4 mm nozzle with sleipnir on
    const st = s.get()
    const line = sleipnirCapText({ ...st, easy: { ...goalEasy('standard'), varyLayerHeight: true }, overrides: { ...st.overrides, layer_height: 0.28, nozzle_diameter: [0.4] } })
    expect(line).toBe('With sleipnir on, layers are at most 0.20 mm, not 0.28 mm.')
    const flush = s.get().flush
    await loadFlushData()
    // the tables' write: the same values in a new object
    expect(s.get().flush).not.toBe(flush)
    expect(s.get().flush).toEqual(flush)
    await settle()
    expect(s.requests).toHaveLength(0)
    expect(s.get().slice.status).toBe('idle')
    expect(s.get().sliceHeld).toBe(true)
  })

  it('a flush value someone changes still slices', async () => {
    const s = await launch('auto')
    stops.push(s.stop)
    await s.seedExamplePlate(s.h)
    await settle()
    s.set((st) => ({ flush: { ...st.flush, multiplier: st.flush.multiplier + 0.5 } }))
    await vi.waitFor(() => expect(s.requests).toHaveLength(1), { timeout: 3000 })
    expect(s.get().sliceHeld).toBe(false)
  })

  it('slices on the first edit, as the setting says', async () => {
    const s = await launch('auto')
    stops.push(s.stop)
    await s.seedExamplePlate(s.h)
    await settle()
    const [entry] = s.get().plate
    s.set({ plate: [{ ...entry!, transform: entry!.transform.map((v, i) => (i === 12 ? v + 5 : v)) }] })
    await vi.waitFor(() => expect(s.requests).toHaveLength(1), { timeout: 3000 })
    expect(s.get().sliceHeld).toBe(false)
  })
})
