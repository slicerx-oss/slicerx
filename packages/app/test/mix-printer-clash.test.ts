// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer that reports filaments up to a mix's number, with no free number above for the mixes to move to: the
// number names both a loaded filament and the mix, so the slice is refused with the Mixes row's note until a mix goes.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { printerClash } from '../src/filament/mixes'
import { slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'Box', handle, parts: [], colors: [], slotOverrides: { a: 32 }, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never
const sunset = { id: 32, name: 'Sunset', components: [1, 2] as [number, number], ratio: [2, 1] as [number, number] }
const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `A${i}` })) as never

function engine(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
  return { host, requests }
}

beforeEach(() => set({ plate: [entry], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }] as never, activePlate: 'p1', slice: { status: 'idle' }, calibration: {}, layerMarks: {}, resume: null, mixes: [sunset], printerSlots: [] }))

describe('a mix on a number the printer reports', () => {
  it('refuses the slice with the Mixes row\'s note while no number is free for the mix', async () => {
    set({ printerSlots: slots(32) })
    await Promise.resolve()
    expect(get().mixes.map((m) => m.id)).toEqual([32])
    const note = printerClash(get())
    expect(note).toMatch(/Delete a mix before slicing\.$/)
    for (const auto of [false, true]) {
      const { host, requests } = engine()
      set({ slice: { status: 'idle' } })
      await slicePlate(host, { auto })
      expect(requests).toHaveLength(0)
      expect(get().slice).toEqual({ status: 'error', message: note })
    }
  })

  it('slices as before when the printer reports fewer filaments than the mix\'s number', async () => {
    set({ printerSlots: slots(4) })
    await Promise.resolve()
    expect(printerClash(get())).toBeNull()
    const { host, requests } = engine()
    await slicePlate(host)
    expect(requests).toHaveLength(1)
  })
})
