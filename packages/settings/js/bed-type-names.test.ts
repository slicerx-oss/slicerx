// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate type names a person or a client gives: the app's picker labels, read in any letter case, with or without
// "plate" and in the app's own spelling with dashes. The MCP server's plate_type reads them the same way.
import { describe, expect, it } from 'vitest'
import { BED_TYPE_ENGINE, BED_TYPE_OPTIONS, BED_TYPE_TEMP_KEY, bedTypeByName } from './bed-type'

describe('a plate type by name', () => {
  it('reads every picker label, and its value', () => {
    for (const o of BED_TYPE_OPTIONS) {
      expect(bedTypeByName(o.label), o.label).toBe(o.value)
      expect(bedTypeByName(o.value), o.value).toBe(o.value)
    }
  })

  it('reads any letter case, extra spaces, "plate" or not, and the engine names', () => {
    expect(bedTypeByName('  TEXTURED  pei ')).toBe('textured-pei')
    expect(bedTypeByName('cool')).toBe('cool')
    expect(bedTypeByName('Cool Plate')).toBe('cool')
    expect(bedTypeByName('textured_cool_plate')).toBe('textured-cool')
    expect(bedTypeByName('High Temp Plate')).toBe('high-temp')
    expect(bedTypeByName('Supertack')).toBe('supertack')
  })

  it('has no plate type for another name or none', () => {
    for (const name of ['', '   ', 'plate', 'Glass', 'PEI', 'Textured PEI Plate 2']) expect(bedTypeByName(name), name).toBeUndefined()
  })

  it('names an engine plate and its temperature setting for every option', () => {
    for (const o of BED_TYPE_OPTIONS) {
      expect(BED_TYPE_ENGINE[o.value]).toMatch(/ Plate$/)
      expect(BED_TYPE_TEMP_KEY[o.value]).toMatch(/_plate_temp$/)
    }
    expect(BED_TYPE_TEMP_KEY['smooth-pei']).toBe(BED_TYPE_TEMP_KEY['high-temp'])
  })
})
