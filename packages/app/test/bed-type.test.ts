// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { bedTypeConfig, plateBedType, printerBedType } from '../src/plate/bed-type'

const plate = (bedType?: 'cool' | 'textured-pei' | 'smooth-pei') => ({ settings: bedType ? { bedType } : {} })

describe('the plate type a plate prints on', () => {
  it('takes the plate\'s own type first', () => {
    expect(plateBedType(plate('cool'), { default_bed_type: '4' })).toEqual({ value: 'cool', label: 'Cool plate', source: 'plate' })
  })

  it('falls back to the printer\'s default, as a number or a name', () => {
    expect(plateBedType(plate(), { default_bed_type: '4' })).toMatchObject({ value: 'textured-pei', label: 'Textured PEI', source: 'printer' })
    expect(plateBedType(plate(), { default_bed_type: 'Textured PEI Plate' })).toMatchObject({ value: 'textured-pei', source: 'printer' })
    expect(plateBedType(plate(), { default_bed_type: ['1'] })).toMatchObject({ value: 'cool', source: 'printer' })
  })

  it('uses smooth PEI with no default, as Orca does, and for a value it cannot read', () => {
    expect(plateBedType(plate(), {})).toMatchObject({ value: 'smooth-pei', label: 'Smooth PEI', source: 'default' })
    expect(plateBedType(undefined, { default_bed_type: 'Gold Plate' })).toMatchObject({ value: 'smooth-pei', source: 'default' })
    expect(printerBedType({ default_bed_type: '' })).toBeUndefined()
    expect(printerBedType({ default_bed_type: '9' })).toBeUndefined()
  })

  it('slices with the engine name of the plate type', () => {
    expect(bedTypeConfig(plate('cool'), {})).toEqual({ curr_bed_type: 'Cool Plate' })
    expect(bedTypeConfig(plate('smooth-pei'), {})).toEqual({ curr_bed_type: 'High Temp Plate' })
    expect(bedTypeConfig(plate(), { default_bed_type: '4' })).toEqual({ curr_bed_type: 'Textured PEI Plate' })
    expect(bedTypeConfig(undefined, {})).toEqual({ curr_bed_type: 'High Temp Plate' })
  })
})
