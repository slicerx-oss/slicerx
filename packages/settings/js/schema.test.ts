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

  // The slice works these out when nothing sets them, so a default config leaves them out. An unset first layer flow
  // ratio prints at 1, and a default would add the key to the settings block of every file.
  const NO_DEFAULT = [
    'brim_loop_rounding',
    'skirt_brim_edge',
    'initial_layer_flow_ratio',
    'prime_tower_line_width',
    'initial_layer_infill_line_width',
    'initial_layer_outer_wall_line_width',
    'initial_layer_inner_wall_line_width',
    'initial_layer_sparse_infill_line_width',
    'initial_layer_internal_solid_infill_line_width',
    'initial_layer_top_surface_line_width',
    'initial_layer_support_line_width',
    'object_order_rule',
    'support_base_edge_inset',
    'chamber_cooling_mode',
  ]

  it('gives every setting a default, except the ones the slice works out', () => {
    expect(SETTINGS.filter((d) => d.default === undefined).map((d) => d.key)).toEqual(NO_DEFAULT)
    for (const k of NO_DEFAULT) expect(k in defaultConfig(), k).toBe(false)
  })

  it('has defaults that match the type and range', () => {
    for (const d of SETTINGS) {
      if (NO_DEFAULT.includes(d.key)) continue
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

describe('labels', () => {
  // Named features (design/NAMES.md) are values or marks, never a row's whole label: a partner page that lists rows
  // from this schema shows the label alone, so "sleipnir" by itself tells a maker nothing.
  const NAMED = ['mimir', 'aegis', 'sleipnir', 'atlas', 'norn', 'heimdall', 'huginn', 'muninn']
  it('gives every setting a plain label, not a feature name or a raw key', () => {
    const bad = SETTINGS.filter((d) => NAMED.includes(d.label.trim().toLowerCase()) || d.label === d.key).map((d) => `${d.key}: ${d.label}`)
    expect(bad).toEqual([])
  })
  it('names adaptive layer height in plain words, with sleipnir in its choices', () => {
    const d = settingDef('smart_layer')
    expect(d?.label).toBe('Adaptive layer height')
    expect(d?.enumLabels).toEqual(['Off', 'sleipnir: Quality', 'sleipnir: Strength'])
  })
})

describe('plain labels', () => {
  // Every shown label is plain words a maker reads. These patterns are the ways a label has read like a key before:
  // clipped words (efc, nc, ec, id, dist, pos, temp, min, max, num, pct, acc), a leading "Is", "Gcode" for G-code,
  // borrowed terms, a unit written into the label, a lone x, y, z or e in lower case, a doubled word. Add to the
  // table when a new one turns up.
  const ANY_CASE =
    /\b(efc|nc|ec|mmu|zaa|algo|calib|dev|dist|pos|temp|freq|damp|min|max|id|apikey|cafile|webui|printhost|gcode|dont|elefant|toolchange|multitool|bbl|pwm|perimeters?|vitrification|stamping|num|pct|acc|accel|vel|spd|cfg|params?)\b/i
  // Product and material names that stay in capitals (AMS, PTC, HRC) are fine; the same letters in lower case are a key.
  const LOWER_ONLY = /\b(ams|ptc|hrc|pa)\b/
  const LONE_AXIS = /\b[xyze]\b/
  const UNIT_IN_LABEL = /\((mm|s|%|C|deg)[^)]*\)|\bmm[23]?\b|\bper mm\b/
  const DOUBLED = /\b(\w+)\s+\1\b/i

  const problems = (label: string): string[] => {
    const out: string[] = []
    if (label.includes('_')) out.push('underscore')
    if (/^Is\b/.test(label)) out.push('label opens with "Is"')
    if (label !== label.trim() || label.includes('  ')) out.push('stray space')
    const any = ANY_CASE.exec(label)
    if (any) out.push(`internal word "${any[0]}"`)
    const lower = LOWER_ONLY.exec(label)
    if (lower) out.push(`lower case "${lower[0]}"`)
    if (LONE_AXIS.test(label)) out.push('lone lower case x, y, z or e')
    if (UNIT_IN_LABEL.test(label)) out.push('unit in the label')
    if (DOUBLED.test(label)) out.push('doubled word')
    return out
  }

  it('keeps clipped words, borrowed terms and units out of every label', () => {
    const bad = SETTINGS.map((d) => ({ d, why: problems(d.label) }))
      .filter((x) => x.why.length > 0)
      .map((x) => `${x.d.key}: "${x.d.label}" (${x.why.join(', ')})`)
    expect(bad).toEqual([])
  })

  it('starts every label with a capital or a digit, except the sleipnir rows', () => {
    const bad = SETTINGS.filter((d) => !/^[A-Z0-9]/.test(d.label) && !d.label.startsWith('sleipnir')).map((d) => `${d.key}: ${d.label}`)
    expect(bad).toEqual([])
  })

  it('catches the labels this table was written for', () => {
    expect(problems('Brim use efc outline')).toEqual(['internal word "efc"'])
    expect(problems('Gcode comments')).toEqual(['internal word "Gcode"'])
    expect(problems('First x layer fan speed')).toEqual(['lone lower case x, y, z or e'])
    expect(problems('Wave overhang flow (mm3 per mm)')).toEqual(['unit in the label'])
    expect(problems('Brim width')).toEqual([])
    expect(problems('Has PTC heater')).toEqual([])
    expect(problems('Foo_bar')).toEqual(['underscore'])
    expect(problems(' Foo')).toEqual(['stray space'])
    expect(problems('Wall wall')).toEqual(['doubled word'])
    expect(problems('Has ptc heater')).toEqual(['lower case "ptc"'])
    expect(problems('Brim width (mm)')).toEqual(['unit in the label'])
    expect(problems('Nozzle hardness')).toEqual([])
    // Round 5: leftover short forms and a label that opens with "Is" like a flag read aloud.
    expect(problems('Num layers')).toEqual(['internal word "Num"'])
    expect(problems('Fan speed pct')).toEqual(['internal word "pct"'])
    expect(problems('Acc to decel ratio')).toEqual(['internal word "Acc"'])
    expect(problems('Accel limit')).toEqual(['internal word "Accel"'])
    expect(problems('Is infill first')).toEqual(['label opens with "Is"'])
    expect(problems('Filament is a support material')).toEqual([])
    expect(problems('Print infill before walls')).toEqual([])
  })

  // Round 5: rows that named a value without saying which one ("Part fan maximum") or read as the key with a noun
  // tacked on ("Adaptive pressure advance bridges").
  it('names the round 5 rows in plain words', () => {
    const want: Record<string, string> = {
      fan_max_speed: 'Part fan maximum speed',
      fan_min_speed: 'Part fan minimum speed',
      adaptive_pressure_advance_bridges: 'Adaptive pressure advance for bridges',
      adaptive_pressure_advance_overhangs: 'Adaptive pressure advance for overhangs',
      filament_retraction_minimum_travel: 'Filament shortest travel that triggers a retraction',
      support_multi_bed_types: 'Supports several bed plates',
      nozzle_temperature_initial_layer: 'Nozzle temperature for the first layer',
      scarf_joint_flow_ratio: 'Scarf joint flow ratio',
      wipe_tower_bridging: 'Longest bridge in the prime tower',
      wall_maximum_resolution: 'Shortest wall segment kept',
    }
    for (const [key, label] of Object.entries(want)) expect(settingDef(key)?.label, key).toBe(label)
  })

  it('keeps clipped words out of the choices of a setting too', () => {
    // A choice may carry a size ("TPU 2.85 mm"), so only a unit is allowed here.
    const bad = SETTINGS.flatMap((d) => (d.enumLabels ?? []).map((l) => ({ d, l, why: problems(l).filter((w) => w !== 'unit in the label') })))
      .filter((x) => x.why.length > 0)
      .map((x) => `${x.d.key}: "${x.l}" (${x.why.join(', ')})`)
    expect(bad).toEqual([])
  })

  it('gives no two settings of a section the same label', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const d of SETTINGS) {
      const id = `${d.section}: ${d.label}`
      const first = seen.get(id)
      if (first) dup.push(`${id} (${first}, ${d.key})`)
      else seen.set(id, d.key)
    }
    expect(dup).toEqual([])
  })

  // A unit written into a label ("(mm2)") has to move to the unit field when the label is cleaned, or the panel,
  // the explain text and the validation messages show a bare number.
  it('keeps the unit of a setting whose label lost it', () => {
    expect(settingDef('wave_overhang_flow_mm3_per_mm')?.unit).toBe('mm2')
    expect(settingDef('wave_overhang_min_new_area')?.unit).toBe('mm2')
  })

  it('gives a unit to every setting whose key names one', () => {
    const NAMES = new Set(['mm', 'mm2', 'mm3', 'deg', 'percent'])
    const bad = SETTINGS.filter((d) => !d.unit && d.key.split('_').some((w) => NAMES.has(w))).map((d) => `${d.key}: ${d.label}`)
    expect(bad).toEqual([])
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
