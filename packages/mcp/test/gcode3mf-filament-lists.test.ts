// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The .gcode.3mf the MCP server writes lists every filament of the slice in each per-filament list of its
// project_settings.config, since readers take the lists together by index. A list the slice settings give shorter
// takes its last entry for the other filaments, as the engine sliced them.
import { describe, expect, it } from 'vitest'
import { gcode3mf } from '../src/gcode3mf'
import type { SliceSummary } from '../src/slicer'
import { readZip } from '../src/zip'

const summary: SliceSummary = { engine: 'sx', model: { name: 'cube' }, layer_count: 1, time_s: 1, time_text: '0m', filament_g: 1, filament_mm: 1, filaments: [], warnings: [] }
const settingsOf = (config: Parameters<typeof gcode3mf>[2]): Record<string, unknown> =>
  JSON.parse(readZip(gcode3mf('G28\nG1 X10 E1\n', summary, config)).text('Metadata/project_settings.config') ?? '{}') as Record<string, unknown>

describe('the per-filament lists of a .gcode.3mf', () => {
  it('has one entry per filament in each, the last entry repeated where the settings give fewer', () => {
    const settings = settingsOf({
      filament_colour: ['#FF0000', '#00FF00', '#0000FF'],
      filament_type: ['PLA', 'PETG', 'PLA'],
      nozzle_temperature: [220, 250],
      filament_flow_ratio: [0.98],
      filament_ids: ['GFA00'],
      layer_height: 0.2,
    })
    expect(settings['filament_colour']).toEqual(['#FF0000', '#00FF00', '#0000FF'])
    expect(settings['nozzle_temperature']).toEqual(['220', '250', '250'])
    expect(settings['filament_flow_ratio']).toEqual(['0.98', '0.98', '0.98'])
    expect(settings['filament_ids']).toEqual(['GFA00', 'GFA00', 'GFA00'])
    expect(settings['layer_height']).toBe('0.2')
  })

  it('leaves a slice of one filament as it was', () => {
    const settings = settingsOf({ filament_colour: ['#FF0000'], nozzle_temperature: [220], filament_z_hop: [0.6] })
    expect(settings['nozzle_temperature']).toEqual(['220'])
    expect(settings['filament_z_hop']).toEqual(['0.6'])
  })
})
