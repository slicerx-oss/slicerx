// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project opened on its own printer takes the file's printer settings, but never a machine limit above the printer's:
// the file may lower an acceleration, speed or jerk limit, in normal and silent mode alike, and a limit at or below 0
// takes the printer's own.
import { describe, expect, it } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts/settings'
import { clampMachineLimits, projectPrinterChanges } from './project-open'
import { defaultConfig } from './schema'

const PROFILE = {
  machine_max_acceleration_x: [20000, 10000],
  machine_max_speed_x: [500, 200],
  machine_max_jerk_x: [9, 9],
  machine_max_junction_deviation: [0.02],
}
const current = { ...defaultConfig(), ...PROFILE } as unknown as PrintConfig
const MATCH = { kind: 'match' as const, profileId: 'bambu-p1s', vendor: 'Bambu Lab', model: 'P1S', nozzle: 0.4, name: 'Bambu Lab P1S 0.4 nozzle' }
const opened = (limits: Record<string, unknown>) => projectPrinterChanges({ nozzle_diameter: ['0.4'], layer_height: '0.2', ...limits }, MATCH, current, 0.4).values

describe("a project's machine limits on its own printer", () => {
  it("hold one above the printer's to the printer's", () => {
    expect(opened({ machine_max_acceleration_x: ['30000', '30000'] })['machine_max_acceleration_x']).toEqual([20000, 10000])
  })

  it('keep one below it', () => {
    expect(opened({ machine_max_acceleration_x: ['5000', '4000'] })['machine_max_acceleration_x']).toEqual([5000, 4000])
  })

  it('hold the silent mode entry on its own', () => {
    expect(opened({ machine_max_speed_x: ['300', '500'] })['machine_max_speed_x']).toEqual([300, 200])
  })

  it("give an entry at or below 0 the printer's", () => {
    expect(opened({ machine_max_jerk_x: ['0', '4'] })['machine_max_jerk_x']).toEqual([9, 4])
    expect(opened({ machine_max_junction_deviation: ['0'] })['machine_max_junction_deviation']).toEqual([0.02])
  })

  it("list them among the file's printer settings", () => {
    const { printerKeys } = projectPrinterChanges({ nozzle_diameter: ['0.4'], machine_max_speed_x: ['900', '900'] }, MATCH, current, 0.4)
    expect(printerKeys).toContain('machine_max_speed_x')
  })
})

describe("a project's machine limits on every route of the open", () => {
  const RAISED = ['30000', '30000']
  const LOWER = ['5000', '4000']
  const listed = (v: string[]) => ({ nozzle_diameter: ['0.4'], machine_max_acceleration_x: v, different_settings_to_system: ['machine_max_acceleration_x', '', ''] })
  const unlisted = (v: string[]) => ({ nozzle_diameter: ['0.4'], machine_max_acceleration_x: v })
  const accel = (file: Record<string, unknown>, match: Parameters<typeof projectPrinterChanges>[1], cfg: PrintConfig = current, profile?: PrintConfig) =>
    projectPrinterChanges(file, match, cfg, 0.4, profile).values['machine_max_acceleration_x']

  it('on its own printer, listed as changed: held above the profile, kept below', () => {
    expect(accel(listed(RAISED), MATCH)).toEqual([20000, 10000])
    expect(accel(listed(LOWER), MATCH)).toEqual([5000, 4000])
  })

  it('on its own printer, from a file with no list of changes: held above the profile, kept below', () => {
    expect(accel(unlisted(RAISED), MATCH)).toEqual([20000, 10000])
    expect(accel(unlisted(LOWER), MATCH)).toEqual([5000, 4000])
  })

  // These routes take no printer settings from the file at all, so the printer's own limit stands either way.
  for (const [route, match] of [
    ['a printer with no profile', { kind: 'unknown' as const, name: 'Workshop Printer', nozzle: 0.4 }],
    ['no printer named', null],
    ['a nozzle the profile has no variant for', { ...MATCH, asked: 0.6 }],
  ] as const) {
    it(`on ${route}: the printer's own, listed or not`, () => {
      for (const file of [listed(RAISED), unlisted(RAISED), listed(LOWER)]) expect(accel(file, match)).toBeUndefined()
    })
  }

  it("holds them to the printer's profile, not to a higher limit the plate's own settings carry", () => {
    const raisedByHand = { ...current, machine_max_acceleration_x: [40000, 40000] } as unknown as PrintConfig
    expect(accel(listed(RAISED), MATCH, raisedByHand, current)).toEqual([20000, 10000])
    expect(accel(unlisted(RAISED), MATCH, raisedByHand, current)).toEqual([20000, 10000])
  })
})

describe('clampMachineLimits', () => {
  it("holds every entry to the profile's, and an entry past the profile's list to its lowest", () => {
    expect(clampMachineLimits({ machine_max_acceleration_x: [30000, 30000, 30000] }, PROFILE)).toEqual({ machine_max_acceleration_x: [20000, 10000, 10000] })
  })

  it("gives a negative, missing or non-number entry the profile's", () => {
    expect(clampMachineLimits({ machine_max_speed_x: [-5, Number.NaN] }, PROFILE)).toEqual({ machine_max_speed_x: [500, 200] })
    expect(clampMachineLimits({ machine_max_speed_x: [Number.POSITIVE_INFINITY, 'x'] as never }, PROFILE)).toEqual({ machine_max_speed_x: [500, 200] })
  })

  it('holds a single value', () => {
    expect(clampMachineLimits({ machine_max_force_Y: 900 }, { machine_max_force_Y: 400 })).toEqual({ machine_max_force_Y: 400 })
    expect(clampMachineLimits({ machine_max_force_Y: 300 }, { machine_max_force_Y: 400 })).toEqual({ machine_max_force_Y: 300 })
  })

  it('leaves out a limit the profile has no number for, and every other setting as it is', () => {
    expect(clampMachineLimits({ machine_max_speed_z: [40], fan_direction: 'left', max_layer_height: [0.32] }, PROFILE)).toEqual({ fan_direction: 'left', max_layer_height: [0.32] })
  })
})
