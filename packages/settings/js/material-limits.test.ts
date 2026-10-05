// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Material layer height bands, speed ceilings and sleipnir notes from knowledge/filaments.
import { describe, expect, it } from 'vitest'
import type { PrintConfig, SetupRef } from '@slicerx/contracts/settings'
import { mergeConfigs } from './import'
import { materialKnowledge, planSettings } from './plan'
import { smartLayerLimits, smartLayerWindow } from './smartlayer'
import { loadProfile } from './testkit'
import { validate } from './validate'

const setup = (filament: string, nozzleDiameter = 0.4): SetupRef => ({ printer: 'bambu_x1c', nozzleDiameter, filament })
const base = (): PrintConfig => mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', 'Demo PLA').config, loadProfile('demo', '0.20mm Standard @Demo').config)
const get = (p: ReturnType<typeof planSettings>, k: string) => p.changes.find((c) => c.key === k)

describe('material research in the knowledge table', () => {
  it('has a layer band and speed limits for every material', () => {
    for (const id of ['pla', 'pla_silk', 'tpu_95a', 'petg_cf', 'pa_cf']) {
      const m = materialKnowledge(id)
      expect(m?.layerBand?.min, id).toBeGreaterThan(0)
      expect(m?.layerBand?.max, id).toBeLessThanOrEqual(0.75)
      expect(m?.speeds?.printMax, id).toBeGreaterThan(0)
    }
    expect(materialKnowledge('pla_silk')).toMatchObject({ layerBand: { min: 0.3, max: 0.5 }, speeds: { outerWallMax: 60 } })
  })

  it('takes the sleipnir window from the material research, or from its band when there is no research', () => {
    expect(smartLayerWindow(0.4, materialKnowledge('pla_silk'))).toEqual({ min: 0.12, max: 0.2 })
    expect(smartLayerWindow(0.4, materialKnowledge('pla'))).toEqual({ min: 0.08, max: 0.28 })
    expect(smartLayerWindow(0.4, { layerBand: { min: 0.2, max: 0.7, src: [] }, smartLayer: { minRatio: 0.3, src: [] } })).toEqual({ min: 0.12, max: 0.28 })
    expect(smartLayerWindow(0.4, { layerBand: { min: 0.2, max: 0.7, src: [] } })).toEqual({ min: 0.08, max: 0.28 })
    expect(smartLayerLimits(materialKnowledge('pla_silk')).src.length).toBeGreaterThan(0)
  })

  it('validate uses the material window', () => {
    const cfg = { nozzle_diameter: [0.4], smart_layer: 'quality', smart_layer_min_height: 0.1, smart_layer_max_height: 0.2 } as unknown as PrintConfig
    expect(validate(cfg).map((i) => i.code)).toEqual([])
    expect(validate(cfg, { filament: 'pla_silk' }).map((i) => i.code)).toEqual(['smart_layer_min_low'])
    expect(validate(cfg, { filament: 'pla' }).map((i) => i.code)).toEqual([])
    expect(validate({ ...cfg, smart_layer_max_height: 0.28 } as PrintConfig, { filament: 'pla' }).map((i) => i.code)).toEqual(['smart_layer_max_high'])
  })
})

describe('planSettings with material limits', () => {
  const to = setup('pla_silk')
  const plan = planSettings(setup('pla'), to, base())

  it('caps the speeds the silk data sheet caps, elementwise on lists', () => {
    expect(get(plan, 'outer_wall_speed')).toMatchObject({ before: [200, 350], after: [60, 60], origin: 'filament', klass: 'edit' })
    expect(get(plan, 'outer_wall_speed')?.reason).toContain('should not print faster than 60 mm/s')
    expect(get(plan, 'inner_wall_speed')?.after).toEqual([250, 250])
    expect(get(plan, 'outer_wall_speed')?.sources.length).toBeGreaterThan(0)
  })

  it('leaves speeds alone when they already fit', () => {
    const slow = { ...base(), outer_wall_speed: [40, 50] } as PrintConfig
    expect(get(planSettings(setup('pla'), to, slow), 'outer_wall_speed')).toBeUndefined()
  })

  it('keeps layer height inside the material band, and records a clamp when a goal breaks it', () => {
    const fine = { ...base(), layer_height: 0.08 } as PrintConfig
    expect(get(planSettings(setup('pla'), to, fine), 'layer_height')).toMatchObject({ before: 0.08, after: 0.12, origin: 'filament' })
    const goal = planSettings(setup('pla'), to, base(), { intent: { goals: [{ id: 'speed', level: 'draft' }] } })
    expect(get(goal, 'layer_height')).toBeUndefined() // clamped back to the 0.2 mm the plate already has
    expect(goal.clamps.find((c) => c.key === 'layer_height')).toMatchObject({ by: 'filament', requested: 0.28, applied: 0.2 })
    expect(goal.clamps.find((c) => c.key === 'layer_height')?.reason).toContain('kept between 0.12 mm and 0.2 mm for PLA Silk')
  })

  it('keeps sleipnir bounds in the silk window and adds the research notes', () => {
    const smart = { ...base(), smart_layer: 'quality', smart_layer_min_height: 0.1, smart_layer_max_height: 0.3 } as PrintConfig
    const p = planSettings(setup('pla'), to, smart)
    expect(get(p, 'smart_layer_min_height')).toMatchObject({ before: 0.1, after: 0.12, origin: 'filament' })
    expect(get(p, 'smart_layer_max_height')).toMatchObject({ before: 0.3, after: 0.2 })
    expect(p.advice.some((a) => a.kind === 'material' && a.text.includes('Silk shine hides layer lines'))).toBe(true)
    expect(p.advice.some((a) => a.text.includes('minimum layer time'))).toBe(true)
    const strength = planSettings(setup('pla'), to, { ...smart, smart_layer: 'strength' } as PrintConfig)
    expect(strength.advice.some((a) => a.text.includes('Z tensile'))).toBe(true)
    expect(strength.advice.some((a) => a.text.includes('Silk shine hides layer lines'))).toBe(false)
    expect(planSettings(setup('pla'), to, base()).advice.some((a) => a.text.includes('Silk shine'))).toBe(false)
  })
})
