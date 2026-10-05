// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calibIdFor, needFor, plannedTests, PLAN, visibleTests } from '../src/calibration/plan'
import type { UserPreset } from '../src/presets/store'

const tuned = (key: string, nozzleMm: number): UserPreset => ({ id: key, kind: 'filament', name: key, values: {}, tuned: { key, filament: 'x', printerId: 'p', nozzleMm, results: {} }, createdAt: 0, updatedAt: 0 })
const slot = { brand: 'Acme', type: 'PLA', color: '#ff0000' }

describe('calibration plan', () => {
  it('agrees with knowledge/workflows/calibration/plan.yaml', () => {
    const yaml = readFileSync(resolve(__dirname, '../../../knowledge/workflows/calibration/plan.yaml'), 'utf8')
    const rows = [...yaml.matchAll(/\{when: "([^"]+)", run: \[([^\]]*)\](?:, optional: \[([^\]]*)\])?/g)].map((m) => ({ when: m[1]!, run: m[2]!.split(',').map((x) => x.trim()).filter(Boolean), optional: (m[3] ?? '').split(',').map((x) => x.trim()).filter(Boolean) }))
    const by = (re: RegExp) => rows.find((r) => re.test(r.when))!
    expect(PLAN['new-spool']).toMatchObject({ run: by(/New spool/).run, optional: by(/New spool/).optional })
    expect(PLAN['new-color']).toMatchObject({ run: by(/new color/).run, optional: by(/new color/).optional })
    expect(PLAN['nozzle-change']).toMatchObject({ run: by(/Nozzle size/).run })
    expect(PLAN.fast.run).toEqual(by(/faster/).run)
    expect(PLAN.moved.run).toEqual(by(/moved/).run)
    expect(PLAN.fit).toMatchObject({ run: by(/do not fit/).run, optional: by(/do not fit/).optional })
  })

  it('skips what the printer tunes itself', () => {
    expect(plannedTests('new-spool', { flavor: 'klipper' }).run).toEqual(['temperature', 'pressure_advance', 'flow_ratio'])
    expect(plannedTests('new-spool', { flavor: 'marlin', printerId: 'bambu-p1s' }).run).toEqual(['temperature', 'flow_ratio'])
    const x1 = plannedTests('new-spool', { flavor: 'marlin', printerId: 'bambu-x1-carbon' })
    expect(x1.run).toEqual(['temperature'])
    expect(x1.notes.join(' ')).toMatch(/lidar/)
    expect(plannedTests('new-color', { flavor: 'marlin', printerId: 'bambu-x1-carbon' }).run).toEqual([])
    expect(plannedTests('moved', { flavor: 'marlin', printerId: 'prusa-mk4s' }).run).toEqual([])
  })

  it('picks one pressure advance method for the printer', () => {
    expect(calibIdFor('pressure_advance', { flavor: 'klipper' })).toBe('pressure-advance')
    expect(calibIdFor('pressure_advance', { flavor: 'marlin' })).toBe('pa-pattern')
  })

  it('cuts the flat list of 14 to the tests that apply', () => {
    const klipper = visibleTests({ flavor: 'klipper' }, false)
    expect(klipper).toHaveLength(7)
    expect(klipper).not.toContain('vfa')
    expect(klipper).not.toContain('input-shaping-freq')
    const marlin = visibleTests({ flavor: 'marlin' }, false)
    expect(marlin).toContain('input-shaping-freq')
    expect(marlin).toContain('cornering-jd')
    expect(marlin.length).toBeLessThanOrEqual(10)
    expect(visibleTests({ flavor: 'marlin' }, true)).toHaveLength(14)
  })

  it('reads the need from what the filament card has', () => {
    expect(needFor([], slot, 'p', 0.4)).toBe('new-spool')
    const mine = tuned(`Acme|PLA|#ff0000@p@0.4`, 0.4)
    expect(needFor([mine], slot, 'p', 0.4)).toBeNull()
    expect(needFor([mine], slot, 'p', 0.6)).toBe('nozzle-change')
    expect(needFor([mine], { ...slot, color: '#00ff00' }, 'p', 0.4)).toBe('new-color')
    expect(needFor([mine], { ...slot, type: 'PETG' }, 'p', 0.4)).toBe('new-spool')
  })
})
