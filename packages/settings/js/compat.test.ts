// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { ConditionError, evaluateCondition } from './conditions'
import { filamentsForPrinter, isCompatibleWithPrint, isCompatibleWithPrinter, libraryExclusions, printerContext, type PrinterContext } from './compat'
import { loadVendorFile, type VendorFile } from './filaments'

const MK4S: PrinterContext = {
  name: 'Prusa MK4S 0.4 nozzle',
  isSystem: true,
  config: { printer_notes: 'PRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_MK4S\nHF_NOZZLE\n', nozzle_diameter: [0.4], printer_model: 'MK4S', single_extruder_multi_material: false },
}

describe('condition language', () => {
  const ev = (e: string, cfg: Record<string, unknown> = MK4S.config as Record<string, unknown>): boolean => evaluateCondition(e, cfg)
  it('matches Prusa-style conditions, regex over the whole multi-line string', () => {
    expect(ev('printer_notes=~/.*MK4S.*/ and nozzle_diameter[0]==0.4')).toBe(true)
    expect(ev('printer_notes=~/.*MK4S.*/ and nozzle_diameter[0]==0.6')).toBe(false)
    expect(ev('printer_notes=~/.*MK4S.*/ and nozzle_diameter[0]==0.4 and printer_notes!~/.*HF_NOZZLE.*/')).toBe(false)
    expect(ev('printer_notes=~/.*PRINTER_MODEL_COREONE[^_a-zA-Z0-9].*/')).toBe(false)
    expect(ev('printer_notes=~/MK4S/')).toBe(false)
  })
  it('does arithmetic, comparisons, ternary, not and strings', () => {
    expect(ev('nozzle_diameter[0] * 2 == 0.8')).toBe(true)
    expect(ev('nozzle_diameter[0] >= 0.4 and nozzle_diameter[0] < 0.5')).toBe(true)
    expect(ev('not single_extruder_multi_material')).toBe(true)
    expect(ev('!single_extruder_multi_material || false')).toBe(true)
    expect(ev('printer_model == "MK4S" ? true : false')).toBe(true)
    expect(ev('(nozzle_diameter[0] > 1 ? nozzle_diameter[0] / 0 > 1 : true)')).toBe(true)
    expect(ev('max(1, 2) == 2 and min(1.5, 2) == 1.5 and int(2.7) == 2 and round(2.5) == 3 and ceil(2.1) == 3 and floor(2.9) == 2')).toBe(true)
    expect(ev('7 % 4 == 3 and 7 / 2 == 3 and 7 / 2.0 == 3.5')).toBe(true)
    expect(ev('one_of(printer_model, "MK3", "MK4S")')).toBe(true)
    expect(ev('one_of(printer_model, /MK4.*/)')).toBe(true)
    expect(ev('one_of(printer_model, "MK3")')).toBe(false)
    expect(ev('size(nozzle_diameter) == 1 and not empty(nozzle_diameter)')).toBe(true)
  })
  it('reads the first element for an index past the end, and a float vector without an index', () => {
    expect(ev('nozzle_diameter[3] == 0.4')).toBe(true)
    expect(ev('nozzle_diameter == 0.4')).toBe(true)
  })
  it('uses schema defaults for settings the config does not set', () => {
    expect(ev('layer_height == 0.2', {})).toBe(true)
  })
  it('throws on syntax errors, unknown names, type errors and non-boolean results', () => {
    for (const bad of ['printer_notes =~', 'nozzle_diameter[0] ==', 'no_such_key == 1', '1 + 1', '"a" and true', 'not 1', '1 / 0 == 1', 'printer_model < 3 +', 'a b', '"open']) {
      expect(() => evaluateCondition(bad, {}), bad).toThrow(ConditionError)
    }
  })
})

