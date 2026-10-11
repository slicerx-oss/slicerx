// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { projectColors } from './library-seed'

describe('seed colors', () => {
  it("reads a 3MF's filament colors once each, lowercase, in slot order", () => {
    expect(projectColors(JSON.stringify({ filament_colour: ['#303241', '#BD93F9', '#303241'] }))).toEqual({ colors: [{ hex: '#303241' }, { hex: '#bd93f9' }], parts: [] })
    // Bambu Studio can write an alpha byte after the color
    expect(projectColors(JSON.stringify({ filament_colour: ['#FF0000FF'] }))).toEqual({ colors: [{ hex: '#ff0000' }], parts: [] })
  })

  it('gives null for settings that name no colors or are not JSON', () => {
    expect(projectColors(JSON.stringify({ layer_height: '0.2' }))).toBeNull()
    expect(projectColors(JSON.stringify({ filament_colour: ['red', 3] }))).toBeNull()
    expect(projectColors('<config/>')).toBeNull()
    expect(projectColors('')).toBeNull()
  })
})
