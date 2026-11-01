// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The .gcode.3mf the MCP server writes for a Bambu Lab printer carries the settings Bambu Studio and OrcaSlicer read:
// a ramp lift (SlicerX's `Ramp Lift`) as Slope Lift, and no filament travel slope, a key of ours.
import { describe, expect, it } from 'vitest'
import { gcode3mf } from '../src/gcode3mf'
import type { SliceSummary } from '../src/slicer'
import { readZip } from '../src/zip'

describe('a .gcode.3mf of a ramp lift', () => {
  it('writes the ramp as a slope lift without the filament travel slope', () => {
    const summary: SliceSummary = { engine: 'sx', model: { name: 'cube' }, layer_count: 1, time_s: 1, time_text: '0m', filament_g: 1, filament_mm: 1, filaments: [], warnings: [] }
    const zip = readZip(gcode3mf('G28\nG1 X10 E1\n', summary, { z_hop_types: ['Ramp Lift'], filament_z_hop_types: ['Ramp Lift', 'nil'], filament_travel_slope: [1], filament_z_hop: [0.6] }))
    const settings = JSON.parse(zip.text('Metadata/project_settings.config') ?? '{}') as Record<string, unknown>
    expect(settings['z_hop_types']).toEqual(['Slope Lift'])
    expect(settings['filament_z_hop_types']).toEqual(['Slope Lift', 'nil'])
    expect(settings).not.toHaveProperty('filament_travel_slope')
    expect(settings['filament_z_hop']).toEqual(['0.6'])
  })
})
