// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower line width and the first layer's infill width for clients: explained, in the stock H3C settings a
// client resolves, and taken by the engine, which prints the first layer's bottom surface at the width set. Nothing
// here sends anything to a printer.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { boxStl, connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

/** The widths the `; LINE_WIDTH:` lines give the first layer's bottom surface. */
function firstLayerBottomWidths(gcode: string): number[] {
  const out: number[] = []
  let layer = 0
  let feature = ''
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; CHANGE_LAYER')) layer++
    else if (line.startsWith('; FEATURE: ')) feature = line.slice(11).trim()
    else if (layer === 1 && feature === 'Bottom surface' && line.startsWith('; LINE_WIDTH: ')) out.push(Number(line.slice(14)))
  }
  return out
}

describe('the prime tower and first layer infill line widths', () => {
  it('are explained with their labels and no default', async () => {
    const h = await connect()
    try {
      const t = await h.call('slicerx_explain_setting', { key: 'prime_tower_line_width' })
      expect(t.isError, text(t)).toBeFalsy()
      expect(data(t)).toMatchObject({ key: 'prime_tower_line_width', label: 'Prime tower line width', section: 'process', unit: 'mm' })
      const f = await h.call('slicerx_explain_setting', { key: 'initial_layer_infill_line_width' })
      expect(f.isError, text(f)).toBeFalsy()
      expect(data(f)).toMatchObject({ key: 'initial_layer_infill_line_width', label: 'Infill line width on the first layer', section: 'process', unit: 'mm' })
    } finally { await h.client.close() }
  })

  it("are in the stock H3C's settings a client resolves", async () => {
    const h = await connect()
    try {
      await h.ctx.profiles.prepare(['machine:bambu-h3c'])
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-h3c'], {})
      expect((config as Record<string, unknown>)['prime_tower_line_width']).toBe(0.8)
      expect((config as Record<string, unknown>)['initial_layer_infill_line_width']).toBe(0.6)
    } finally { await h.client.close() }
  })
})

describe.skipIf(noSx())('a slice', { timeout: sxTimeout }, () => {
  it("prints the first layer's bottom surface at initial_layer_infill_line_width", async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const model = join(h.dir, 'plate.stl')
      writeFileSync(model, boxStl(20, 20, 4))
      const widths = async (overrides: Record<string, unknown>): Promise<number[]> => {
        const r = await h.call('slicerx_slice_file', { model, overrides: { printer_model: 'Bambu Lab P1S', initial_layer_line_width: 0.5, ...overrides } })
        expect(r.isError, text(r)).toBeFalsy()
        return firstLayerBottomWidths(readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8'))
      }
      const wide = await widths({ initial_layer_infill_line_width: 0.7 })
      expect(wide.length).toBeGreaterThan(0)
      for (const w of wide) expect(Math.abs(w - 0.7), String(w)).toBeLessThan(0.03)
      const plain = await widths({})
      expect(plain.length).toBeGreaterThan(0)
      for (const w of plain) expect(Math.abs(w - 0.5), String(w)).toBeLessThan(0.03)
    } finally { await h.client.close() }
  })
})
