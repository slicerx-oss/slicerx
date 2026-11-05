// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The stock Prusa MK3.5 printer profile (machine:prusa-mk3.5) on each nozzle the maker's profiles cover: a client
// resolves it, slices a 20 mm cube with it, and reads the bed, the nozzle and the start G-code back from the file.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSliceConfig } from '../src/config'
import { boxStl, connect, data, noSx, sxBin, sxTimeout, text } from './helpers'

const NOZZLES = [0.25, 0.4, 0.6, 0.8]

/** The `; key = value` lines of the G-code's header. */
function header(gcode: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of gcode.split('\n')) {
    if (!line.startsWith(';')) break
    const m = /^; ([a-z0-9_]+) = (.*)$/.exec(line)
    if (m) out.set(m[1]!, m[2]!)
  }
  return out
}

/** The middle of what the printed layers cover in X and Y (absolute moves that extrude). */
function printedMiddle(gcode: string): [number, number] {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity]
  let printing = false
  for (const raw of gcode.split('\n')) {
    if (raw.startsWith(';LAYER_CHANGE')) printing = true
    if (!printing || !/^G1 .*E\d/.test(raw)) continue
    const x = /X(-?[\d.]+)/.exec(raw)
    const y = /Y(-?[\d.]+)/.exec(raw)
    if (x) [x0, x1] = [Math.min(x0, Number(x[1])), Math.max(x1, Number(x[1]))]
    if (y) [y0, y1] = [Math.min(y0, Number(y[1])), Math.max(y1, Number(y[1]))]
  }
  return [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)]
}

describe('the stock Prusa MK3.5', () => {
  it('resolves on each nozzle with the maker bed and nozzle', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:prusa-mk3.5'])
    for (const n of NOZZLES) {
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:prusa-mk3.5'], { nozzle_diameter: [n] })
      expect(config.nozzle_diameter, String(n)).toEqual([n])
      expect(config.printable_area, String(n)).toEqual([[0, 0], [250, 0], [250, 210], [0, 210]])
      expect(config.printable_height, String(n)).toBe(210)
      expect(config.gcode_flavor, String(n)).toBe('marlin2')
    }
  })

  it.skipIf(noSx())('slices a 20 mm cube on each nozzle, with the bed, nozzle and start G-code read back from the file', { timeout: sxTimeout * NOZZLES.length }, async () => {
    const h = await connect({ engine: 'sx', sxBin })
    await h.ctx.profiles.prepare(['machine:prusa-mk3.5'])
    const model = join(h.dir, 'cube20.stl')
    writeFileSync(model, boxStl(20, 20, 20))
    for (const n of NOZZLES) {
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:prusa-mk3.5'], { nozzle_diameter: [n] })
      const r = await h.call('slicerx_slice_file', { model, profiles: ['machine:prusa-mk3.5'], overrides: { nozzle_diameter: [n] } })
      expect(r.isError, text(r)).toBeFalsy()
      const gcode = readFileSync(data<{ gcode_path: string }>(r).gcode_path, 'utf8')
      // The nozzle's own line width and layer height reach the file, and the cube sits in the middle of the 250 x 210 bed.
      const head = header(gcode)
      expect(Number(head.get('line_width')), String(n)).toBeCloseTo(Number((config.line_width as number[] | number | undefined) ?? NaN), 5)
      expect(Number(head.get('layer_height')), String(n)).toBeCloseTo(Number(config.layer_height), 5)
      expect(printedMiddle(gcode), String(n)).toEqual([125, 105])
      // PLA on the stock brass nozzle: no hardness or G-code warning.
      expect(data<{ warnings: string[] }>(r).warnings.filter((w) => /hardness|G-code/i.test(w)), String(n)).toEqual([])
      // The start G-code the profile carries runs before the first layer.
      // (Its first command, compared without the comment, which the engine may drop.)
      const code = (l: string): string => l.split(';')[0]!.trim()
      const start = code(String(config.machine_start_gcode).split('\n')[0]!)
      const lines = gcode.split('\n')
      const at = lines.findIndex((l) => code(l) === start)
      expect(start, String(n)).not.toBe('')
      expect(at, String(n)).toBeGreaterThan(-1)
      expect(at, String(n)).toBeLessThan(lines.findIndex((l) => l.startsWith(';LAYER_CHANGE')))
    }
  })
})
