// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer data the profiles are built from agrees with itself: a knowledge printer the catalog has a model of is
// mapped to it.
import { describe, expect, it } from 'vitest'
import { K } from './knowledge'
import { listPrinterProfiles, printerProfile } from './profiles'
import { printerForModel } from './printermodels'

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
