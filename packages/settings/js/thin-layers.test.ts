// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Material knowledge wired into the plan: thin layer guards, support pairings, first layer, retraction speed, structure hints.
import { describe, expect, it } from 'vitest'
import type { PrintConfig, SetupRef } from '@slicerx/contracts/settings'
import { mergeConfigs } from './import'
import { planSettings } from './plan'
import { heatCreepWarning } from './thinlayers'
import { loadProfile } from './testkit'
import { validate } from './validate'

const setup = (filament: string): SetupRef => ({ printer: 'bambu_x1c', nozzleDiameter: 0.4, filament })
const merged = mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', 'Demo PLA').config, loadProfile('demo', '0.20mm Standard @Demo').config)
const thin = { ...merged, smart_layer: 'quality', smart_layer_min_height: 0.08, smart_layer_max_height: 0.2, slow_down_layer_time: [2], slow_down_min_speed: [10], enable_support: true } as PrintConfig
const get = (p: ReturnType<typeof planSettings>, k: string) => p.changes.find((c) => c.key === k)

describe('minimum layer time guard', () => {
  it('raises the layer time to what the material family needs when sleipnir is on', () => {
    const plan = planSettings(setup('pla'), setup('hips'), thin)
    expect(get(plan, 'slow_down_layer_time')).toMatchObject({ after: [7], origin: 'filament' })
    expect(get(plan, 'slow_down_layer_time')?.reason).toContain('thin layers')
    expect(plan.advice.some((a) => a.text.includes('print more parts at once'))).toBe(true)
  })
  it('leaves the layer time alone when sleipnir is off', () => {
    const plan = planSettings(setup('pla'), setup('hips'), { ...thin, smart_layer: 'off' } as PrintConfig)
    expect(get(plan, 'slow_down_layer_time')?.after).toEqual([6])
  })
  it('validates the layer time against the guard', () => {
    const cfg = { smart_layer: 'quality', slow_down_layer_time: [2] } as unknown as PrintConfig
    expect(validate(cfg, { filament: 'abs' }).find((i) => i.code === 'smart_layer_min_layer_time')?.fix).toEqual({ key: 'slow_down_layer_time', value: 12 })
    expect(validate(cfg).map((i) => i.code)).not.toContain('smart_layer_min_layer_time')
    expect(validate({ ...cfg, slow_down_layer_time: [12] } as unknown as PrintConfig, { filament: 'abs' }).map((i) => i.code)).not.toContain('smart_layer_min_layer_time')
  })
})

describe('heat creep warning', () => {
  it('fires when a slowed thin layer extrudes a sliver of the filament limit', () => {
    expect(heatCreepWarning({ minSpeed: 10, width: 0.4, thinnest: 0.08, maxFlow: 21 })).toContain('0.32 mm3/s, 1.5 percent of the 21 mm3/s')
    expect(heatCreepWarning({ minSpeed: 10, width: 0.42, thinnest: 0.2, maxFlow: 21 })).toBeUndefined()
    expect(heatCreepWarning({ minSpeed: 10, width: 0.4, thinnest: 0.08, maxFlow: 0 })).toBeUndefined()
  })
  it('shows up in the plan for a thin sleipnir bound and for a thin fixed layer height', () => {
    expect(planSettings(setup('pla'), setup('pla'), thin).warnings.some((w) => w.includes('heat creep'))).toBe(true)
    const creep = { ...merged, layer_height: 0.08, slow_down_min_speed: [10] } as PrintConfig
    expect(planSettings(setup('pla'), setup('pla'), creep).warnings.some((w) => w.includes('heat creep'))).toBe(true)
    expect(planSettings(setup('pla'), setup('pla'), merged).warnings.some((w) => w.includes('heat creep'))).toBe(false)
  })
})

describe('material pairings and hints on a switch', () => {
  const plan = planSettings(setup('pla'), setup('hips'), thin)
  it('sets the support Z gap and interface layers, and names the soluble pairing', () => {
    expect(get(plan, 'support_top_z_distance')?.after).toBe(0.1)
    expect(get(plan, 'support_interface_top_layers')?.after).toBe(3)
    expect(plan.advice.some((a) => a.text.includes('is the soluble support for HIPS') && a.text.includes('limonene'))).toBe(true)
  })
  it('leaves supports alone when they are off or the material did not change', () => {
    const off = planSettings(setup('pla'), setup('hips'), { ...thin, enable_support: false } as PrintConfig)
    expect(get(off, 'support_top_z_distance')).toBeUndefined()
    expect(get(planSettings(setup('pla'), setup('pla'), thin), 'support_top_z_distance')).toBeUndefined()
  })
  it('plans the first layer speed and retraction speed the material asks for', () => {
    const petg = planSettings(setup('pla'), setup('petg'), { ...merged, retraction_speed: [45] } as PrintConfig)
    expect(get(petg, 'retraction_speed')).toMatchObject({ before: [45], after: [30], origin: 'filament' })
    expect(get(petg, 'initial_layer_speed')?.after).toEqual([30, 30])
  })
  it('adds the first layer and structure hints for the new material', () => {
    const petg = planSettings(setup('pla'), setup('petg'), merged)
    expect(petg.advice.some((a) => a.text.includes('Do not squish PETG'))).toBe(true)
    expect(petg.advice.some((a) => a.text.startsWith('PETG infill: gyroid pattern'))).toBe(true)
    expect(planSettings(setup('petg'), setup('petg'), merged).advice.some((a) => a.text.includes('Do not squish PETG'))).toBe(false)
  })
})
