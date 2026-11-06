// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer whose nozzles are not all one size gets each nozzle's own line widths and layer height, one entry per
// extruder, from the process for that nozzle's size; a printer whose nozzles are one size gets the layer it always had.
import { describe, expect, it } from 'vitest'
import { isNozzleKey, nozzleLists, stockLayer, stockProcess } from './stock-layer'

const H2D = 'bambu-h2d'
const XL = 'prusa-xl-5-toolhead'

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

describe('per-nozzle process lists', () => {
  it('lists the widths and layer height that differ, entry by extruder, and leaves the rest', () => {
    const out = nozzleLists([
      { layer_height: 0.2, outer_wall_line_width: 0.42, wall_loops: 2, inner_wall_line_width: ['0.45', '0.45'] },
      { layer_height: 0.3, outer_wall_line_width: 0.62, wall_loops: 3, inner_wall_line_width: ['0.65', '0.66'] },
    ])
    expect(out['layer_height']).toEqual([0.2, 0.3])
    expect(out['outer_wall_line_width']).toEqual([0.42, 0.62])
    // A list written once per extruder takes the entry of its own extruder.
    expect(out['inner_wall_line_width']).toEqual(['0.45', '0.66'])
    // Not a width.
    expect(out['wall_loops']).toBeUndefined()
  })

  it('leaves out a key every nozzle gives the same, and counts one a process leaves out at its default', () => {
    expect(nozzleLists([{ line_width: 0.42 }, { line_width: 0.42 }])).toEqual({})
    expect(nozzleLists([{}, { layer_height: 0.3 }])['layer_height']).toEqual([0.2, 0.3])
  })

  it('names widths and the layer height only', () => {
    expect(['layer_height', 'line_width', 'outer_wall_line_width', 'initial_layer_line_width', 'min_bead_width'].every(isNozzleKey)).toBe(true)
    expect(['wall_loops', 'brim_width', 'outer_wall_speed', 'initial_layer_print_height'].some(isNozzleKey)).toBe(false)
  })
})

describe('the printer layer with nozzles of two sizes', () => {
  it('gives an H2D with 0.4 and 0.6 mm each nozzle its own layer height and widths', async () => {
    const layer = (await stockLayer({ printerId: H2D, tier: 'standard', slots: [], extruders: [{ mm: 0.4 }, { mm: 0.6 }] }))!
    const plain = (await stockLayer({ printerId: H2D, tier: 'standard', slots: [] }))!
    const p06 = await stockProcess(H2D, 'standard', 0.6)
    const v = layer.values
    expect(v['nozzle_diameter']).toEqual([0.4, 0.6].map((d) => (typeof first(v['nozzle_diameter']) === 'number' ? d : String(d))))
    // One value per key in the layer, the first nozzle's, as before.
    for (const k of Object.keys(v).filter(isNozzleKey)) expect(JSON.stringify(v[k]), k).toBe(JSON.stringify(plain.values[k]))
    const lists = layer.nozzleValues!
    // A process that leaves the layer height out prints at the default, 0.2 mm.
    expect(lists['layer_height']!.map(Number)).toEqual([Number(first(v['layer_height'] ?? 0.2)), Number(first(p06['layer_height']))])
    expect(Number(lists['layer_height']![1])).toBeGreaterThan(Number(lists['layer_height']![0]))
    const wall = lists['outer_wall_line_width']!
    expect(wall.length).toBe(2)
    expect(Number(wall[1])).toBeGreaterThan(Number(wall[0]))
    for (const [k, val] of Object.entries(lists)) {
      expect(isNozzleKey(k), k).toBe(true)
      expect(val.length, k).toBe(2)
    }
    expect(layer.nozzle).toBe(0.4)
  })

  it('gives an H2D with one size on both nozzles the layer it has without per-nozzle sizes', async () => {
    const plain = (await stockLayer({ printerId: H2D, tier: 'standard', slots: [] }))!
    const same = (await stockLayer({ printerId: H2D, tier: 'standard', slots: [], extruders: [{ mm: 0.4 }, { mm: 0.4 }] }))!
    expect(JSON.stringify(same.values)).toBe(JSON.stringify(plain.values))
    expect(same.nozzleValues).toBeUndefined()
  })

  it('gives a five-tool XL with one 0.6 mm tool that tool its widths, entry 3', async () => {
    const sizes = [0.4, 0.4, 0.6, 0.4, 0.4]
    const layer = (await stockLayer({ printerId: XL, tier: 'standard', slots: [], extruders: sizes.map((mm) => ({ mm })) }))!
    const lh = layer.nozzleValues!['layer_height']!
    expect(lh.length).toBe(5)
    expect(Number(lh[2])).toBeGreaterThan(Number(lh[0]))
    expect(Number(lh[1])).toBe(Number(lh[0]))
    expect(Number(lh[4])).toBe(Number(lh[0]))
  })
})
