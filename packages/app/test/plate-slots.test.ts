// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate's filament order lists every filament the plate uses, a filament picked in the object list included.
import { describe, expect, it } from 'vitest'
import { slotsOnPlate } from '../src/workspaces/prepare/plate-list'

const part = (name: string, slot: number) => ({ name, slot, positions: new Float32Array(), indices: new Uint32Array() })

describe('slotsOnPlate', () => {
  it('counts the slots of the parts', () => {
    expect(slotsOnPlate([{ parts: [part('base', 1), part('x', 2)] }])).toBe(2)
    expect(slotsOnPlate([])).toBe(1)
  })
  it('counts a filament chosen for an object in the object list', () => {
    expect(slotsOnPlate([{ parts: [part('Box', 1)] }, { parts: [part('Cylinder', 1)], slotOverrides: { Cylinder: 2 } }])).toBe(2)
  })
})
