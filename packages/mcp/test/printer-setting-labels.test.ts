// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer settings reach clients by the same written labels the Printer settings dialog shows, with their units,
// and a search by the plain words finds them.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'

describe('printer setting labels for clients', () => {
  it('explains printer settings by their written labels and units', async () => {
    const h = await connect()
    try {
      const cases: [string, string, string | undefined][] = [
        ['gcode_flavor', 'G-code flavor', undefined],
        ['disable_m73', 'Skip print progress updates', undefined],
        ['extruder_clearance_dist_to_rod', 'Extruder clearance distance to rod', 'mm'],
        ['machine_load_filament_time', 'Filament load time', 's'],
        ['retract_length_toolchange', 'Retraction length at a tool change', 'mm'],
      ]
      for (const [key, label, unit] of cases) {
        const r = await h.call('slicerx_explain_setting', { key })
        expect(r.isError, text(r)).toBeFalsy()
        const d = data(r) as { label: string; unit?: string }
        expect(d.label, key).toBe(label)
        expect(d.unit, key).toBe(unit)
      }
    } finally { await h.client.close() }
  })

  it('finds a printer setting by its plain words', async () => {
    const h = await connect()
    try {
      const r = await h.call('slicerx_find_settings', { query: 'G-code flavor' })
      expect(r.isError, text(r)).toBeFalsy()
      expect(JSON.stringify(data(r))).toContain('gcode_flavor')
    } finally { await h.client.close() }
  })
})
