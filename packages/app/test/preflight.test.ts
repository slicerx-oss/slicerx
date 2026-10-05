// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { catalogModel, preflight, type PreflightInput } from '../src/plate/preflight'

const printer: PrinterInfo = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', host: '192.0.2.12', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bay-2', state: 'idle', nozzles: [{ current: 25, target: 0 }], slots: [{ id: 'A1', material: 'PLA Basic' }], cameraAvailable: false, updatedAt: '' }

function input(patch: Partial<PreflightInput> = {}): PreflightInput {
  return {
    printer,
    status: idle,
    config: { nozzle_diameter: [0.4], gcode_flavor: 'marlin', filament_type: ['PLA'], nozzle_temperature: [220], hot_plate_temp: [55] },
    plateBounds: { min: [100, 100, 0], max: [150, 150, 40] },
    plateBed: { widthMm: 256, depthMm: 256, heightMm: 256 },
    file: { name: 'x.gcode', sha256: 'ab'.repeat(32), layers: 200, timeS: 5400, grams: 12.5 },
    ...patch,
  }
}

describe('preflight', () => {
  it('passes a matching file and lists the facts with the hash', () => {
    const r = preflight(input())
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.facts[0]).toContain('SHA-256 abababababababab')
    expect(r.facts.join(' ')).toContain('1h 30m')
    expect(r.facts.join(' ')).toContain('nozzle 220 °C, bed 55 °C, PLA')
  })

  it('finds the printer in the catalog by brand and model', () => {
    expect(catalogModel(printer)?.id).toBe('bambu-p1s')
    expect(catalogModel({ vendor: 'Prusa Research', model: 'MK4S' })?.id).toBe('prusa-mk4s')
    expect(catalogModel({ vendor: 'Nobody', model: 'Zeta' })).toBeUndefined()
  })

  it('blocks a busy printer, a plate past the bed or too tall, and the wrong firmware', () => {
    expect(preflight(input({ status: { ...idle, state: 'printing' } })).errors[0]).toMatch(/busy/)
    expect(preflight(input({ plateBounds: { min: [200, 10, 0], max: [300, 60, 20] } })).errors[0]).toMatch(/past the 256 x 256 mm bed/)
    expect(preflight(input({ plateBounds: { min: [10, 10, 0], max: [60, 60, 300] } })).errors[0]).toMatch(/300.0 mm tall/)
    expect(preflight(input({ config: { gcode_flavor: 'klipper' } })).errors[0]).toMatch(/klipper firmware/)
  })

  it('warns about material and nozzle, and states an unknown bed as a fact', () => {
    const r = preflight(input({ config: { filament_type: ['PETG'], nozzle_diameter: [0.5], gcode_flavor: 'marlin' } }))
    expect(r.warnings.join(' ')).toMatch(/Sliced for PETG; Bay 2 has PLA Basic loaded/)
    expect(r.warnings.join(' ')).toMatch(/0.5 mm nozzle/)
    const unknown = preflight(input({ printer: { ...printer, vendor: 'Nobody', model: 'Zeta' } }))
    expect(unknown.warnings).toEqual([])
    expect(unknown.facts.join(' ')).toMatch(/does not know the bed size/)
  })

  it('checks the nozzle the printer reports before the sizes the model is sold with', () => {
    const fitted = (mm: number, sliced: number) => preflight(input({ status: { ...idle, nozzleDiameterMm: mm }, config: { nozzle_diameter: [sliced], gcode_flavor: 'marlin', filament_type: ['PLA'] } })).warnings
    expect(fitted(0.4, 0.4)).toEqual([])
    expect(fitted(0.6, 0.4)).toEqual(['Sliced for a 0.4 mm nozzle; Bay 2 has a 0.6 mm nozzle fitted. Pick the 0.6 mm nozzle and slice again.'])
    // A fitted size the catalog does not list is still what is on the printer.
    expect(fitted(0.5, 0.5)).toEqual([])
  })

  it('says an error state once', () => {
    const r = preflight(input({ status: { ...idle, state: 'error', message: 'Nozzle clog' } }))
    expect(r.errors).toEqual(['Bay 2 reports an error: Nozzle clog. Clear it on the printer first.'])
  })
})