describe('compatibility rule', () => {
  it('uses the list when there is one', () => {
    const p = { compatiblePrinters: ['A', 'B'], compatiblePrintersCondition: 'false' }
    expect(isCompatibleWithPrinter(p, { name: 'A', isSystem: true, config: {} })).toBe(true)
    expect(isCompatibleWithPrinter(p, { name: 'C', isSystem: true, config: {} })).toBe(false)
  })
  it('evaluates the condition when the list is empty, and treats an error as compatible', () => {
    expect(isCompatibleWithPrinter({ compatiblePrinters: [], compatiblePrintersCondition: 'printer_notes=~/.*MK4S.*/' }, MK4S)).toBe(true)
    expect(isCompatibleWithPrinter({ compatiblePrinters: [], compatiblePrintersCondition: 'printer_notes=~/.*MINI.*/' }, MK4S)).toBe(false)
    expect(isCompatibleWithPrinter({ compatiblePrinters: [], compatiblePrintersCondition: 'broken ((' }, MK4S)).toBe(true)
  })
  it('exposes printer_preset and num_extruders to the condition', () => {
    expect(isCompatibleWithPrinter({ compatiblePrinters: [], compatiblePrintersCondition: 'printer_preset == "Prusa MK4S 0.4 nozzle" and num_extruders == 1' }, MK4S)).toBe(true)
  })
  it('lets a user printer use what its system parent lists', () => {
    const p = { compatiblePrinters: ['Bambu Lab P1S 0.4 nozzle'] }
    expect(isCompatibleWithPrinter(p, { name: 'My P1S', inherits: 'Bambu Lab P1S 0.4 nozzle', isSystem: false, config: {} })).toBe(true)
    expect(isCompatibleWithPrinter(p, { name: 'My P1S', inherits: 'Bambu Lab P1S 0.4 nozzle', isSystem: true, config: {} })).toBe(false)
  })
  it('is compatible with everything when no printer is selected or nothing is set', () => {
    expect(isCompatibleWithPrinter({ compatiblePrinters: ['A'] }, { name: '', isSystem: true, config: {} })).toBe(true)
    expect(isCompatibleWithPrinter({ compatiblePrinters: [] }, MK4S)).toBe(true)
  })
  it('checks a process by compatible_prints and its condition', () => {
    const process = { name: '0.20mm Standard @MK4S', config: { layer_height: 0.2, enable_support: true } }
    expect(isCompatibleWithPrint({ compatiblePrinters: [], compatiblePrints: ['0.20mm Standard @MK4S'] }, process)).toBe(true)
    expect(isCompatibleWithPrint({ compatiblePrinters: [], compatiblePrints: ['other'] }, process)).toBe(false)
    expect(isCompatibleWithPrint({ compatiblePrinters: [], compatiblePrintsCondition: 'layer_height < 0.3 and enable_support' }, process)).toBe(true)
    expect(isCompatibleWithPrint({ compatiblePrinters: [], compatiblePrintsCondition: 'layer_height > 0.3' }, process)).toBe(false)
    expect(isCompatibleWithPrint({ compatiblePrinters: [] }, { name: '', config: {} })).toBe(true)
  })
  it('excludes a library preset from printers a maker preset of the product names', () => {
    const lib: VendorFile = { source: 't', commit: 't', vendor: 'OrcaFilamentLibrary', common: {}, families: { 'Generic PLA': { base: {}, variants: { '': {} } }, 'Free PLA': { base: {}, variants: { '': {} } } } }
    const maker: VendorFile = { source: 't', commit: 't', vendor: 'BBL', common: {}, families: { 'Generic PLA': { base: { compatible_printers: ['Bambu Lab P1S 0.4 nozzle'] }, variants: { 'BBL P1S': {} } } } }
    const ex = libraryExclusions([lib, maker])
    expect([...(ex.get('Generic PLA') ?? [])]).toEqual(['Bambu Lab P1S 0.4 nozzle'])
    const p1s: PrinterContext = { name: 'Bambu Lab P1S 0.4 nozzle', isSystem: true, config: {} }
    const names = filamentsForPrinter([lib, maker], p1s).map((f) => f.name)
    expect(names).toEqual(['Free PLA', 'Generic PLA @BBL P1S'])
    expect(filamentsForPrinter([lib, maker], { name: 'Other', isSystem: true, config: {} }).map((f) => f.name)).toEqual(['Free PLA', 'Generic PLA', ])
  })
})

describe('shipped data', () => {
  it('offers the P1S its Bambu presets and not the K1 ones', async () => {
    const ctx = printerContext('bambu-p1s')
    expect(ctx?.name).toBe('Bambu Lab P1S 0.4 nozzle')
    const bbl = (await loadVendorFile('BBL')) as VendorFile
    const lib = (await loadVendorFile('OrcaFilamentLibrary')) as VendorFile
    const offered = filamentsForPrinter([bbl, lib], ctx!)
    expect(offered.some((f) => f.name.startsWith('Bambu PLA Basic'))).toBe(true)
    for (const f of offered) if (f.vendor === 'BBL') expect(f.preset.compatiblePrinters.length === 0 || f.preset.compatiblePrinters.includes(ctx!.name)).toBe(true)
  })
})
