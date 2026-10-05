// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Filament sync from an AMS, as the hub reports it for a Bambu printer: slots by position (empty ones kept),
// the product line as the material, and what the person edits staying theirs.
import { beforeEach, describe, expect, it } from 'vitest'
import type { FilamentSlot, MeshHandle } from '@slicerx/contracts'
import { resetSlots, resolveSlots, setSlot } from '../src/filament/slots'
import { slotMapFor } from '../src/send/options'
import { get, set, type PlateEntry } from '../src/state/store'

// What sx-connect's Bambu driver reports for an AMS with trays 1 and 3 loaded and an AMS HT beside it.
const AMS: FilamentSlot[] = [
  { id: 'A1' },
  { id: 'A2', material: 'PETG HF', color: '#1a2b3c', remainingPct: 40 },
  { id: 'A3' },
  { id: 'A4', material: 'PLA', color: '#ffffff' },
  { id: 'E1', material: 'ABS', color: '#000000', remainingPct: 90 },
]

function entry(slots: number[]): PlateEntry {
  const handle: MeshHandle = { id: 'o', hash: 'o', name: 'o', triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: slots.map((slot, i) => ({ name: `p${i}`, slot, triangles: 12 })) }
  return { id: 'o', name: 'o', handle, parts: [], colors: [], transform: [] }
}

beforeEach(() => {
  set({ plate: [entry([2, 4])], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', printerSlots: AMS, slotSetup: {}, slotMatch: {} })
})

describe('filament sync from the AMS', () => {
  it('shows each loaded slot with the printer values and keeps empty slots in place', () => {
    const r = resolveSlots({ printerSlots: AMS, plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], plate: [entry([2, 4])], activePlate: 'plate-1', slotSetup: {} })
    expect(r.map((s) => s.label)).toEqual(['A1', 'A2', 'A3', 'A4', 'E1'])
    expect(r[1]).toMatchObject({ type: 'PETG', color: '#1a2b3c', source: 'printer', remainingPct: 40, used: true })
    expect(r[3]).toMatchObject({ type: 'PLA', color: '#ffffff', source: 'printer', used: true })
    expect(r[0]).toMatchObject({ source: 'default', used: false })
    expect(r[4]).toMatchObject({ type: 'ABS', color: '#000000' })
  })

  it('maps filament numbers to the printer slot at the same position', () => {
    expect(slotMapFor([2, 4], AMS)).toEqual({ 2: 'A2', 4: 'A4' })
    expect(slotMapFor([6], AMS)).toEqual({})
  })

  it('keeps a hand edit until reset, then shows the printer again', () => {
    setSlot(2, { color: '#ff0000' })
    const resolve = () => resolveSlots(get())
    expect(resolve()[1]).toMatchObject({ color: '#ff0000', source: 'user' })
    expect(resolve()[3]).toMatchObject({ source: 'printer' })
    resetSlots()
    expect(resolve()[1]).toMatchObject({ color: '#1a2b3c', source: 'printer' })
  })
})
