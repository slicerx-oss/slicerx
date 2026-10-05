// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { SLICE_STAGES } from '@slicerx/contracts/slice'
import catalog from '../fixtures/knowledge-catalog.json'
import { EASY_MAP } from './easy'
import { SETTINGS, defaultConfig, invalidates, settingDef, settingsFor } from './schema'
import { isVectorType } from './value'

describe('schema', () => {
  it('covers Orca broadly', () => {
    expect(SETTINGS.length).toBeGreaterThan(600)
    expect(settingsFor('process').length).toBeGreaterThan(300)
    expect(settingsFor('filament').length).toBeGreaterThan(100)
    expect(settingsFor('printer').length).toBeGreaterThan(100)
  })

  it('has unique keys and complete entries', () => {
    const seen = new Set<string>()
    for (const d of SETTINGS) {
      expect(seen.has(d.key), d.key).toBe(false)
      seen.add(d.key)
      expect(d.label.length, d.key).toBeGreaterThan(0)
      expect(d.group.length, d.key).toBeGreaterThan(0)
      expect(['process', 'filament', 'printer']).toContain(d.section)
      expect(['simple', 'advanced', 'expert', 'develop', 'hidden']).toContain(d.mode)
    }
  })

  it('gives every entry a valid invalidates stage', () => {
    for (const d of SETTINGS) expect(SLICE_STAGES, d.key).toContain(d.invalidates)
  })

  it('has defaults that match the type and range', () => {
    for (const d of SETTINGS) {
      const v = d.default
      if (d.type === 'float' || d.type === 'int' || d.type === 'percent') expect(typeof v, d.key).toBe('number')
      if (d.type === 'bool') expect(typeof v, d.key).toBe('boolean')
      if (d.type === 'floatOrPercent' || d.type === 'string' || d.type === 'gcode') expect(typeof v, d.key).toBe('string')
      if (isVectorType(d.type)) expect(Array.isArray(v), d.key).toBe(true)
      if (d.min !== undefined && d.max !== undefined) expect(d.min, d.key).toBeLessThanOrEqual(d.max)
      if (typeof v === 'number' && d.min !== undefined && d.section !== 'printer') expect(v, d.key).toBeGreaterThanOrEqual(d.min)
      if (d.type === 'enum' && d.enumValues) expect(d.enumValues, d.key).toContain(v)
    }
  })

  it('names only real keys in dependencies and Easy rules', () => {
    for (const d of SETTINGS) for (const c of d.enabledWhen ?? []) expect(settingDef(c.key), `${d.key} depends on ${c.key}`).toBeDefined()
    for (const r of EASY_MAP.rules) for (const k of r.op === 'set' ? [r.key] : r.keys) expect(settingDef(k), k).toBeDefined()
  })

  it('flags the keys Easy mode writes', () => {
    for (const r of EASY_MAP.rules) for (const k of r.op === 'set' ? [r.key] : r.keys) expect(settingDef(k)?.easy, k).toBe(true)
  })

  it('has at least 60 keys with a description of their effect or a dependency', () => {
    expect(SETTINGS.filter((d) => d.effect || d.enabledWhen).length).toBeGreaterThan(60)
  })

  it('assigns the expected first stages', () => {
    expect(invalidates('layer_height')).toBe('layers')
    expect(invalidates('wall_loops')).toBe('perimeters')
    expect(invalidates('sparse_infill_density')).toBe('infill')
    expect(invalidates('top_shell_layers')).toBe('surfaces')
    expect(invalidates('outer_wall_speed')).toBe('gcode')
    expect(invalidates('nozzle_temperature')).toBe('gcode')
    expect(invalidates('enable_support')).toBe('paths')
    expect(invalidates('no_such_key')).toBe('layers')
  })

  it('builds a default config', () => {
    const c = defaultConfig('process')
    expect(c['layer_height']).toBe(0.2)
    expect('nozzle_diameter' in c).toBe(false)
  })
})

describe('knowledge/settings.yaml', () => {
  const NORM: Record<string, string> = {
    floats: 'float', ints: 'int', bools: 'bool', percents: 'percent', strings: 'string', enums: 'enum', gcode: 'string',
    floatOrPercent: 'fop', floatsOrPercents: 'fop', percent_or_mm: 'fop', percent_or_mm_s: 'fop', percent_or_mm_s2: 'fop',
  }
  // The catalog writes these fan keys as percent, a unit; Orca stores them as int or float lists.
  const KNOWN_TYPE_DIFFS = new Set(['additional_cooling_fan_speed', 'fan_max_speed', 'fan_min_speed', 'overhang_fan_speed'])
  const entries = Object.entries(catalog.settings) as [string, { type?: string; min?: number; max?: number; pilot?: string }][]

  it('has every key that Orca defines, with the same bounds', () => {
    let matched = 0
    for (const [key, k] of entries) {
      const d = settingDef(key)
      if (!d) continue
      matched++
      if (k.min !== undefined) expect(d.min, `${key} min`).toBe(k.min)
      if (k.max !== undefined) expect(d.max, `${key} max`).toBe(k.max)
      if (k.pilot) expect(d.pilot, `${key} pilot`).toBe(k.pilot)
    }
    expect(matched).toBeGreaterThan(120)
    expect(entries.filter(([key]) => !settingDef(key)).map(([key]) => key).sort()).toEqual(['curr_bed_type', 'flush_multiplier'])
  })

  it('has the same type, apart from the reported differences', () => {
    for (const [key, k] of entries) {
      const d = settingDef(key)
      if (!d || !k.type || KNOWN_TYPE_DIFFS.has(key)) continue
      expect(NORM[d.type] ?? d.type, key).toBe(NORM[k.type] ?? k.type)
    }
  })
})
