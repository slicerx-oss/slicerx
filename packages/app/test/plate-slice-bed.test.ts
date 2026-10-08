// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate type reaches the engine: every path that slices or checks a plate (the slice itself, the agent bridge and
// mimir through plateSliceConfig, the print sheet's preflight) sends the plate's curr_bed_type, which picks the bed
// temperatures. Before, none did, and every plate heated to the high temp plate's.
import { describe, expect, it } from 'vitest'
import { plateSliceConfig } from '../src/state/actions'
import { get, type PlateMeta, type PlateSettings } from '../src/state/store'

const meta = (settings: PlateSettings): PlateMeta => ({ id: 'p1', name: 'Plate 1', objects: [], settings })

describe('the config a plate slices with', () => {
  it('carries the plate type of each plate', () => {
    const cases: [NonNullable<PlateSettings['bedType']>, string][] = [
      ['cool', 'Cool Plate'],
      ['engineering', 'Engineering Plate'],
      ['textured-pei', 'Textured PEI Plate'],
      ['smooth-pei', 'High Temp Plate'],
      ['high-temp', 'High Temp Plate'],
    ]
    for (const [bedType, name] of cases) expect((plateSliceConfig(get(), meta({ bedType })) as Record<string, unknown>)['curr_bed_type'], bedType).toBe(name)
  })

  it('heats a plate without a type on the high temp plate, as before', () => {
    expect((plateSliceConfig(get(), meta({})) as Record<string, unknown>)['curr_bed_type']).toBe('High Temp Plate')
    expect((plateSliceConfig(get(), undefined) as Record<string, unknown>)['curr_bed_type']).toBe('High Temp Plate')
  })
})
