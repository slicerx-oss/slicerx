// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PrintConfig, SetupRef } from '@slicerx/contracts/settings'
import { mergeConfigs } from './import'
import { applyPlan, listMaterials, listPrinters, materialKnowledge, planSettings, printerKnowledge } from './plan'
import { settingDef } from './schema'
import { loadProfile } from './testkit'
import { validate } from './validate'

const x1c = (filament: string, nozzleDiameter = 0.4): SetupRef => ({ printer: 'bambu_x1c', nozzleDiameter, filament })
const base = (): PrintConfig =>
  mergeConfigs(
    loadProfile('demo', 'Demo Printer 0.4 nozzle').config,
    loadProfile('demo', 'Demo PLA').config,
    loadProfile('demo', '0.20mm Standard @Demo').config,
  )
const get = (p: ReturnType<typeof planSettings>, k: string) => p.changes.find((c) => c.key === k)

describe('planSettings: PLA to PETG on an X1C', () => {
  const b = base()
  const plan = planSettings(x1c('pla'), x1c('petg'), b)
  it('changes temperatures, fans, flow and retraction with before, after, reason and sources', () => {
    expect(get(plan, 'nozzle_temperature')).toMatchObject({ before: [220, 220], after: [245, 245], unit: 'C', section: 'filament' })
    expect(get(plan, 'fan_max_speed')?.after).toEqual([40])
    expect(get(plan, 'overhang_fan_speed')?.after).toEqual([90])
    expect(get(plan, 'filament_flow_ratio')?.after).toEqual([0.95, 0.95])
    expect(get(plan, 'retraction_length')).toBeUndefined() // the X1C profile already retracts 0.8 mm
    expect(get(plan, 'hot_plate_temp')?.after).toEqual([70])
    for (const c of plan.changes) {
      expect(c.reason.length, c.key).toBeGreaterThan(10)
      expect(settingDef(c.key), c.key).toBeDefined()
    }
    const t = get(plan, 'nozzle_temperature')
    expect(t?.sources).toContain('prusa_kb_petg')
    expect(t?.reason).toContain('PETG runs at 245 C')
  })
  it('warns that PETG should be dried', () => {
    expect(plan.warnings.join(' ')).toContain('Dry PETG')
  })
  it('skips keys that already have the target value', () => {
    const again = planSettings(x1c('pla'), x1c('petg'), applyPlan(b, plan, { includeRead: true }))
    expect(again.changes).toEqual([])
  })
  it('applyPlan returns a new config and leaves the input alone', () => {
    const copy = structuredClone(b)
    const next = applyPlan(b, plan)
    expect(b).toEqual(copy)
    expect(next['nozzle_temperature']).toEqual([245, 245])
    expect(next['layer_height']).toBe(b['layer_height'])
  })
  it('runs well inside the 50 ms budget', () => {
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) planSettings(x1c('pla'), x1c('petg'), b)
    expect((performance.now() - t0) / 20).toBeLessThan(50)
  })
})

describe('planSettings: nozzle and printer switches', () => {
  it('keeps layer height and line width proportional to the nozzle', () => {
    const plan = planSettings(x1c('pla'), x1c('pla', 0.6), base())
    expect(get(plan, 'nozzle_diameter')?.after).toEqual([0.6])
    expect(get(plan, 'layer_height')).toMatchObject({ before: 0.2, after: 0.3 })
    expect(get(plan, 'outer_wall_line_width')).toMatchObject({ before: '0.42', after: '0.63' })
    expect(get(plan, 'nozzle_temperature')).toBeUndefined()
  })
  it('needs a base config to scale process keys', () => {
    expect(get(planSettings(x1c('pla'), x1c('pla', 0.6)), 'layer_height')).toBeUndefined()
  })
  it('warns when the printer cannot suit the material', () => {
    const plan = planSettings(x1c('pla'), { printer: 'prusa_mk4s', nozzleDiameter: 0.4, filament: 'abs' })
    expect(plan.warnings.join(' ')).toContain('needs an enclosure')
    expect(get(plan, 'printable_height')).toBeDefined()
    expect(get(plan, 'gcode_flavor')?.after).toBe('marlin2')
  })
  it('warns about a nozzle that is too small or soft for the material', () => {
    const cf = planSettings(x1c('pla'), { printer: 'prusa_mk4s', nozzleDiameter: 0.2, filament: 'pa_cf' })
    expect(cf.warnings.join(' ')).toMatch(/at least|hardened/)
  })
  it('reports unknown ids as warnings instead of throwing', () => {
    const plan = planSettings(x1c('pla'), { printer: 'nope', nozzleDiameter: 0.4, filament: 'nada' })
    expect(plan.warnings).toEqual(expect.arrayContaining(['Unknown printer "nope".', 'Unknown filament "nada".']))
    expect(plan.changes).toEqual([])
  })
  it('produces a config that validates without errors', () => {
    const next = applyPlan(base(), planSettings(x1c('pla'), x1c('abs', 0.6), base()))
    expect(validate(next).filter((i) => i.severity === 'error')).toEqual([])
  })
})

describe('knowledge table', () => {
  it('matches the filaments and printers in knowledge/', () => {
    expect(listMaterials().map((m) => m.id)).toEqual(expect.arrayContaining(['pla', 'petg', 'abs', 'tpu_95a']))
    expect(listPrinters().map((p) => p.id)).toEqual(expect.arrayContaining(['bambu_x1c', 'prusa_mk4s', 'voron_2_4']))
    expect(materialKnowledge('petg')?.nozzleTemp?.typical).toBe(245)
    expect(printerKnowledge('bambu_x1c')?.motion.maxAccel).toBe(20000)
    const root = fileURLToPath(new URL('../../../knowledge/filaments/', import.meta.url))
    const line = readFileSync(root + 'petg.yaml', 'utf8').split('\n').find((l) => l.trim().startsWith('typical:'))
    expect(line).toContain('245')
  })
})
