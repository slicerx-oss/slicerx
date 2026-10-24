// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer data the profiles are built from agrees with itself: a knowledge printer the catalog has a model of is
// mapped to it, and its bed is that model's.
import { describe, expect, it } from 'vitest'
import { K } from './knowledge'
import { listPrinterProfiles, printerProfile } from './profiles'
import { mappedModels, printerForModel } from './printermodels'

/** A bed's footprint, mm: x and y, or the diameter twice for a round one. */
function footprint(v: { shape?: string; round?: boolean; x?: number; y?: number; diameter?: number }): [number, number] {
  return v.shape === 'circular' || v.round ? [v.diameter!, v.diameter!] : [v.x!, v.y!]
}

describe('the printer model table', () => {
  it('maps every catalog model a knowledge printer is named after', () => {
    const named = listPrinterProfiles().filter((p) => Object.values(K.printers).some((k) => k.name === `${p.vendor} ${p.model}`))
    for (const p of named) expect(printerForModel(p.id), p.id).toBe(Object.entries(K.printers).find(([, k]) => k.name === `${p.vendor} ${p.model}`)![0])
    expect(printerForModel('bambu-x2d')).toBe('bambu_x2d')
    expect(printerForModel('flsun-v400')).toBe('flsun_v400')
  })

  it('gives the X2D and the V400 the limits their knowledge printers hold', () => {
    expect(printerProfile('bambu-x2d')!.limits).toEqual({ maxSpeed: 1000, maxAccel: 20000, hotendMaxTemp: 300, bedMaxTemp: 120 })
    expect(printerProfile('flsun-v400')!.limits).toEqual({ maxSpeed: 1000, maxAccel: 20000 })
  })
})

describe('the bed of a knowledge printer', () => {
  it('is the bed of the one catalog model mapped to it', () => {
    const by = new Map<string, string[]>()
    for (const m of mappedModels()) by.set(printerForModel(m)!, [...(by.get(printerForModel(m)!) ?? []), m])
    // a printer sold in several sizes (the Voron kits) maps more than one model; its knowledge entry models one size
    const single = [...by].filter(([, ms]) => ms.length === 1)
    expect(single.length).toBeGreaterThan(15)
    for (const [k, [m]] of single) {
      const build = K.printers[k]!.build
      if (!build) continue
      expect(footprint(build as never), `${k} and ${m}`).toEqual(footprint(printerProfile(m!)!.buildVolume))
    }
    expect(footprint(K.printers['elegoo_neptune_4_pro']!.build as never)).toEqual([230, 230])
  })
})
