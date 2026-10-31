// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The stock layer reads the schema default of one key at a time. defaultConfig() copies the whole defaults table, and
// tierProcess read a layer height from it for each tier, which was most of what preparing a slice's printers cost.
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ defaultConfig: 0 }))
vi.mock('./defaults', async (importOriginal) => {
  const real = await importOriginal<typeof import('./defaults')>()
  return {
    ...real,
    defaultConfig: (...args: Parameters<typeof real.defaultConfig>) => {
      calls.defaultConfig++
      return real.defaultConfig(...args)
    },
  }
})

import { defaultConfig, settingDefault } from './defaults'
import { stockLayer, stockPrinter, stockProcess } from './stock-layer'

describe('stock layer defaults', () => {
  it('reads the same default values as the whole table gives', () => {
    for (const key of ['layer_height', 'wall_loops']) expect(settingDefault(key), key).toEqual(defaultConfig()[key])
  })

  it('builds tiers, printers and layers without copying the defaults table', async () => {
    calls.defaultConfig = 0
    for (const printer of ['bambu-a1', 'prusa-mk4', 'snapmaker-u1']) {
      for (const tier of ['draft', 'standard', 'fine', 'strong'] as const) await stockProcess(printer, tier, 0.4)
      await stockPrinter(printer)
      const layer = await stockLayer({ printerId: printer, tier: 'standard', slots: [] })
      expect(layer?.goalValues.standard['layer_height'], printer).toBeDefined()
    }
    expect(calls.defaultConfig).toBe(0)
  })
})
