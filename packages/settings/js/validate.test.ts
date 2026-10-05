// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts/settings'
import cases from '../fixtures/validate-cases.json'
import { disabledKeys, isEnabled } from './config'
import { defaultConfig, settingDef } from './schema'
import { validate } from './validate'
import { loadProfile } from './testkit'
import { mergeConfigs } from './import'

describe('validate against fixtures/validate-cases.json', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const codes = validate(c.config as unknown as PrintConfig).map((i) => i.code).sort()
      expect(codes).toEqual(c.codes)
    })
  }
})

describe('issues', () => {
  it('sorts errors first and offers fixes without applying them', () => {
    const cfg = { nozzle_diameter: [0.4], layer_height: 0.5, spiral_mode: true, enable_support: true } as unknown as PrintConfig
    const issues = validate(cfg)
    expect(issues[0]?.severity).toBe('error')
    expect(issues.find((i) => i.code === 'layer_above_nozzle')?.fix).toEqual({ key: 'layer_height', value: 0.3 })
    expect(cfg['layer_height']).toBe(0.5)
  })
  it('accepts real merged profiles without errors', () => {
    const cfg = mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', 'Demo PLA').config, loadProfile('demo', '0.20mm Standard @Demo').config)
    expect(validate(cfg).filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('dependencies', () => {
  const def = (k: string) => {
    const d = settingDef(k)
    if (!d) throw new Error(k)
    return d
  }
  it('disables infill keys at 0 percent and supports when off', () => {
    const cfg = { sparse_infill_density: 0, enable_support: false, wall_loops: 2 } as unknown as PrintConfig
    expect(isEnabled(def('sparse_infill_pattern'), cfg)).toBe(false)
    expect(isEnabled(def('support_type'), cfg)).toBe(false)
    expect(isEnabled(def('outer_wall_speed'), cfg)).toBe(true)
    expect(disabledKeys({ ...cfg, sparse_infill_pattern: 'grid', support_type: 'tree(auto)' } as unknown as PrintConfig)).toEqual(expect.arrayContaining(['sparse_infill_pattern', 'support_type']))
  })
  it('handles in, notin and comparisons', () => {
    const on = { enable_support: true, support_type: 'tree(auto)', support_threshold_angle: 0 } as unknown as PrintConfig
    expect(isEnabled(def('support_threshold_angle'), on)).toBe(true)
    expect(isEnabled(def('support_threshold_overlap'), on)).toBe(true)
    expect(isEnabled(def('tree_support_brim_width'), { ...on, tree_support_auto_brim: true } as unknown as PrintConfig)).toBe(false)
    expect(isEnabled(def('brim_width'), { brim_type: 'auto_brim' } as unknown as PrintConfig)).toBe(false)
    expect(isEnabled(def('brim_width'), { brim_type: 'outer_only' } as unknown as PrintConfig)).toBe(true)
  })
})

describe('automatic values', () => {
  it('accepts 0 on keys where 0 means auto, even under a positive minimum', () => {
    const cfg = { line_width: '0', outer_wall_line_width: '0', inner_wall_line_width: '0' } as unknown as PrintConfig
    expect(validate(cfg)).toEqual([])
    expect(validate({ line_width: '0.02' } as unknown as PrintConfig).map((i) => i.code)).toEqual(['line_width_range', 'outside_recommended_range'])
    expect(settingDef('line_width')?.auto).toBe(true)
  })
  it('accepts the schema defaults for every key', () => {
    const errors = validate(defaultConfig() as unknown as PrintConfig).filter((i) => i.severity === 'error')
    expect(errors.map((i) => i.message)).toEqual([])
  })
})

describe('sleipnir', () => {
  const cfg = (o: Record<string, unknown>) => o as unknown as PrintConfig
  it('uses a material research window when one is given', () => {
    const codes = (o: Record<string, unknown>, filament?: string) => validate(cfg(o), filament ? { filament } : {}).map((i) => i.code)
    const c = { nozzle_diameter: [0.4], smart_layer: 'quality', smart_layer_min_height: 0.1, smart_layer_max_height: 0.2 }
    expect(codes(c)).toEqual([])
    expect(codes(c, 'no_such_material')).toEqual([])
  })
})

describe('pattern lists and unavailable values', () => {
  const cfg = (o: Record<string, unknown>) => o as unknown as PrintConfig
  it('limits the bottom, internal solid and top patterns to what the engine accepts', () => {
    expect(settingDef('bottom_surface_pattern')?.enumValues).toEqual(['monotonic', 'monotonicline', 'rectilinear', 'alignedrectilinear', 'concentric', 'hilbertcurve', 'archimedeanchords', 'octagramspiral'])
    expect(settingDef('internal_solid_infill_pattern')?.enumValues).toEqual(settingDef('bottom_surface_pattern')?.enumValues)
    expect(settingDef('top_surface_pattern')?.enumValues).not.toContain('spiralinset')
    expect(validate(cfg({ bottom_surface_pattern: 'gyroid' })).map((i) => i.code)).toContain('bad_enum')
  })
  it('warns, and does not error, on a value the engine cannot print yet', () => {
    expect(settingDef('support_base_pattern')?.enumValues).toContain('lightning')
    expect(validate(cfg({ support_base_pattern: 'hollow' })).map((i) => i.code)).toEqual([])
    expect(validate(cfg({ support_base_pattern: 'lightning' })).map((i) => i.code)).toEqual([])
    const issues = validate(cfg({ wipe_tower_type: 'type2' }))
    expect(issues.map((i) => i.code)).toEqual(['enum_value_unavailable'])
    expect(issues[0]?.severity).toBe('warning')
  })
})
