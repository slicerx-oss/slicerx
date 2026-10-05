// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plan build order (profile, filament defaults, calibration, intent, clamps, diff) and the
// worked example requests in knowledge/intents/requests.yaml.
import { describe, expect, it } from 'vitest'
import type { CalibrationResult, PlanIntent, PrintConfig, SettingsPlan, SetupRef } from '@slicerx/contracts/settings'
import { mergeConfigs } from './import'
import { applyPlan, planSettings } from './plan'
import { loadProfile } from './testkit'

const setup = (printer: string, filament: string, nozzleDiameter = 0.4, extra: Partial<SetupRef> = {}): SetupRef => ({ printer, filament, nozzleDiameter, ...extra })
const x1cBase = (): PrintConfig =>
  mergeConfigs(
    loadProfile('demo', 'Demo Printer 0.4 nozzle').config,
    loadProfile('demo', 'Demo PLA').config,
    loadProfile('demo', '0.20mm Standard @Demo').config,
  )
const goals = (...g: [string, string?][]): PlanIntent => ({ goals: g.map(([id, level]) => ({ id, ...(level ? { level } : {}) })) })
const get = (p: SettingsPlan, k: string) => p.changes.find((c) => c.key === k)
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v)
const value = (p: SettingsPlan, k: string) => first(get(p, k)?.after)
const pla = setup('bambu_x1c', 'pla')

