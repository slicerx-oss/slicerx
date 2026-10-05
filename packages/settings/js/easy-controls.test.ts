// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every Easy control and the config keys it resolves to, so a label cannot promise one thing and write another.
import { describe, expect, it } from 'vitest'
import { EASY_DEFAULTS } from '@slicerx/contracts/settings'
import type { EasySettings, PrintConfig } from '@slicerx/contracts/settings'
import { settingDef } from './schema'
import { applyChoice, applyEasy, choiceValue, deriveShellLayers, easyChoices, goalEasy } from './easy'

const base = { nozzle_diameter: [0.4], layer_height: 0.2, wall_loops: 2, sparse_infill_density: '15%', outer_wall_speed: 100 } as unknown as PrintConfig
const with_ = (patch: Partial<EasySettings>): PrintConfig => applyEasy({ ...EASY_DEFAULTS, ...patch }, base)

describe('Easy controls write what they say', () => {
  it('Supports off turns supports off', () => {
    expect(with_({ supports: 'off' })['enable_support']).toBe(false)
  })
  it('Supports auto is tree(auto) from the build plate at the approved 25 degrees', () => {
    expect(with_({ supports: 'auto' })).toMatchObject({ enable_support: true, support_type: 'tree(auto)', support_on_build_plate_only: true, support_threshold_angle: 25 })
  })
  it('Supports painted keeps only painted supports, anywhere on the model', () => {
    expect(with_({ supports: 'painted' })).toMatchObject({ enable_support: true, support_type: 'tree(manual)', support_on_build_plate_only: false, support_threshold_angle: 25 })
  })
  it('the old supports name everywhere reads as auto', () => {
    expect(with_({ supports: 'everywhere' })).toEqual(with_({ supports: 'auto' }))
  })
  it('Brim on writes an auto brim, off writes none', () => {
    expect(with_({ brim: true })).toMatchObject({ brim_type: 'auto_brim', brim_width: 5 })
    expect(with_({ brim: false })['brim_type']).toBe('no_brim')
  })
  it('Strength changes the walls and the infill together', () => {
    const low = with_({ strength: 10 })
    const high = with_({ strength: 90 })
    expect(Number(high['wall_loops'])).toBeGreaterThan(Number(low['wall_loops']))
    expect(parseFloat(String(high['sparse_infill_density']))).toBeGreaterThan(parseFloat(String(low['sparse_infill_density'])))
    expect(high['sparse_infill_pattern']).toBe('gyroid')
  })
  it('Detail sets the layer height, finer for a higher value', () => {
    expect(Number(with_({ detail: 90 })['layer_height'])).toBeLessThan(Number(with_({ detail: 10 })['layer_height']))
  })
  it('Speed scales the outer wall speed in the order quality, balanced, fast', () => {
    const v = (speed: EasySettings['speed']): number => Number(with_({ speed })['outer_wall_speed'])
    expect(v('quality')).toBeLessThan(v('balanced'))
    expect(v('balanced')).toBeLessThan(v('fast'))
  })
  it('the old speed names read as the new ones', () => {
    for (const [old, now] of [['silent', 'quality'], ['standard', 'balanced'], ['sport', 'fast'], ['ludicrous', 'fastest'], ['gentle', 'quality'], ['maximum', 'fastest']] as const) expect(with_({ speed: old })).toEqual(with_({ speed: now }))
  })
  it('Vary layer height writes smart_layer: off, quality, and strength from Strength 70', () => {
    expect(with_({ varyLayerHeight: false })['smart_layer']).toBe('off')
    expect(with_({ varyLayerHeight: true, strength: 20 })['smart_layer']).toBe('quality')
    expect(with_({ varyLayerHeight: true, strength: 70 })['smart_layer']).toBe('strength')
  })
  it('a saved smartLayer mode keeps its mode', () => {
    const { varyLayerHeight: _unused, ...rest } = EASY_DEFAULTS
    expect(applyEasy({ ...rest, smartLayer: 'strength', strength: 20 }, base)['smart_layer']).toBe('strength')
  })
  it('shell thickness is in mm and the layer counts follow it', () => {
    const c = with_({ detail: 40 })
    expect(c).toMatchObject({ top_shell_thickness: 1, bottom_shell_thickness: 0.6 })
    expect(deriveShellLayers({ ...c, top_shell_thickness: 1.5, layer_height: 0.2 })['top_shell_layers']).toBe(8)
    expect(deriveShellLayers({ ...c, bottom_shell_thickness: 0.5, layer_height: 0.12 })['bottom_shell_layers']).toBe(5)
  })
})

describe('goal chips', () => {
  it('Fine runs at standard speed, as the Fine preset does', () => {
    expect(goalEasy('fine').speed).toBe('balanced')
  })
  it('every goal uses Auto supports', () => {
    for (const g of ['draft', 'standard', 'fine', 'strong'] as const) expect(goalEasy(g).supports).toBe('auto')
  })
})

describe('Advanced choices', () => {
  it('overhang slowdown has three levels that read back', () => {
    for (const v of ['off', 'on', 'careful']) expect(choiceValue(applyChoice(base, 'overhangSlowdown', v), 'overhangSlowdown')).toBe(v)
    expect(applyChoice(base, 'overhangSlowdown', 'careful')).toMatchObject({ enable_overhang_speed: [true], slowdown_for_curled_perimeters: [true] })
  })
  it('unsupported overhangs picks one of none, loops, waves', () => {
    for (const v of ['none', 'loops', 'waves']) expect(choiceValue(applyChoice(base, 'unsupportedOverhangs', v), 'unsupportedOverhangs')).toBe(v)
    expect(applyChoice(base, 'unsupportedOverhangs', 'waves')).toMatchObject({ wave_overhangs: true, extra_perimeters_on_overhangs: false })
  })
  it('a custom mix reads as no choice and an unknown value changes nothing', () => {
    expect(choiceValue({ ...base, wave_overhangs: true, extra_perimeters_on_overhangs: true }, 'unsupportedOverhangs')).toBeUndefined()
    expect(applyChoice(base, 'unsupportedOverhangs', 'nope')).toBe(base)
  })
  it('every key a choice sets exists in the schema', () => {
    for (const c of Object.values(easyChoices())) for (const set of Object.values(c.values)) for (const k of Object.keys(set)) expect(settingDef(k), k).toBeDefined()
  })
})
