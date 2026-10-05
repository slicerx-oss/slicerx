// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { EASY_GOALS } from '@slicerx/contracts/settings'
import type { PrintConfig } from '@slicerx/contracts/settings'
import { applyEasy } from './easy'
import { diffConfigs, firstStage, formatValue, toSettingsPlan } from './diff'
import { mergeConfigs } from './import'
import { settingDef } from './schema'
import { loadProfile } from './testkit'

const cfg = (o: Record<string, unknown>) => o as unknown as PrintConfig

describe('diffConfigs', () => {
  it('returns nothing for equal configs', () => {
    expect(diffConfigs(cfg({ layer_height: 0.2, a: [1, 2] }), cfg({ layer_height: 0.2, a: [1, 2] }))).toEqual([])
  })

  it('explains a numeric change with its effect', () => {
    const d = diffConfigs(cfg({ layer_height: 0.2 }), cfg({ layer_height: 0.12 }))
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ key: 'layer_height', kind: 'changed', stage: 'layers', before: 0.2, after: 0.12, unit: 'mm' })
    expect(d[0]?.reason).toContain('0.2 mm to 0.12 mm')
    expect(d[0]?.reason).toContain('Thinner layers')
  })

  it('says when a change has no effect because of a dependency', () => {
    const d = diffConfigs(cfg({ sparse_infill_density: 0, sparse_infill_pattern: 'grid' }), cfg({ sparse_infill_density: 0, sparse_infill_pattern: 'gyroid' }))
    expect(d[0]?.reason).toContain('no effect while Infill density is 0%')
  })

  it('handles added and removed keys', () => {
    const d = diffConfigs(cfg({ wall_loops: 2 }), cfg({ enable_support: true }))
    expect(d.map((x) => [x.key, x.kind]).sort()).toEqual([['enable_support', 'added'], ['wall_loops', 'removed']])
  })

  it('orders by slice stage and reports the first stage', () => {
    const d = diffConfigs(cfg({ outer_wall_speed: [100], wall_loops: 2, layer_height: 0.2 }), cfg({ outer_wall_speed: [200], wall_loops: 3, layer_height: 0.16 }))
    expect(d.map((x) => x.stage)).toEqual(['layers', 'perimeters', 'gcode'])
    expect(firstStage(d)).toBe('layers')
    expect(firstStage([])).toBeUndefined()
  })

  it('attributes Easy driven keys to their control', () => {
    const base = mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', 'Demo PLA').config, loadProfile('demo', '0.20mm Standard @Demo').config)
    const easy = { ...EASY_GOALS.fine, speed: 'sport' as const }
    const d = diffConfigs(base, applyEasy(easy, base), { easy })
    const lh = d.find((x) => x.key === 'layer_height')
    expect(lh?.reason).toBe('Layer height follows the Detail control (80).')
    expect(d.find((x) => x.key === 'wall_loops')?.reason).toContain('Strength')
    expect(d.find((x) => x.key === 'outer_wall_speed')?.reason).toContain('Speed')
  })

  it('compares real profiles: Standard against Fine on an X1C', () => {
    const a = loadProfile('demo', '0.20mm Standard @Demo').config
    const b = loadProfile('demo', '0.12mm Fine @Demo').config
    const d = diffConfigs(a, b)
    expect(d.find((x) => x.key === 'layer_height')).toMatchObject({ before: 0.2, after: 0.12 })
    expect(d.every((x) => x.reason.length > 0)).toBe(true)
  })
})

describe('formatValue', () => {
  it('formats units, booleans and repeated lists', () => {
    expect(formatValue(settingDef('layer_height'), 0.2)).toBe('0.2 mm')
    expect(formatValue(settingDef('enable_support'), true)).toBe('on')
    expect(formatValue(settingDef('nozzle_temperature'), [220, 220])).toBe('220 C')
    expect(formatValue(settingDef('outer_wall_speed'), [200, 350])).toBe('200, 350')
    expect(formatValue(undefined, undefined)).toBe('not set')
  })

  it('shows enum values by their labels', () => {
    expect(formatValue(settingDef('brim_type'), 'outer_only')).toBe('Outer brim only')
    expect(formatValue(settingDef('gcode_flavor'), 'marlin2')).toBe('Marlin 2')
    expect(formatValue(settingDef('wall_generator'), 'athena')).toBe('aegis')
    expect(formatValue(settingDef('z_hop_types'), ['Spiral Lift', 'Spiral Lift'])).toBe('Spiral')
    expect(formatValue(settingDef('z_hop_types'), ['Auto Lift', 'Slope Lift'])).toBe('Auto, Slope')
    expect(formatValue(settingDef('brim_type'), 'odd')).toBe('odd')
  })
})

describe('toSettingsPlan', () => {
  it('wraps a diff as a plan and puts dropped keys in unresolved', () => {
    const from = { printer: 'x1c', nozzleDiameter: 0.4, filament: 'pla' }
    const to = { printer: 'x1c', nozzleDiameter: 0.4, filament: 'petg' }
    const plan = toSettingsPlan(from, to, cfg({ nozzle_temperature: [220], hot_plate_temp: [55], fan_min_speed: [100] }), cfg({ nozzle_temperature: [250], hot_plate_temp: [80] }), { sources: ['kb:petg'] })
    expect(plan.changes.map((c) => c.key).sort()).toEqual(['hot_plate_temp', 'nozzle_temperature'])
    expect(plan.changes[0]).toMatchObject({ sources: ['kb:petg'], section: expect.any(String), label: expect.any(String) })
    expect(plan.unresolved.map((u) => u.key)).toEqual(['fan_min_speed'])
    expect(plan.computedMs).toBeLessThan(50)
  })

  it('diffs two full profiles within the 50 ms budget', () => {
    const a = loadProfile('demo', '0.20mm Standard @Demo').config
    const b = loadProfile('demo', '0.12mm Fine @Demo').config
    const t0 = performance.now()
    toSettingsPlan({ printer: 'p', nozzleDiameter: 0.4, filament: 'f' }, { printer: 'p', nozzleDiameter: 0.4, filament: 'f' }, a, b)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
