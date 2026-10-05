// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { evalKb } from '../evals/harness'
import { parseIntent } from '../src/intent'
import { createKbPlanner } from '../src/kb/planner'

const kb = evalKb()

describe('knowledge base', () => {
  it('resolves ids, names and aliases', () => {
    expect(kb.get('filament', 'PET-G')?.id).toBe('petg')
    expect(kb.get('filament', 'petg')?.name).toBe('PETG')
    expect(kb.search('layer shift belt skipped', { kinds: ['troubleshoot'] })[0]?.doc.id).toBe('layer_shift')
  })

  it('expands prefixed source paths into URLs', () => {
    const c = kb.cite(['orca:OrcaFilamentLibrary/filament/Generic PETG @System.json'])
    expect(c[0]?.url).toMatch(/^https:\/\/github\.com\/SoftFever\/OrcaSlicer\/blob\/[0-9a-f]{40}\/resources\/profiles\/OrcaFilamentLibrary\/filament\/Generic%20PETG%20%40System\.json$/)
  })
})

describe('intent parsing', () => {
  it('turns "12 strong PETG brackets by Friday" into goals and targets', () => {
    const r = parseIntent('Print 12 strong PETG brackets by Friday', kb, '2026-09-30')
    expect(r).toMatchObject({ count: 12, part: 'brackets', material: 'petg', deadline: { date: '2026-10-02', days: 2 } })
    expect(r.goals.map((g) => g.id)).toContain('strength')
    const t = Object.fromEntries(r.targets.map((x) => [x.key, x]))
    expect(t['wall_loops']).toMatchObject({ op: 'at_least' })
    expect(Number(t['wall_loops']?.value)).toBeGreaterThanOrEqual(4)
    expect(Number(t['nozzle_temperature']?.value)).toBeGreaterThanOrEqual(240)
    expect(r.sources.length).toBeGreaterThan(0)
  })

  it('merges strength and speed with the tradeoff rules', () => {
    const r = parseIntent('strong brackets in PETG as fast as possible', kb, '2026-09-30')
    const t = Object.fromEntries(r.targets.map((x) => [x.key, x]))
    expect(t['wall_loops']?.goal).toBe('strength')
    expect(t['layer_height']?.goal).toBe('speed')
  })
})

describe('settings planner', () => {
  const planner = createKbPlanner(kb)

  it('recomputes PLA to PETG with reasons and sources, inside the 50 ms budget', () => {
    const t0 = performance.now()
    const r = planner.plan({ printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }, { printer: 'prusa_mk4s', material: 'petg', nozzle: 0.4 })
    expect(performance.now() - t0).toBeLessThan(50)
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]))
    expect(byKey['nozzle_temperature']).toMatchObject({ before: 220, after: 245 })
    expect(byKey['nozzle_temperature']?.reason).toMatch(/PETG/)
    expect(byKey['nozzle_temperature']?.sources.length).toBeGreaterThan(0)
    expect(r.changes.every((c) => c.reason.length > 0)).toBe(true)
  })

  it('warns about abrasive filament on a brass nozzle', () => {
    const r = planner.plan({ printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }, { printer: 'prusa_mk4s', material: 'pa_cf', nozzle: 0.4 })
    expect(r.warnings.join(' ')).toMatch(/hardened/i)
  })

  it('scales geometry and caps speed by melt rate on a nozzle change', () => {
    const r = planner.plan({ printer: 'prusa_mk4s', material: 'petg', nozzle: 0.4 }, { printer: 'prusa_mk4s', material: 'petg', nozzle: 0.6 })
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]))
    expect(byKey['layer_height']?.after).toBe(0.3)
    expect(Number(byKey['outer_wall_speed']?.after)).toBeLessThanOrEqual(12 / (0.3 * 0.63) + 1)
  })
})

describe('combined planner', () => {
  it('uses the settings package for materials and fills nozzle geometry from the knowledge planner', async () => {
    const { createCombinedPlanner } = await import('../src/kb/combined-planner')
    const p = createCombinedPlanner(kb)
    const petg = Object.fromEntries(p.plan({ printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }, { printer: 'prusa_mk4s', material: 'petg', nozzle: 0.4 }).changes.map((c) => [c.key, c.after]))
    expect(petg['nozzle_temperature']).toBe(245)
    const big = Object.fromEntries(p.plan({ printer: 'prusa_mk4s', material: 'petg', nozzle: 0.4 }, { printer: 'Prusa MK4S', material: 'PETG', nozzle: 0.6 }).changes.map((c) => [c.key, c.after]))
    expect(big['layer_height']).toBe(0.3)
  })
})
