// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How far support's first layer reaches past the part, against what the engine prints: each figure is the outer edge
// of the first layer's support lines past the part's outline, read from the G-code of a part sliced with those
// settings (a stem under a wider cap, or a shelf, as named).
import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@slicerx/contracts'
import { towerRoomOf } from './arrange-room'
import { byObjectReach } from './by-object'
import { settingDefault } from './defaults'
import { objectPrintMargins, skirtSettings } from './print-margins'

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

describe('a config that leaves the skirt out', () => {
  // sx gives a key the config leaves out its schema default (its PrintConfig::default reads the same defaults.json), so
  // the margins count the skirt it prints then, not none.
  const keys = ['skirt_loops', 'skirt_distance', 'skirt_height', 'min_skirt_length', 'draft_shield']
  const spelled = Object.fromEntries(keys.map((k) => [k, settingDefault(k)!]))
  const bare: Record<string, SettingValue> = { nozzle_diameter: [0.4], line_width: '0.42', brim_type: 'no_brim' }
  const size = { w: 20, h: 20, height: 10 }

  it('reads each skirt key at its schema default', () => {
    expect(skirtSettings(bare)).toEqual(skirtSettings(spelled))
    expect(skirtSettings(bare).loops).toBeGreaterThan(0)
    expect(skirtSettings({ ...bare, skirt_loops: 0 }).loops).toBe(0)
  })

  it('keeps a copy, a by-object copy and the prime tower as far in as with the defaults written out', () => {
    const margins = objectPrintMargins(bare)
    expect(margins.skirt).toBe(true)
    expect(margins.reach(size)).toBeCloseTo(objectPrintMargins({ ...bare, ...spelled }).reach(size), 9)
    expect(margins.reach(size)).toBeGreaterThan(objectPrintMargins({ ...bare, skirt_loops: 0 }).reach(size))
    expect(byObjectReach(bare, 0)).toBeCloseTo(byObjectReach({ ...bare, ...spelled }, 0), 9)
    expect(byObjectReach(bare, 0)).toBeGreaterThan(0)
    const tower = (cfg: Record<string, SettingValue>) => towerRoomOf({ ...cfg, enable_prime_tower: true }, 2, { origin: [0, 0], size: { widthMm: 256, depthMm: 256 } }).towerRoom
    expect(tower(bare)).toEqual(tower({ ...bare, ...spelled }))
    expect(tower(bare)).not.toEqual(tower({ ...bare, skirt_loops: 0 }))
  })
})

describe('a skirt of its own with a minimum length, at the bed edge and the keep-out areas', () => {
  // An A1 with one loop asked for and 20 mm of filament as the minimum: sx prints 16 loops round a 3 mm part (the
  // by-object golden case "20 mm minimum, 3 mm part", whose reach comes from the slice's own loop count). Printing by
  // object, a plate of 3 mm cubes arranged with one loop counted put a skirt into the nozzle wrap check corner.
  const cfg: Record<string, SettingValue> = { nozzle_diameter: [0.4], line_width: '0.42', initial_layer_print_height: 0.2, filament_diameter: [1.75], brim_type: 'no_brim', skirt_loops: 1, skirt_distance: 2, min_skirt_length: 20 }
  const size = { w: 3, h: 3, height: 5 }
  const hull: [number, number][] = [[0, 0], [3, 0], [3, 3], [0, 3]]
  const printed = byObjectReach(cfg, 0, hull)

  it.each<[string, Record<string, SettingValue>]>([
    ['printing by object', { print_sequence: 'by object' }],
    ['with a skirt per object', { skirt_type: 'perobject' }],
  ])('counts the loops the minimum adds round the part, %s', (_name, changes) => {
    const margins = objectPrintMargins({ ...cfg, ...changes })
    expect(printed).toBeCloseTo(8.033274, 5)
    expect(margins.reach(size, undefined, hull)).toBeGreaterThanOrEqual(printed)
    // only the loop asked for counts at the wider spacing; the ones the minimum adds at the engine's own
    expect(margins.reach(size, undefined, hull) - printed).toBeLessThan(0.15)
    // with the part's first layer, round that
    expect(margins.reach(size, [{ outer: hull, holes: [] }], [[0, 0], [60, 0], [60, 60], [0, 60]])).toBeCloseTo(margins.reach(size, undefined, hull), 9)
    // with only its size, no fewer loops than round a part that wide and deep
    expect(margins.reach(size)).toBeGreaterThanOrEqual(margins.reach(size, undefined, hull))
  })

  it('leaves a combined skirt and a skirt with no minimum as they were', () => {
    const one = objectPrintMargins({ ...cfg, min_skirt_length: 0 }).reach(size)
    expect(objectPrintMargins(cfg).reach(size, undefined, hull)).toBeCloseTo(one, 9)
    expect(objectPrintMargins({ ...cfg, print_sequence: 'by object', min_skirt_length: 0 }).reach(size, undefined, hull)).toBeCloseTo(one, 9)
  })
})
