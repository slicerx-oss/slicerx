// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the fit rule gets from the plate for print-in-place gaps (fitProfileFor): the layer height the plate slices with
// and the first filament a part uses, else the first slot's; nothing it cannot use.
import type { MeshHandle } from '@slicerx/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { fitProfileFor } from '../src/plate/fit-profile'
import { get, set, type PlateEntry } from '../src/state/store'

function entry(id: string, slot: number): PlateEntry {
  const parts = [{ name: 'p', slot }]
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts } as unknown as MeshHandle
  return { id, name: id, handle, parts: parts.map((p) => ({ ...p, positions: new Float32Array(), indices: new Uint32Array() })), colors: ['#bd93f9'], transform: [] } as unknown as PlateEntry
}

beforeEach(() => set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', plate: [], overrides: {}, slotSetup: {}, printerSlots: [] }))

describe('fitProfileFor', () => {
  it('takes the default layer height and PLA without a profile or filaments set', () => {
    const p = fitProfileFor(get())
    expect(p.material).toBe('PLA')
    expect(p.layerHeightMm).toBeGreaterThan(0)
  })

  it('takes the layer height the plate slices with', () => {
    set({ overrides: { layer_height: 0.28 } })
    expect(fitProfileFor(get())).toMatchObject({ layerHeightMm: 0.28 })
  })

  it('leaves out a layer height of 0 or not a number, so the fit rule uses half the nozzle', () => {
    set({ overrides: { layer_height: 0 } })
    expect(fitProfileFor(get())).not.toHaveProperty('layerHeightMm')
    set({ overrides: { layer_height: 'auto' } as never })
    expect(fitProfileFor(get())).not.toHaveProperty('layerHeightMm')
  })

  it('takes the first filament a part uses, else the first slot', () => {
    set({ slotSetup: { 1: { type: 'PLA', brand: '', color: '#ff6a13' }, 2: { type: 'PETG', brand: '', color: '#50fa7b' } } })
    expect(fitProfileFor(get()).material).toBe('PLA')
    set({ plate: [entry('obj_1', 2)] })
    expect(fitProfileFor(get()).material).toBe('PETG')
    set({ slotSetup: { 1: { type: 'TPU', brand: '', color: '#ff6a13' } }, plate: [] })
    expect(fitProfileFor(get()).material).toBe('TPU')
  })
})
