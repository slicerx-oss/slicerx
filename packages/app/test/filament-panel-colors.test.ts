// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Filament panel shows each slot in the project file's filament color, the same color the plate is drawn in,
// not the color of whichever part happens to be first in that slot.
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { resolveSlots } from '../src/filament/slots'
import { useResolvedSlots } from '../src/filament/use-slots'
import { get, set, type PlateEntry } from '../src/state/store'

/** An object whose parts sit in `slots`, drawn in `colors` (one per part). */
function entry(id: string, slots: number[], colors: string[]): PlateEntry {
  const handle: MeshHandle = { id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: slots.map((slot, i) => ({ name: `p${i}`, slot, triangles: 12 })) }
  return { id, name: id, handle, parts: [], colors, transform: [] }
}

// tangela.3mf's filament_colour: black, blue, red, white.
const FILE = ['#000000', '#0078bf', '#de4343', '#ffffff']

beforeEach(() => {
  set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', printerSlots: [], slotSetup: {}, slotMatch: {}, fileSlotColors: [] })
})

describe('the Filament panel swatches', () => {
  it("read the file's filament_colour by slot, as the plate does", () => {
    // Part colors that do not follow their slots give the panel tangela showed: blue, blue, black, green.
    set({ plate: [entry('a', [2, 1, 3, 4], ['#0078bf', '#0078bf', '#000000', '#50fa7b'])], fileSlotColors: [...FILE] })
    const { result } = renderHook(() => useResolvedSlots())
    expect(result.current.map((r) => r.color)).toEqual(FILE)
    expect(result.current.map((r) => r.color)).toEqual(resolveSlots(get()).map((r) => r.color))
  })

  it('follow the file colors when a project opens after the panel is up', () => {
    set({ plate: [entry('a', [1, 2, 3, 4], ['#f8f8f2', '#f8f8f2', '#f8f8f2', '#282a36'])] })
    const { result } = renderHook(() => useResolvedSlots())
    expect(result.current[0]!.color).toBe('#f8f8f2')
    // The keychain's filament_colour: white, black, grey, orange.
    act(() => set({ fileSlotColors: ['#FFFFFF', '#000000', '#8E9089', '#FF6A13'] }))
    expect(result.current.map((r) => r.color)).toEqual(['#ffffff', '#000000', '#8e9089', '#ff6a13'])
  })
})
