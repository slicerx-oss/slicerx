// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printer a project was made for, against the printer the plate is on: PrusaSlicer's model codes name our Prusa
// profiles, and a project for another printer is offered rather than switched to.
import { describe, expect, it } from 'vitest'
import { matchProjectPrinter, projectPrinterOffer } from './project-open'

describe("PrusaSlicer's printer model codes", () => {
  it('name the same machine on its input shaper firmware', () => {
    expect(matchProjectPrinter({ printer_model: 'MK4IS', nozzle_diameter: '0.4' })).toMatchObject({ kind: 'match', profileId: 'prusa-mk4', nozzle: 0.4 })
    expect(matchProjectPrinter({ printer_model: 'MINIIS', nozzle_diameter: '0.4' })).toMatchObject({ kind: 'match', profileId: 'prusa-mini-plus' })
    expect(matchProjectPrinter({ printer_model: 'XLIS', nozzle_diameter: '0.6' })).toMatchObject({ kind: 'match', profileId: 'prusa-xl', nozzle: 0.6 })
    expect(matchProjectPrinter({ printer_model: 'XL5IS', nozzle_diameter: '0.4' })).toMatchObject({ kind: 'match', profileId: 'prusa-xl-5-toolhead' })
    expect(matchProjectPrinter({ printer_model: 'MK4S', nozzle_diameter: '0.4' })).toMatchObject({ kind: 'match', profileId: 'prusa-mk4s' })
    expect(matchProjectPrinter({ printer_model: 'COREONE', nozzle_diameter: '0.4' })).toMatchObject({ kind: 'match', profileId: 'prusa-core-one' })
  })

  it('a code we have no profile for stays unknown, and only Prusa profiles are looked at', () => {
    expect(matchProjectPrinter({ printer_model: 'XL3IS', nozzle_diameter: '0.4' })).toEqual({ kind: 'unknown', name: 'XL3IS', nozzle: 0.4 })
    expect(matchProjectPrinter({ printer_model: 'P1SIS', nozzle_diameter: '0.4' })).toEqual({ kind: 'unknown', name: 'P1SIS', nozzle: 0.4 })
  })
})

describe('the offer', () => {
  const mk4 = matchProjectPrinter({ printer_model: 'MK4IS', nozzle_diameter: '0.4' })

  it('offers a printer we have a profile for when the plate is on another one, or on none', () => {
    expect(projectPrinterOffer(mk4, { profileId: 'bambu-p1s', nozzle: 0.4 })).toMatchObject({ kind: 'offer', match: { profileId: 'prusa-mk4', nozzle: 0.4 } })
    expect(projectPrinterOffer(mk4, { profileId: 'prusa-mk4', nozzle: 0.6 })).toMatchObject({ kind: 'offer' })
    expect(projectPrinterOffer(mk4, { profileId: null })).toMatchObject({ kind: 'offer' })
  })

  it('says nothing to switch to when the plate is already on it', () => {
    expect(projectPrinterOffer(mk4, { profileId: 'prusa-mk4', nozzle: 0.4 })).toMatchObject({ kind: 'same' })
  })

  it('names a printer with no profile, and is null when the file names none', () => {
    expect(projectPrinterOffer(matchProjectPrinter({ printer_model: 'Acme 9000', nozzle_diameter: '0.4' }), { profileId: 'bambu-p1s', nozzle: 0.4 })).toEqual({ kind: 'unknown', name: 'Acme 9000', nozzle: 0.4 })
    expect(projectPrinterOffer(matchProjectPrinter({ layer_height: '0.2' }), { profileId: 'bambu-p1s' })).toBeNull()
  })
})
