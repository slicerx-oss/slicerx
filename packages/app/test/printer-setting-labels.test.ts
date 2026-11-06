// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every row the Printer settings dialog can list has a written label, not the setting key read aloud
// ("Disable m73", "Gcode flavor"). The label comes from the settings schema, so the dialog, its search and the
// setting explain output all say the same thing.
import { describe, expect, it } from 'vitest'
import { settingDef } from '../src/adapters/settings'
import { printerKeys } from '../src/workspaces/prepare/printer-settings'

// Keys whose readable form is already the plain slicer term, checked one by one. A new printer setting either gets
// its own label in the schema or is added here after the same check.
const PLAIN_AS_KEY = new Set([
  'adaptive_bed_mesh_margin',
  'auxiliary_fan',
  'bed_temperature_formula',
  'chamber_cooling_mode',
  'cooling_tube_length',
  'cooling_tube_retraction',
  'deretraction_speed',
  'extra_loading_move',
  'extruder_clearance_height_to_lid',
  'extruder_clearance_height_to_rod',
  'extruder_clearance_radius',
  'extruder_height_gap',
  'extruder_printable_height',
  'fan_direction',
  'grab_length',
  'high_current_on_filament_swap',
  'hotend_cooling_rate',
  'hotend_heating_rate',
  'input_shaping_type',
  'manual_filament_change',
  'nozzle_diameter',
  'nozzle_height',
  'nozzle_volume',
  'preferred_orientation',
  'printable_height',
  'printer_structure',
  'printer_technology',
  'resonance_avoidance',
  'retract_after_wipe',
  'retract_before_wipe',
  'retraction_length',
  'retraction_speed',
  'scan_first_layer',
  'silent_mode',
  'travel_slope',
  'use_firmware_retraction',
  'wipe_distance',
  'z_offset',
])

// Shorthand and raw tokens that read as a key, not a label: G-code commands, file and code words, clipped words.
const RAW = /\b(gcode|m\d+|bbl|printhost|ssl|pwm|hrc|dist|pos|temp|freq|damp|max|min|id|toolchange|speedup|kickstart)\b/i

const fromKey = (key: string): string => key.replace(/_/g, ' ').toLowerCase()

describe('printer setting labels', () => {
  const keys = printerKeys()

  it('lists the printer settings', () => {
    expect(keys.length).toBeGreaterThan(100)
  })

  it('gives every printer setting a written label, not its key read aloud', () => {
    const bad = keys.filter((k) => !PLAIN_AS_KEY.has(k) && settingDef(k)!.label.trim().toLowerCase() === fromKey(k)).map((k) => `${k}: ${settingDef(k)!.label}`)
    expect(bad).toEqual([])
  })

  it('keeps raw tokens and clipped words out of the labels', () => {
    const bad = keys.map((k) => `${k}: ${settingDef(k)!.label}`).filter((line) => RAW.test(line.slice(line.indexOf(': ') + 2)))
    expect(bad).toEqual([])
  })

  it('writes every label in sentence case', () => {
    const bad = keys.map((k) => settingDef(k)!.label).filter((l) => l.charAt(0) !== l.charAt(0).toUpperCase())
    expect(bad).toEqual([])
  })

  it('lists only keys that are still printer settings in the reviewed set', () => {
    expect([...PLAIN_AS_KEY].filter((k) => !keys.includes(k))).toEqual([])
  })
})
