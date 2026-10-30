// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print time a client reads for a multi-color plate on a tool changer (the Snapmaker U1: four heads, one filament
// each, no filament map) counts the printer's tool change time for every change, as the printer spends it parking
// one head and picking up the next. Nothing here sends anything to a printer.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SliceSummary } from '../src/slicer'
import { writeZip } from '../src/zip'
import { connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

/** Four 12 x 10 x 3 mm blocks, one per filament slot. */
function fourColorPlate(file: string): void {
  const vertices = [[0, 0, 0], [12, 0, 0], [12, 10, 0], [0, 10, 0], [0, 0, 3], [12, 0, 3], [12, 10, 3], [0, 10, 3]]
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const mesh = `<mesh><vertices>${vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`
  const ids = [1, 2, 3, 4]
  const objects = ids.map((id) => `<object id="${id}" type="model">${mesh}</object>`).join('')
  const items = ids.map((id, i) => `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${110 + (i % 2) * 30} ${110 + Math.floor(i / 2) * 30} 0"/>`).join('')
  writeFileSync(file, writeZip([
    { name: '3D/3dmodel.model', data: `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${items}</build></model>` },
    { name: 'Metadata/model_settings.config', data: `<config>${ids.map((id) => `<object id="${id}"><metadata key="extruder" value="${id}"/></object>`).join('')}</config>` },
  ]))
}

describe.skipIf(noSx())('the print time of a four-color plate on the Snapmaker U1', { timeout: sxTimeout }, () => {
  it('counts the tool change time for every change', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = join(h.dir, 'four-colors.3mf')
      fourColorPlate(model)
      const estimate = async (overrides: Record<string, unknown>): Promise<SliceSummary> => {
        const r = await h.call('slicerx_estimate_file', {
          model,
          profiles: ['machine:snapmaker-u1', 'process:standard'],
          filaments: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'].map((color, i) => ({ slot: i + 1, profile: 'filament:pla', color })),
          overrides: { enable_support: false, brim_type: 'no_brim', ...overrides },
        })
        expect(r.isError, text(r)).toBeFalsy()
        return data<SliceSummary>(r)
      }
      const stock = await estimate({})
      const none = await estimate({ machine_tool_change_time: 0 })
      expect(stock.filaments.filter((f) => f.filament_mm > 0)).toHaveLength(4)
      const changes = stock.tool_changes ?? 0
      expect(changes).toBeGreaterThanOrEqual(3)
      expect(none.tool_changes).toBe(changes)
      // The U1 profile's 5 s for each change, and nothing else moves.
      expect(Math.abs(stock.time_s - none.time_s - 5 * changes), `${stock.time_s} s against ${none.time_s} s, ${changes} changes`).toBeLessThan(1)
    } finally { await h.client.close() }
  })
})