describe('build order', () => {
  it('starts from the target profile and lets filament defaults override keys the profile did not tune', () => {
    const target = mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', 'Demo PETG').config)
    const plan = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { target })
    expect(get(plan, 'nozzle_temperature')).toMatchObject({ after: [245, 245], origin: 'filament' })
    expect(get(plan, 'filament_max_volumetric_speed')?.after).toEqual([12, 12])
    // The HF profile is tuned for this printer: with the key marked tuned, its own values stand.
    const tuned = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { target, tuned: new Set(['filament_max_volumetric_speed']) })
    expect(get(tuned, 'filament_max_volumetric_speed')).toBeUndefined() // the profile's [21, 29] already matches the plate
    expect(get(tuned, 'fan_max_speed')?.after).toEqual([40])
  })

  it('uses the printer baseline process when there is no target profile', () => {
    const plan = planSettings(setup('bambu_x1c', 'pla'), setup('prusa_mk4s', 'pla'), x1cBase())
    expect(get(plan, 'outer_wall_speed')).toMatchObject({ origin: 'printer', klass: 'edit' })
    expect(get(plan, 'outer_wall_speed')?.reason).toContain('default process')
  })

  it('leaves plate overrides in keep alone unless a goal or calibration asks', () => {
    const keep = new Set(['outer_wall_speed', 'wall_loops'])
    const plan = planSettings(setup('bambu_x1c', 'pla'), setup('prusa_mk4s', 'pla'), x1cBase(), { keep, intent: goals(['strength']) })
    expect(get(plan, 'outer_wall_speed')).toBeUndefined()
    expect(get(plan, 'wall_loops')).toMatchObject({ after: 4, origin: 'intent' })
  })

  it('applies stored calibration results for this spool, printer and nozzle', () => {
    const cal: CalibrationResult[] = [
      { id: 'pressure_advance', values: { value: 0.045 }, printer: 'prusa_mk4s', filament: 'petg', nozzleDiameter: 0.4 },
      { id: 'max_volumetric_speed', values: { measured_mm3s: 14 }, printer: 'prusa_mk4s', filament: 'petg' },
      { id: 'flow_ratio', values: { value: 0.93 }, printer: 'bambu_x1c' },
    ]
    const plan = planSettings(pla, setup('prusa_mk4s', 'petg'), x1cBase(), { calibrations: cal })
    expect(get(plan, 'pressure_advance')).toMatchObject({ after: [0.045], origin: 'calibration' })
    expect(get(plan, 'pressure_advance')?.reason).toContain('Stored pressure advance result')
    expect(value(plan, 'filament_max_volumetric_speed')).toBeCloseTo(11.9, 5)
    expect(get(plan, 'enable_pressure_advance')).toMatchObject({ origin: 'calibration' })
    expect(get(plan, 'filament_flow_ratio')?.origin).not.toBe('calibration')
  })

  it('lets a goal beat the calibration on a shared key, and calibration beat filament defaults', () => {
    const cal: CalibrationResult[] = [{ id: 'temperature', values: { best_c: 240 } }]
    const plan = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { calibrations: cal })
    expect(get(plan, 'nozzle_temperature')).toMatchObject({ after: [240, 240], origin: 'calibration' })
    const withGoal = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { calibrations: cal, intent: goals(['strength']) })
    expect(get(withGoal, 'nozzle_temperature')).toMatchObject({ after: [255, 255], origin: 'intent', goal: 'strength' })
  })

  it('records a clamp for each value moved to fit a range', () => {
    const plan = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { calibrations: [{ id: 'retraction', values: { length_mm: 99 } }] })
    // retraction_length has catalog bounds; 9 mm is far past the maximum
    const clamp = plan.clamps.find((c) => c.key === 'retraction_length')
    expect(clamp).toBeDefined()
    expect(clamp?.by).toBeOneOf(['bounds', 'filament'])
    expect(get(plan, 'retraction_length')?.after).not.toEqual([99])
  })

  it('asks for approval on a guarded key outside the filament range', () => {
    const plan = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { calibrations: [{ id: 'temperature', values: { best_c: 275 } }] })
    const t = get(plan, 'nozzle_temperature')
    expect(t).toMatchObject({ klass: 'guarded', approval: 'ask', after: [275, 275] })
    expect(t?.reason).toContain('needs approval')
    const inside = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { calibrations: [{ id: 'temperature', values: { best_c: 250 } }] })
    expect(get(inside, 'nozzle_temperature')?.approval).toBe('none')
  })

  it('refuses a guarded value past the printer limit and records why', () => {
    const plan = planSettings(pla, setup('prusa_mk4s', 'pa_cf', 0.4, { nozzleMaterial: 'hardened_steel' }), undefined, { calibrations: [{ id: 'temperature', values: { best_c: 305 } }] })
    expect(plan.refused.find((r) => r.key === 'nozzle_temperature')?.reason).toContain('past the Original Prusa MK4S limit')
    expect(get(plan, 'nozzle_temperature')?.after).not.toEqual([305])
  })

  it('clamps an edit key to the printer limit', () => {
    const plan = planSettings(pla, setup('prusa_mk4s', 'pla'), x1cBase(), { calibrations: [] })
    for (const c of plan.changes) if (c.unit === 'mm/s2') expect(Math.max(...(([] as number[]).concat(c.after as number[])))).toBeLessThanOrEqual(4000)
  })

  it('shows read keys but does not apply them', () => {
    const plan = planSettings(pla, setup('prusa_mk4s', 'pla'), x1cBase())
    const readKeys = plan.changes.filter((c) => c.klass === 'read')
    expect(readKeys.length).toBeGreaterThan(0)
    const next = applyPlan(x1cBase(), plan)
    for (const c of readKeys) expect(next[c.key]).toEqual(x1cBase()[c.key])
    const all = applyPlan(x1cBase(), plan, { includeRead: true })
    expect(all[readKeys[0]?.key as string]).toEqual(readKeys[0]?.after)
  })

  it('stays inside the time budget, warm', () => {
    const b = x1cBase()
    planSettings(pla, setup('bambu_x1c', 'petg'), b, { intent: goals(['strength'], ['speed']) })
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) planSettings(pla, setup('bambu_x1c', 'petg'), b, { intent: goals(['strength'], ['speed']), target: b })
    expect((performance.now() - t0) / 20).toBeLessThan(10)
  })
})

