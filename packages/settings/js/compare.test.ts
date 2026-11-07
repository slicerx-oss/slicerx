// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts/settings'
import { compareConfigs, SETTING_GROUP_ORDER, settingGroupLabel, settingGroupRank } from './compare'
import { defaultConfig, SETTINGS } from './schema'

const cfg = (o: Record<string, unknown>) => o as unknown as PrintConfig
const process = () => defaultConfig('process') as PrintConfig
const filament = () => defaultConfig('filament') as PrintConfig

describe('compareConfigs', () => {
  it('lists only the settings that differ, grouped, with labels and readable values', () => {
    const a = { ...process(), layer_height: 0.2, wall_loops: 2, sparse_infill_density: '15%' }
    const b = { ...process(), layer_height: 0.12, wall_loops: 4, sparse_infill_density: '15%' }
    const c = compareConfigs(cfg(a), cfg(b), { section: 'process' })
    expect(c.differ).toBe(2)
    const rows = c.groups.flatMap((g) => g.rows)
    expect(rows.map((r) => r.key).sort()).toEqual(['layer_height', 'wall_loops'])
    const lh = rows.find((r) => r.key === 'layer_height')!
    expect(lh).toMatchObject({ differs: true, a: 0.2, b: 0.12, aText: '0.2 mm', bText: '0.12 mm' })
    expect(lh.label).toBe('Layer height')
    // Each row sits under its settings group, by the group's label, never a key.
    const group = c.groups.find((g) => g.rows.some((r) => r.key === 'layer_height'))!
    expect(group.label).toBe(settingGroupLabel(group.group))
    expect(group.label).not.toMatch(/_/)
    for (const r of rows) expect(r.label).not.toMatch(/_/)
  })

  it('writes a count of layers in the singular for one: 1 layer, 2 layers, 0 layers', () => {
    const text = (n: number, m: number) => {
      const c = compareConfigs(cfg({ ...process(), raft_layers: n }), cfg({ ...process(), raft_layers: m }), { section: 'process' })
      const r = c.groups.flatMap((g) => g.rows).find((x) => x.key === 'raft_layers')!
      return [r.aText, r.bText]
    }
    expect(text(1, 2)).toEqual(['1 layer', '2 layers'])
    expect(text(0, 1)).toEqual(['0 layers', '1 layer'])
    // A per-slot list that repeats one value reads as that value, in the singular too.
    const listed = compareConfigs(cfg({ ...process(), raft_layers: [1, 1] }), cfg({ ...process(), raft_layers: 3 }), { section: 'process' })
    expect(listed.groups.flatMap((g) => g.rows).find((x) => x.key === 'raft_layers')!.aText).toBe('1 layer')
  })

  it('shows every setting of the kind with all, the matching ones marked as the same', () => {
    const a = { ...filament(), nozzle_temperature: [215] }
    const b = { ...filament(), nozzle_temperature: [230] }
    const some = compareConfigs(cfg(a), cfg(b), { section: 'filament' })
    const all = compareConfigs(cfg(a), cfg(b), { section: 'filament', all: true })
    expect(some.differ).toBe(1)
    expect(all.differ).toBe(1)
    const rows = all.groups.flatMap((g) => g.rows)
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.filter((r) => r.differs).map((r) => r.key)).toEqual(['nozzle_temperature'])
    // Only filament settings, none of another kind.
    expect(rows.some((r) => r.key === 'layer_height')).toBe(false)
  })

  it('leaves out hidden bookkeeping keys and the printer connection details', () => {
    const c = compareConfigs(cfg({ inherits: 'x', printhost_apikey: 'secret', print_host: 'a.local', retraction_length: [0.8] }), cfg({ inherits: 'y', printhost_apikey: 'other', print_host: 'b.local', retraction_length: [1.2] }), { section: 'printer', all: true })
    const keys = c.groups.flatMap((g) => g.rows).map((r) => r.key)
    expect(keys).toContain('retraction_length')
    expect(keys).not.toContain('printhost_apikey')
    expect(keys).not.toContain('print_host')
    expect(keys).not.toContain('inherits')
    expect(JSON.stringify(c)).not.toContain('secret')
  })

  it('orders groups by the settings order and rows by label', () => {
    const a = { ...process(), layer_height: 0.2, enable_support: false, outer_wall_speed: [200], wall_loops: 2 }
    const b = { ...process(), layer_height: 0.16, enable_support: true, outer_wall_speed: [150], wall_loops: 3 }
    const c = compareConfigs(cfg(a), cfg(b), { section: 'process' })
    const names = c.groups.map((g) => g.group)
    expect(names.indexOf('quality')).toBeLessThan(names.indexOf('support'))
    for (const g of c.groups) expect(g.rows.map((r) => r.label)).toEqual([...g.rows.map((r) => r.label)].sort((x, y) => x.localeCompare(y)))
  })

  it('reads a value set on one side only as the default the other side gets', () => {
    const c = compareConfigs(cfg({ wall_loops: 4 }), cfg({}), { section: 'process' })
    const r = c.groups.flatMap((g) => g.rows).find((x) => x.key === 'wall_loops')!
    expect(r.bText).toBe('not set')
    expect(r.b).toBeUndefined()
  })

  it('counts the lines a G-code setting adds and drops, with the same line diff as the project review', () => {
    const a = cfg({ machine_end_gcode: 'M104 S0\nM140 S0\nG28 X\nM84' })
    const b = cfg({ machine_end_gcode: 'M104 S0\nM140 S0\nG1 Z10\nG28 X\nM84\nM107' })
    const r = compareConfigs(a, b, { section: 'printer' }).groups.flatMap((g) => g.rows).find((x) => x.key === 'machine_end_gcode')!
    expect(r.differs).toBe(true)
    expect(r.aText).toBe('4 lines')
    expect(r.bText).toBe('6 lines')
    expect(r.lines).toMatchObject({ added: 2, removed: 0 })
    expect(r.lines!.unified).toContain('+G1 Z10')
    // Line endings and trailing spaces alone are no change, as in the project review.
    const same = compareConfigs(a, cfg({ machine_end_gcode: 'M104 S0  \r\nM140 S0\r\n\r\nG28 X\r\nM84' }), { section: 'printer' })
    expect(same.differ).toBe(0)
  })

  it('puts every group in the settings order, and a group the order does not name after the rest', () => {
    for (const section of ['process', 'filament', 'printer'] as const) {
      const groups = compareConfigs(cfg({}), cfg({}), { section, all: true }).groups.map((g) => g.group)
      const listedGroups = [...new Set(SETTINGS.filter((d) => d.section === section && d.mode !== 'hidden' && d.group !== 'network').map((d) => d.group))]
      expect(groups.sort((x, y) => settingGroupRank(x) - settingGroupRank(y) || x.localeCompare(y))).toEqual(groups)
      expect(new Set(groups)).toEqual(new Set(listedGroups))
      for (const g of groups) expect(SETTING_GROUP_ORDER, `${section} ${g}`).toContain(g)
    }
    expect(settingGroupRank('something-new')).toBe(SETTING_GROUP_ORDER.length)
    expect(settingGroupLabel('multimaterial')).toBe('Multi-material')
  })

  it('names keys the schema does not know, without a value or a row', () => {
    const c = compareConfigs(cfg({ layer_height: 0.2, made_up_key: 1 }), cfg({ layer_height: 0.2, made_up_key: 2 }))
    expect(c.unknownKeys).toEqual(['made_up_key'])
    expect(c.differ).toBe(0)
    expect(JSON.stringify(c.groups)).not.toContain('made_up_key')
  })

  it('lists both configs whole with all and no section, still without hidden or network keys', () => {
    const c = compareConfigs(cfg({ layer_height: 0.2, inherits: 'x', print_host: 'a' }), cfg({ nozzle_temperature: [200], inherits: 'y', print_host: 'b' }), { all: true })
    const keys = c.groups.flatMap((g) => g.rows).map((r) => r.key).sort()
    expect(keys).toEqual(['layer_height', 'nozzle_temperature'])
  })

  it('reads a G-code list per filament, and a whitespace change under all as the same text', () => {
    const list = compareConfigs(cfg({ filament_start_gcode: ['M106 S0', 'M106 S255'] }), cfg({ filament_start_gcode: ['M106 S0', 'M106 S128'] }), { section: 'filament', names: ['Mine', 'Theirs'] })
    const row = list.groups.flatMap((g) => g.rows).find((r) => r.key === 'filament_start_gcode')!
    expect(row.lines).toMatchObject({ added: 1, removed: 1 })
    expect(row.lines!.unified.split('\n').slice(0, 2)).toEqual(['--- Mine', '+++ Theirs'])
    const ws = compareConfigs(cfg({ machine_end_gcode: 'M84\n' }), cfg({ machine_end_gcode: 'M84   \r\n\r\n' }), { section: 'printer', all: true })
    const end = ws.groups.flatMap((g) => g.rows).find((r) => r.key === 'machine_end_gcode')!
    expect(end.differs).toBe(false)
    expect(end.lines).toBeUndefined()
  })

  it('reads a list that repeats one value as that value, as the settings panel writes it', () => {
    const c = compareConfigs(cfg({ fan_max_speed: [70, 70], nozzle_temperature: [220, 220], fan_min_speed: [30, 40] }), cfg({ fan_max_speed: [70], nozzle_temperature: [215], fan_min_speed: [30] }), { section: 'filament' })
    expect(c.groups.flatMap((g) => g.rows).map((r) => r.key).sort()).toEqual(['fan_min_speed', 'nozzle_temperature'])
    expect(c.differ).toBe(2)
  })

  it('keeps a printer list that sets how many extruders there are', () => {
    const c = compareConfigs(cfg({ nozzle_diameter: [0.4] }), cfg({ nozzle_diameter: [0.4, 0.4] }), { section: 'printer' })
    expect(c.groups.flatMap((g) => g.rows).map((r) => r.key)).toEqual(['nozzle_diameter'])
  })

  it('orders the groups in this exact order, and an unlisted group last', () => {
    expect(SETTING_GROUP_ORDER).toEqual(['quality', 'strength', 'speed', 'motion', 'overhangs', 'support', 'adhesion', 'cooling', 'temperature', 'filament', 'extrusion', 'retraction', 'drying', 'multimaterial', 'special', 'advanced', 'machine', 'gcode', 'profile'])
    const a = { ...process(), layer_height: 0.2, wall_loops: 2, outer_wall_speed: [200], enable_support: false, brim_width: 5, wipe_tower_x: [15], gcode_comments: false }
    const b = { ...process(), layer_height: 0.16, wall_loops: 4, outer_wall_speed: [150], enable_support: true, brim_width: 8, wipe_tower_x: [40], gcode_comments: true }
    const groups = compareConfigs(cfg(a), cfg(b), { section: 'process' }).groups.map((g) => g.group)
    expect(groups).toEqual([...groups].sort((x, y) => SETTING_GROUP_ORDER.indexOf(x) - SETTING_GROUP_ORDER.indexOf(y)))
    expect(groups.slice(0, 3)).toEqual(['quality', 'strength', 'speed'])
    expect(settingGroupRank('zzz')).toBeGreaterThan(settingGroupRank('profile'))
  })
})
