// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { K } from './knowledge'
import { mappedModels, modelsForPrinter, printerForModel, setupForModel } from './printermodels'

const catalog = fileURLToPath(new URL('../../connect/catalog/src/index.ts', import.meta.url))

describe('printer catalog lookup', () => {
  it('maps catalog model ids to knowledge printers', () => {
    expect(printerForModel('bambu-x1-carbon')).toBe('bambu_x1c')
    expect(printerForModel('voron-trident-350')).toBe('voron_trident')
    expect(printerForModel('bambu-x1')).toBeUndefined()
    expect(printerForModel('generic-klipper')).toBeUndefined()
    expect(modelsForPrinter('voron_2_4')).toEqual(['voron-2.4-250', 'voron-2.4-300', 'voron-2.4-350'])
  })
  it('points every entry at a knowledge printer', () => {
    for (const m of mappedModels()) expect(printerForModel(m), m).toBeDefined()
  })
  it('builds a setup with the stock nozzle unless one is given', () => {
    expect(setupForModel('prusa-mk4s', 'pla')).toEqual({ printer: 'prusa_mk4s', nozzleDiameter: K.printers['prusa_mk4s']?.hotend.stockNozzle?.diameter ?? 0.4, filament: 'pla' })
    expect(setupForModel('prusa-mk4s', 'pla', 0.6)?.nozzleDiameter).toBe(0.6)
    expect(setupForModel('generic-klipper', 'pla')).toBeUndefined()
  })
  it('names only models the printer catalog has, when the catalog is present', async () => {
    if (!existsSync(catalog)) return
    const { modelById } = (await import(/* @vite-ignore */ catalog)) as { modelById: (id: string) => unknown }
    for (const m of mappedModels()) expect(modelById(m), m).toBeDefined()
  })
})
