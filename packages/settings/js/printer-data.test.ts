// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer data the profiles are built from agrees with itself: a knowledge printer the catalog has a model of is
// mapped to it, and its bed is that model's. The Prusa XL keeps the clearances of Prusa's own profile.
import { describe, expect, it } from 'vitest'
import { K } from './knowledge'
import { listPrinterProfiles, machineEntry, printerConfig, printerProfile } from './profiles'
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

describe('the Prusa XL', () => {
  it('keeps the one clearance height of Prusa\'s own profile, 21 mm, for the rod and the lid', () => {
    for (const id of ['prusa-xl', 'prusa-xl-5-toolhead']) {
      const c = printerConfig(id) as unknown as Record<string, unknown>
      expect([c['extruder_clearance_height_to_rod'], c['extruder_clearance_height_to_lid'], c['extruder_clearance_radius']], id).toEqual([21, 21, 67])
    }
  })
})

describe('the Elegoo Neptune 4 family', () => {
  it('prints on the area of Elegoo\'s own profile, a few mm past the size on the box for the Plus and Max', () => {
    const area = (id: string): [number, number] => {
      const pts = (machineEntry(id)!.machine['printable_area'] as string[]).map((p) => p.split('x').map(Number) as [number, number])
      return [Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))]
    }
    for (const [id, bed] of [['elegoo-neptune-4', [230, 230]], ['elegoo-neptune-4-pro', [230, 230]], ['elegoo-neptune-4-plus', [325, 325]], ['elegoo-neptune-4-max', [426, 426]]] as const) {
      expect(area(id), id).toEqual(bed)
      expect(footprint(printerProfile(id)!.buildVolume), id).toEqual(bed)
    }
  })
})