describe('the worked example requests', () => {
  it('12 functional PETG brackets, strong, by tomorrow: strength and speed', () => {
    const plan = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { intent: goals(['strength'], ['speed']) })
    expect(get(plan, 'wall_loops')).toMatchObject({ after: 4, goal: 'strength', priority: 'core' })
    expect(value(plan, 'sparse_infill_density')).toBe(25)
    expect(get(plan, 'layer_height')).toMatchObject({ after: 0.24, goal: 'speed' })
    expect(value(plan, 'nozzle_temperature')).toBeGreaterThanOrEqual(240)
    expect(value(plan, 'nozzle_temperature')).toBeLessThanOrEqual(260)
    expect(value(plan, 'fan_max_speed')).toBeLessThanOrEqual(50)
    expect(plan.tellUser).toContain('Kept four walls for strength and used thicker layers to save time.')
    expect(plan.advice.some((a) => a.kind === 'orientation')).toBe(true)
  })

  it('silky vase in silk PLA: vase mode wins over wall count and skips seam settings', () => {
    const plan = planSettings(pla, setup('bambu_x1c', 'pla_silk'), x1cBase(), { intent: goals(['vase'], ['surface_finish']) })
    expect(value(plan, 'spiral_mode')).toBe(true)
    expect(value(plan, 'wall_loops')).toBe(1)
    expect(value(plan, 'sparse_infill_density')).toBe(0)
    expect(value(plan, 'top_shell_layers')).toBe(0)
    expect(value(plan, 'outer_wall_line_width')).toBe(0.6)
    expect(value(plan, 'layer_height')).toBe(0.16)
    for (const k of ['wall_sequence', 'seam_slope_type', 'seam_position', 'only_one_wall_top']) expect(get(plan, k), k).toBeUndefined()
    expect(plan.tellUser.join(' ')).toContain('do not apply in vase mode')
    expect(plan.tellUser.join(' ')).toContain('Spiral vase takes priority')
  })

  it('flexible phone case in TPU 95A: soft settings, external spool question, drying', () => {
    const plan = planSettings(pla, setup('bambu_x1c', 'tpu_95a'), x1cBase(), { intent: goals(['flexibility']) })
    expect(value(plan, 'sparse_infill_pattern')).toBe('gyroid')
    expect(value(plan, 'sparse_infill_density') ?? 15).toBeLessThanOrEqual(15)
    expect(value(plan, 'filament_max_volumetric_speed')).toBeLessThanOrEqual(3.6)
    expect(value(plan, 'retraction_length')).toBeLessThanOrEqual(0.4)
    expect(plan.questions.join(' ')).toContain('external spool')
    expect(plan.warnings.join(' ')).toContain('Dry TPU')
  })

  it('outdoor part in ASA on an open frame printer: warns about the enclosure', () => {
    const plan = planSettings(pla, setup('prusa_mk4s', 'asa'), x1cBase(), { intent: goals(['uv_resistance'], ['strength']) })
    expect(plan.warnings.join(' ')).toContain('needs an enclosure')
    expect(get(plan, 'wall_loops')).toMatchObject({ after: 4 })
    expect(value(plan, 'fan_max_speed')).toBeLessThanOrEqual(40)
  })

  it('fast draft: thick layers, two walls, lightning at 10 percent, and a plain word about strength', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['speed', 'draft']) })
    expect(get(plan, 'layer_height')).toMatchObject({ after: 0.28 })
    expect(value(plan, 'wall_loops') ?? 2).toBeLessThanOrEqual(2)
    expect(value(plan, 'sparse_infill_pattern')).toBe('lightning')
    expect(value(plan, 'sparse_infill_density')).toBe(10)
    expect(value(plan, 'support_threshold_angle')).toBe(40)
    expect(plan.tellUser.join(' ')).toContain('Lightning infill has no strength')
  })

  it('miniature at max detail: thin layers, slow outer wall, Arachne, and the 0.2 mm nozzle question', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['detail']) })
    expect(value(plan, 'layer_height')).toBe(0.08)
    expect(value(plan, 'outer_wall_speed')).toBeLessThanOrEqual(60)
    expect(value(plan, 'wall_generator')).toBe('arachne')
    expect(plan.questions.join(' ')).toContain('0.2 mm nozzle')
    const small = planSettings(pla, setup('bambu_x1c', 'pla', 0.2), x1cBase(), { intent: goals(['detail']) })
    expect(small.questions.join(' ')).not.toContain('0.2 mm nozzle')
  })

  it('watertight container with PLA loaded: dense walls, more flow with approval, and a PETG suggestion', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['watertight']) })
    expect(get(plan, 'wall_loops')).toMatchObject({ after: 4 })
    expect(value(plan, 'bottom_shell_layers')).toBe(5)
    expect(value(plan, 'infill_wall_overlap')).toBe(25)
    expect(value(plan, 'seam_slope_type')).toBe('all')
    expect(value(plan, 'nozzle_temperature')).toBe(225)
    expect(get(plan, 'filament_flow_ratio')).toMatchObject({ klass: 'guarded', approval: 'ask' })
    expect(plan.advice.some((a) => a.kind === 'material' && a.text.includes('PETG'))).toBe(true)
  })

  it('food contact implies watertight and always carries the caveats', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['food_contact']) })
    expect(plan.caveats.length).toBeGreaterThanOrEqual(4)
    expect(plan.caveats.some((c) => c.text.includes('lead'))).toBe(true)
    expect(get(plan, 'bottom_shell_layers')).toMatchObject({ after: 5, goal: 'watertight' })
  })

  it('carbon fiber nylon gear: refuses a soft nozzle, plans on a hardened one', () => {
    const blocked = planSettings(pla, setup('bambu_p1s', 'pa_cf'), x1cBase(), { intent: goals(['strength', 'max'], ['dimensional_accuracy']) })
    expect(blocked.blockers.join(' ')).toContain('abrasive')
    expect(blocked.changes).toEqual([])
    expect(blocked.questions.join(' ')).toContain('hardened steel')
    const ok = planSettings(pla, setup('bambu_x1c', 'pa_cf'), x1cBase(), { intent: goals(['strength', 'max'], ['dimensional_accuracy']) })
    expect(ok.blockers).toEqual([])
    expect(get(ok, 'wall_loops')).toMatchObject({ after: 6 })
    expect(value(ok, 'precise_outer_wall')).toBe(true)
    expect(value(ok, 'wall_sequence')).toBe('inner-outer-inner wall')
    expect(value(ok, 'fan_max_speed')).toBeLessThanOrEqual(30)
    expect(ok.questions.join(' ')).toContain('dried')
    const fitted = planSettings(pla, setup('bambu_x1c', 'pa_cf', 0.4, { nozzleMaterial: 'brass' }), x1cBase(), { intent: goals(['strength']) })
    expect(fitted.blockers.join(' ')).toContain('brass nozzle')
  })
})

