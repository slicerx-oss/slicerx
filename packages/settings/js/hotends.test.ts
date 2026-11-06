// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab H3C holds nine hotends on one extruder, each with its own filament path. These helpers say how many
// hotends a printer has, which one takes 2.85 mm TPU, which hotend each filament goes on by the same rule the engine
// uses, and what the app and the MCP server read back. The stock layer carries the maker's per-hotend process values
// and the catalog's chamber limit.
import { describe, expect, it } from 'vitest'
import { autoHotends, hotendCount, hotendRows, hotendTypes, tpu285Slot, tpuHotend } from './hotends'
import { printerProfile } from './profiles'
import { stockLayer, stockProcess } from './stock-layer'

const TYPES = ['Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'TPU285', 'Standard']
const H3C = { nozzle_diameter: [0.4], extruder_max_nozzle_count: [9], default_nozzle_volume_type: TYPES, ams_nozzle_idx: [0], filament_diameter: [1.75, 2.85, 1.75] }

describe('hotends', () => {
  it('counts the hotends of a printer whose hotends are its tools, and none on any other', () => {
    expect(hotendCount(H3C)).toBe(9)
    // The H2C's rack is on its second extruder: two extruders, a filament map by extruder.
    expect(hotendCount({ nozzle_diameter: [0.4, 0.4], extruder_max_nozzle_count: [1, 6] })).toBe(0)
    expect(hotendCount({ nozzle_diameter: [0.4] })).toBe(0)
    expect(hotendCount({ nozzle_diameter: [0.4], extruder_max_nozzle_count: ['9'] })).toBe(9)
  })

  it('reads each hotend type, the TPU hotend, and which filaments are 2.85 mm TPU', () => {
    expect(hotendTypes(H3C)).toEqual(TYPES)
    // nozzle_volume_type wins when it lists every hotend.
    expect(hotendTypes({ ...H3C, nozzle_volume_type: [...TYPES].reverse() })[1]).toBe('TPU285')
    expect(tpuHotend(H3C)).toBe(7)
    expect(tpuHotend({ ...H3C, default_nozzle_volume_type: TYPES.map(() => 'Standard') })).toBeUndefined()
    expect(tpu285Slot(H3C, 2)).toBe(true)
    expect(tpu285Slot(H3C, 1)).toBe(false)
    // A preset whose only variant is TPU285 counts too, whatever its diameter field says.
    expect(tpu285Slot({ ...H3C, filament_diameter: [1.75, 1.75], filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive TPU285'] }, 2)).toBe(true)
  })

  it('puts each used filament on a hotend of its own, as the engine does', () => {
    // PLA, 2.85 mm TPU, PLA: the TPU on the TPU hotend (index 7), the others on the next free standard ones.
    expect(autoHotends(H3C, 3, [1, 2, 3])).toEqual([0, 7, 1])
    // A filament the plate does not print with stays on hotend 0.
    expect(autoHotends(H3C, 3, [2, 3])).toEqual([0, 7, 0])
    // Ten PLA filaments: eight standard hotends, then the rest share hotend 0, the one the external AMS feeds.
    const ten = { ...H3C, filament_diameter: Array(10).fill(1.75) }
    expect(autoHotends(ten, 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 0, 0])
  })

  it('reads back each filament on its tool, with the TPU tool flagged', () => {
    expect(hotendRows(H3C, [0, 7, 1], [1, 2, 3])).toEqual([
      { slot: 1, tool: 1, hotend: 0, tpuTool: false, tpu285: false },
      { slot: 2, tool: 8, hotend: 7, tpuTool: true, tpu285: true },
      { slot: 3, tool: 2, hotend: 1, tpuTool: false, tpu285: false },
    ])
    expect(hotendRows(H3C, [0, 7, 1], [3])).toEqual([{ slot: 3, tool: 2, hotend: 1, tpuTool: false, tpu285: false }])
  })
})

describe('H3C stock layer', () => {
  const slots = [{ type: 'PLA', vendor: 'BBL', family: 'Bambu PLA Basic' }, { type: 'TPU', vendor: 'BBL', family: 'Bambu TPU 75A(2.85mm)' }]

  it('carries the maker process values per hotend type, so the engine can give each object its hotend values', async () => {
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots })
    const v = layer!.values
    expect(v['print_extruder_variant']).toEqual(['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive TPU285'])
    expect(v['print_extruder_id']).toEqual([1, 1, 1])
    // 0.20 mm Standard @BBL H3C: standard, high flow and TPU285 outer wall speeds.
    expect(v['outer_wall_speed']).toEqual([200, 500, 200])
    expect(v['inner_wall_speed']).toEqual([300, 600, 300])
    // The MCP server builds process:<tier> from the same process.
    expect((await stockProcess('bambu-h3c', 'standard', 0.4))['outer_wall_speed']).toEqual([200, 500, 200])
  })

  it('keeps the 2.85 mm TPU preset on its own variant', async () => {
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots })
    expect(layer!.values['filament_extruder_variant']).toEqual(['Direct Drive Standard', 'Direct Drive TPU285'])
    expect(layer!.values['filament_diameter']).toEqual([1.75, 2.85])
  })

  it('gives the H3C its 65 C chamber limit', async () => {
    expect(printerProfile('bambu-h3c')!.limits.chamberMaxTemp).toBe(65)
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots })
    expect(layer!.limits.chamberMaxC).toBe(65)
  })

  it('leaves printers with two extruders as they were', async () => {
    const layer = await stockLayer({ printerId: 'bambu-h2d', tier: 'standard', slots: [{ type: 'PLA' }] })
    expect(Array.isArray(layer!.values['outer_wall_speed']) ? (layer!.values['outer_wall_speed'] as unknown[]).length : 1).toBeLessThanOrEqual(2)
    expect(layer!.limits.chamberMaxC).toBeUndefined()
  })
})
