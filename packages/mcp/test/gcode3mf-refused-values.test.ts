// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The .gcode.3mf the MCP server writes carries no setting other slicers refuse from a project: a filament ironing speed
// on automatic and an empty post-processing list are left out, and the rest of the settings stay.
import { describe, expect, it } from 'vitest'
import { gcode3mf } from '../src/gcode3mf'
import type { SliceSummary } from '../src/slicer'
import { readZip } from '../src/zip'

const summary: SliceSummary = { engine: 'sx', model: { name: 'cube' }, layer_count: 1, time_s: 1, time_text: '0m', filament_g: 1, filament_mm: 1, filaments: [], warnings: [] }
const settingsOf = (config: Parameters<typeof gcode3mf>[2]) => JSON.parse(readZip(gcode3mf('G28\nG1 X10 E1\n', summary, config)).text('Metadata/project_settings.config') ?? '{}') as Record<string, unknown>

describe('a .gcode.3mf from the MCP server', () => {
  it('leaves out an automatic filament ironing speed and an empty post-processing list', () => {
    const s = settingsOf({ filament_ironing_speed: [0], post_process: [''], ironing_speed: 30, wall_loops: 3 })
    expect(s).not.toHaveProperty('filament_ironing_speed')
    expect(s).not.toHaveProperty('post_process')
    expect(s['ironing_speed']).toBe('30')
    expect(s['wall_loops']).toBe('3')
  })

  it('keeps a filament ironing speed that is set', () => {
    expect(settingsOf({ filament_ironing_speed: [25] })['filament_ironing_speed']).toEqual(['25'])
  })
})
