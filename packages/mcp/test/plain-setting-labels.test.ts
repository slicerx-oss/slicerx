// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings that used to read as their key reach clients by plain labels, through the explain and find tools, with
// the unit the label no longer carries. A search by the old words still finds the setting through its key.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

describe('plain setting labels for clients', () => {
  it('explains renamed process, filament and printer settings by their new labels', async () => {
    const h = await connect()
    try {
      const cases: [string, string, string, string | undefined][] = [
        ['zaa_enabled', 'process', 'Z contouring', undefined],
        ['small_perimeter_speed', 'process', 'Small wall speed', 'mm/s'],
        ['gcode_comments', 'process', 'G-code comments', undefined],
        ['brim_use_efc_outline', 'process', 'Brim follows elephant foot compensation', undefined],
        ['wave_overhang_flow_mm3_per_mm', 'process', 'Wave overhang flow', 'mm2'],
        ['wave_overhang_min_new_area', 'process', 'Wave overhang minimum new area', 'mm2'],
        ['temperature_vitrification', 'filament', 'Softening temperature', 'C'],
        ['filament_max_volumetric_speed', 'filament', 'Maximum volumetric speed', 'mm3/s'],
        ['printing_by_object_gcode', 'printer', 'Print by object G-code', undefined],
        ['printer_agent', 'printer', 'Printer network connection type', undefined],
      ]
      for (const [key, section, label, unit] of cases) {
        const r = await h.call('slicerx_explain_setting', { key })
        expect(r.isError, text(r)).toBeFalsy()
        const d = data(r) as { label: string; unit?: string; section?: string }
        expect(d.label, key).toBe(label)
        expect(d.unit, key).toBe(unit)
        if (d.section !== undefined) expect(d.section, key).toBe(section)
      }
    } finally { await h.client.close() }
  })

  it('finds a renamed setting by its new words and by its old ones', async () => {
    const h = await connect()
    try {
      const cases: [string, string][] = [
        ['softening temperature', 'temperature_vitrification'],
        ['Z contouring', 'zaa_enabled'],
        ['small wall speed', 'small_perimeter_speed'],
        ['G-code comments', 'gcode_comments'],
        ['wave overhang flow', 'wave_overhang_flow_mm3_per_mm'],
        // the old label of each of these still finds the setting through its key
        ['Small perimeter speed', 'small_perimeter_speed'],
        ['Max volumetric speed', 'filament_max_volumetric_speed'],
        ['Brim use efc outline', 'brim_use_efc_outline'],
      ]
      for (const [query, key] of cases) {
        const r = await h.call('slicerx_find_settings', { query })
        expect(r.isError, text(r)).toBeFalsy()
        expect(JSON.stringify(data(r)), query).toContain(key)
      }
    } finally { await h.client.close() }
  })

  it('names a renamed setting by its new label in a validation message', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_validate_config', { config: { internal_bridge_flow: 0 } })
      expect(r.isError, text(r)).toBeFalsy()
      expect(JSON.stringify(data(r))).toContain('Internal bridge flow ratio')
    } finally { await h.client.close() }
  })
})
