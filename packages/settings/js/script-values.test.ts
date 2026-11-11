// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The values the Bambu Lab H3C's stock G-code reads that are not settings: each slot's preset id (`filament_ids`) and
// its fin extrusion safe temperature (`fins_extrude_safe_temp`), from the filament's preset, else its material's generic
// preset for the printer, else 0. A filament with no value anywhere still slices.
import { describe, expect, it } from 'vitest'
import { loadVendorFile, resolveFilamentPreset } from './filaments'
import { chainValue, finsSafeTemp, scriptKeysRead } from './script-values'
import { stockLayer, stockPrinter } from './stock-layer'

const h3cPreset = async (family: string) => {
  const file = (await loadVendorFile('BBL'))!
  return resolveFilamentPreset(file, family, 'BBL H3C')!
}

describe('fins_extrude_safe_temp', () => {
  it("gives a stock preset that sets it its own value", async () => {
    const pla = await h3cPreset('Bambu PLA Basic')
    expect(pla.extras['fins_extrude_safe_temp']).toEqual(['57'])
    expect(finsSafeTemp([pla.extras], undefined)).toBe(57)
  })

  it("gives a user preset that inherits a stock preset the parent's value, and its own over it", async () => {
    const parent = (await h3cPreset('Bambu PLA Basic')).extras
    const child = { name: 'My PLA', inherits: 'Bambu PLA Basic @BBL H3C', nozzle_temperature: ['215'] }
    expect(chainValue([child, parent], 'fins_extrude_safe_temp')).toEqual(['57'])
    expect(finsSafeTemp([child, parent], undefined)).toBe(57)
    expect(finsSafeTemp([{ ...child, fins_extrude_safe_temp: ['60'] }, parent], undefined)).toBe(60)
  })

  it('gives a PLA without its own value the generic PLA value for the printer', async () => {
    const silk = await h3cPreset('Generic PLA Silk')
    expect(silk.extras['fins_extrude_safe_temp']).toBeUndefined()
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots: [{ type: 'PLA', vendor: 'BBL', family: 'Generic PLA Silk' }] })
    expect(layer!.values['fins_extrude_safe_temp']).toEqual([57])
  })

  it('gives a PETG without a value, which has no generic value either, 0', async () => {
    const petg = await h3cPreset('Generic PETG')
    expect(petg.extras['fins_extrude_safe_temp']).toBeUndefined()
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots: [{ type: 'PETG', vendor: 'BBL', family: 'Generic PETG' }] })
    expect(layer!.values['fins_extrude_safe_temp']).toEqual([0])
  })

  it('gives a filament made from scratch, with no preset, 0', async () => {
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots: [{ type: 'PLA' }, { type: 'NOSUCH' }] })
    expect(layer!.values['fins_extrude_safe_temp']).toEqual([57, 0])
    expect(layer!.values['filament_ids']).toEqual(['GFA00', ''])
  })
})

describe('the H3C printer layer', () => {
  it("adds each slot's preset id and fin temperature, the TPU's 0 among them", async () => {
    const layer = await stockLayer({ printerId: 'bambu-h3c', tier: 'standard', slots: [{ type: 'PLA' }, { type: 'TPU', vendor: 'BBL', family: 'Bambu TPU 75A(2.85mm)' }] })
    expect(layer!.values['filament_ids']).toEqual(['GFA00', 'GFU06'])
    expect(layer!.values['fins_extrude_safe_temp']).toEqual([57, 0])
  })

  it('gives the default filament the same, for a slice through the server', async () => {
    const p = await stockPrinter('bambu-h3c')
    expect(p!.filament['filament_ids']).toEqual(['GFA00'])
    expect(p!.filament['fins_extrude_safe_temp']).toEqual([57])
  })

  it('adds neither to a printer whose G-code does not read them', async () => {
    const layer = await stockLayer({ printerId: 'bambu-h2d', tier: 'standard', slots: [{ type: 'PLA' }] })
    expect(layer!.values['filament_ids']).toBeUndefined()
    expect(layer!.values['fins_extrude_safe_temp']).toBeUndefined()
    expect([...scriptKeysRead({ start: 'M104 S{fins_extrude_safe_temp[0]}', end: '{filament_ids[0]}' })].sort()).toEqual(['filament_ids', 'fins_extrude_safe_temp'])
  })
})