describe('goal conflicts', () => {
  it('strength and flexibility ask which matters; strength and vase ask too', () => {
    expect(planSettings(pla, setup('bambu_x1c', 'tpu_95a'), x1cBase(), { intent: goals(['strength'], ['flexibility']) }).questions.join(' ')).toContain('bend and spring back')
    expect(planSettings(pla, pla, x1cBase(), { intent: goals(['strength'], ['vase']) }).questions.join(' ')).toContain('seamless look')
  })
  it('drops lightning infill on a part that carries load', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['strength'], ['speed', 'draft']) })
    expect(get(plan, 'sparse_infill_pattern')?.after).not.toBe('lightning')
    expect(plan.tellUser.join(' ')).toContain('Lightning infill was dropped')
  })
  it('takes the middle layer height for smooth surface with speed', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['surface_finish'], ['speed']) })
    expect(value(plan, 'layer_height')).toBe(0.16)
    expect(get(plan, 'outer_wall_speed')).toMatchObject({ goal: 'surface_finish' })
  })
  it('reports unknown goals and levels without failing', () => {
    const plan = planSettings(pla, pla, x1cBase(), { intent: goals(['nonsense'], ['strength', 'ultra']) })
    expect(plan.warnings.join(' ')).toContain('Unknown goal "nonsense"')
    expect(plan.warnings.join(' ')).toContain('has no level "ultra"')
    expect(get(plan, 'wall_loops')).toMatchObject({ after: 4 })
  })
  it('does nothing extra for an empty intent', () => {
    const a = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase())
    const b = planSettings(pla, setup('bambu_x1c', 'petg'), x1cBase(), { intent: { goals: [] } })
    expect(b.changes).toEqual(a.changes)
  })
})
