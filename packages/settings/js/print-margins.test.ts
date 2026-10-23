// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How far support's first layer reaches past the part, against what the engine prints: each figure is the outer edge
// of the first layer's support lines past the part's outline, read from the G-code of a part sliced with those
// settings (a stem under a wider cap, or a shelf, as named).
import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@slicerx/contracts'
import { objectPrintMargins } from './print-margins'

/** A P1S with its 0.4 mm nozzle and widths, and nothing but support round the part. */
const P1S: Record<string, SettingValue> = {
  nozzle_diameter: [0.4],
  line_width: '0.42',
  support_line_width: '0.42',
  initial_layer_line_width: '0.5',
  initial_layer_print_height: 0.2,
  enable_support: true,
  support_type: 'normal(auto)',
  brim_type: 'no_brim',
  skirt_loops: 0,
}
/** A Prusa MK4: widths in percent of the nozzle. */
const MK4: Record<string, SettingValue> = { ...P1S, line_width: '110%', support_line_width: '96%', initial_layer_line_width: '120%' }

const reach = (cfg: Record<string, SettingValue>) => objectPrintMargins(cfg).reach({ w: 40, h: 40, height: 10 })

describe('support reach on the first layer', () => {
  it.each<[string, Record<string, SettingValue>, number]>([
    ['normal, 30 mm cap', P1S, 4.452],
    ['normal, 34.55 mm cap, just past a grid cell', P1S, 5.054],
    ['normal, grid turned 30 degrees, 33.6 mm cap', { ...P1S, support_angle: 30 }, 6.803],
    ['normal, grid turned 45 degrees, 33.2 mm cap', { ...P1S, support_angle: 45 }, 6.736],
    ['normal, grid turned 45 degrees, 33 mm cap', { ...P1S, support_angle: 45 }, 6.836],
    ['normal, 5 mm pattern spacing', { ...P1S, support_base_pattern_spacing: 5 }, 3.32],
    ['normal, 4 mm first layer expansion', { ...P1S, raft_first_layer_expansion: 4 }, 6.452],
    ['normal, no first layer expansion', { ...P1S, raft_first_layer_expansion: 0 }, 2.452],
    ['normal, 0.6 mm support lines', { ...P1S, support_line_width: '0.6' }, 2.565],
    ['normal, 0.3 mm first layer', { ...P1S, initial_layer_print_height: 0.3 }, 4.312],
    ['snug', { ...P1S, support_style: 'snug' }, 2],
    ['organic tree (the tree default), 40 mm cap 5 mm up', { ...P1S, support_type: 'tree(auto)' }, 5.414],
    ['slim tree, 8 mm branches', { ...P1S, support_type: 'tree(auto)', support_style: 'tree_slim', tree_support_branch_diameter: 8 }, 4.887],
    ['strong tree, 10 mm shelf', { ...P1S, support_type: 'tree(auto)', support_style: 'tree_strong' }, 3.995],
    ['hybrid tree', { ...P1S, support_type: 'tree(auto)', support_style: 'tree_hybrid' }, 2.35],
    ['MK4 normal, four legs under a 40 mm top', MK4, 4.9],
    ['MK4 organic tree', { ...MK4, support_type: 'tree(auto)' }, 4.507],
  ])('covers %s', (_name, cfg, measured) => {
    expect(reach(cfg)).toBeGreaterThanOrEqual(measured)
  })

  it('is no more than the grid cell the engine can stretch the support by', () => {
    // A cap just past a cell boundary gets almost a whole cell: the reach is only that far above it.
    expect(reach(P1S) - 5.054).toBeLessThan(0.05)
  })

  it('is nothing with support off', () => {
    expect(reach({ ...P1S, enable_support: false })).toBe(0)
  })
})

describe('an automatic first layer expansion', () => {
  // Bambu Studio writes -1 for an automatic raft_first_layer_expansion; the engine reads any value below 0 as 2 mm.
  const grow = (cfg: Record<string, SettingValue>) => objectPrintMargins(cfg).grow({ w: 40, h: 40, height: 10 })
  it.each<SettingValue>([-1, '-1', -0.5])('reads %s as 2 mm for support', (v) => {
    expect(reach({ ...P1S, raft_first_layer_expansion: v })).toBeCloseTo(reach({ ...P1S, raft_first_layer_expansion: 2 }), 9)
    expect(reach({ ...P1S, support_type: 'tree(auto)', raft_first_layer_expansion: v })).toBeCloseTo(reach({ ...P1S, support_type: 'tree(auto)', raft_first_layer_expansion: 2 }), 9)
  })
  it.each<SettingValue>([-1, '-1', -0.5])('reads %s as 2 mm for a raft', (v) => {
    const raft = { ...P1S, enable_support: false, raft_layers: 3, raft_expansion: 0 }
    expect(grow({ ...raft, raft_first_layer_expansion: v })).toBeCloseTo(grow({ ...raft, raft_first_layer_expansion: 2 }), 9)
    expect(grow({ ...raft, raft_first_layer_expansion: 2 })).toBeCloseTo(2, 9)
  })
})
