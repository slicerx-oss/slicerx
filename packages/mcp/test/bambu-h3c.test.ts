// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The stock Bambu Lab H3C printer profile (machine:bambu-h3c) on each nozzle size: a client resolves it, slices a 20 mm
// cube with it, and reads the bed, the nozzle and the layer height back from the file.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { boxStl, connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const NOZZLES = [0.2, 0.4, 0.6, 0.8]

/** The middle of what the printed layers cover in X and Y (absolute moves that extrude, arcs by their end points). */
function printedMiddle(gcode: string): [number, number] {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity]
  let printing = false
  for (const raw of gcode.split('\n')) {
    if (/^;\s?(LAYER_CHANGE|CHANGE_LAYER)/.test(raw)) printing = true
    if (!printing || !/^G[123] .*E\d/.test(raw)) continue
    const x = /X(-?[\d.]+)/.exec(raw)
    const y = /Y(-?[\d.]+)/.exec(raw)
    if (x) [x0, x1] = [Math.min(x0, Number(x[1])), Math.max(x1, Number(x[1]))]
    if (y) [y0, y1] = [Math.min(y0, Number(y[1])), Math.max(y1, Number(y[1]))]
  }
  return [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)]
}

describe('the stock Bambu Lab H3C', () => {
  it('resolves on each nozzle with the maker bed and nozzle, one extruder that holds nine nozzles', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:bambu-h3c'])
    for (const n of NOZZLES) {
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-h3c'], { nozzle_diameter: [n] })
      expect(config.nozzle_diameter, String(n)).toEqual([n])
      expect(config.printable_area, String(n)).toEqual([[0, 0], [330, 0], [330, 320], [0, 320]])
      expect(config.printable_height, String(n)).toBe(325)
      expect((config as Record<string, unknown>)['extruder_max_nozzle_count'], String(n)).toEqual([9])
    }
  })

  it.skipIf(noSx())('slices a 20 mm cube on each nozzle, with the bed, nozzle and layer height read back from the file', { timeout: sxTimeout * NOZZLES.length }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.ctx.profiles.prepare(['machine:bambu-h3c'])
    const model = join(h.dir, 'cube20.stl')
    writeFileSync(model, boxStl(20, 20, 20))
    for (const n of NOZZLES) {
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:bambu-h3c'], { nozzle_diameter: [n] })
      const r = await h.call('slicerx_slice_file', { model, profiles: ['machine:bambu-h3c'], overrides: { nozzle_diameter: [n] } })
      expect(r.isError, text(r)).toBeFalsy()
      const gcode = readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8')
      // The cube sits in the middle of the 330 x 320 bed, and the layers follow the resolved layer height.
      expect(printedMiddle(gcode), String(n)).toEqual([165, 160])
      const zs = [...gcode.matchAll(/^; Z_HEIGHT: ([\d.]+)/gm)].map((m) => Number(m[1]))
      expect(zs.length, String(n)).toBeGreaterThan(5)
      expect(zs[2]! - zs[1]!, String(n)).toBeCloseTo(Number(config.layer_height), 3)
    }
  })
})
