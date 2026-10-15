// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { toolheadNeedsForPlate } from '../src/send/toolhead-map'

it('uses only tools extruded on this plate and preserves composite and support materials', () => {
  expect(toolheadNeedsForPlate([2, 0, 1], { filament_type: ['PLA-CF', 'PETG', 'PVA'], filament_colour: ['#000000', '#ffffff', '#eeeeee'] }, [
    { index: 1, type: 'PLA', color: '#ff0000' }, { index: 2, type: 'PETG', color: '#ffffff' },
  ])).toEqual([{ tool: 0, material: 'PLA-CF', color: '#000000' }, { tool: 2, material: 'PVA', color: '#eeeeee' }])
})
