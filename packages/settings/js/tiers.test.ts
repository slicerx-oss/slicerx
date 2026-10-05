// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The user tiers: Simple, a curated Advanced grouped by intent, Expert for the rest, profile keys hidden.
import { describe, expect, it } from 'vitest'
import { SETTINGS, settingDef } from './schema'
import { isVisible, settingsForTier } from './config'

const process = SETTINGS.filter((d) => d.section === 'process')
const count = (mode: string): number => process.filter((d) => d.mode === mode).length

describe('process tiers', () => {
  it('keeps Simple to the keys the controls drive and Advanced near 80', () => {
    expect(process.filter((d) => d.mode === 'simple').map((d) => d.key).sort()).toEqual(['brim_type', 'enable_support', 'layer_height', 'smart_layer', 'sparse_infill_density', 'wall_loops'])
    expect(count('advanced')).toBeGreaterThanOrEqual(70)
    expect(count('advanced')).toBeLessThanOrEqual(90)
    expect(count('expert')).toBeGreaterThan(count('advanced'))
  })
  it('hides profile keys from every tier', () => {
    for (const k of ['inherits', 'print_extruder_variant', 'print_extruder_id', 'wiping_volumes_extruders', 'prime_volume', 'compatible_printers', 'printer_model', 'compatible_prints']) expect(settingDef(k)?.mode, k).toBe('hidden')
    for (const tier of ['simple', 'advanced', 'expert'] as const) {
      const keys = new Set(settingsForTier('process', tier, { filamentCount: 3 }).map((d) => d.key))
      expect(keys.has('inherits')).toBe(false)
    }
  })
  it('gives every user tier process key an intent', () => {
    const intents = new Set(['quality', 'strength', 'speed', 'supports', 'adhesion', 'multicolor', 'effects', 'output'])
    for (const d of process.filter((x) => ['simple', 'advanced', 'expert'].includes(x.mode))) expect(intents.has(d.intent ?? ''), d.key).toBe(true)
  })
  it('shows multicolor keys only with two or more filaments', () => {
    const tower = settingDef('enable_prime_tower')!
    expect(tower.showWhen).toBe('multicolor')
    expect(isVisible(tower, { filamentCount: 1 })).toBe(false)
    expect(isVisible(tower, { filamentCount: 2 })).toBe(true)
    expect(settingsForTier('process', 'advanced', { filamentCount: 1 }).some((d) => d.intent === 'multicolor')).toBe(false)
    expect(settingsForTier('process', 'advanced', { filamentCount: 2 }).some((d) => d.intent === 'multicolor')).toBe(true)
  })
  it('puts fuzzy skin under Effects, the six sleipnir tuning keys under Expert, and shell mm in Advanced', () => {
    expect(settingDef('fuzzy_skin')).toMatchObject({ mode: 'advanced', intent: 'effects' })
    expect(settingDef('fuzzy_skin_noise_type')).toMatchObject({ mode: 'expert', intent: 'effects' })
    for (const k of ['smart_layer_min_height', 'smart_layer_max_height', 'smart_layer_smoothing', 'smart_layer_smoothing_radius', 'smart_layer_max_step_ratio']) expect(settingDef(k)?.mode, k).toBe('expert')
    expect(settingDef('top_shell_thickness')?.mode).toBe('advanced')
    expect(settingDef('top_shell_layers')?.mode).toBe('expert')
    expect(settingDef('support_type')?.mode).toBe('advanced')
  })
  it('tiers are cumulative', () => {
    const ctx = { filamentCount: 2 }
    const [s, a, e] = (['simple', 'advanced', 'expert'] as const).map((t) => settingsForTier('process', t, ctx).length) as [number, number, number]
    expect(s).toBeLessThan(a)
    expect(a).toBeLessThan(e)
  })
})
