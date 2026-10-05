// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { plateConfig } from '../src/plate/plates'
import type { PlateMeta } from '../src/state/store'

const meta = (settings: PlateMeta['settings']): PlateMeta => ({ id: 'p1', name: 'Plate 1', objects: [], settings })

describe('plate config', () => {
  it('carries the print sequence', () => {
    expect(plateConfig(meta({ sequence: 'by-object' }))).toEqual({ print_sequence: 'by object' })
    expect(plateConfig(undefined)).toEqual({})
  })

  it('leaves the filament order to the engine until the person sets one', () => {
    expect(plateConfig(meta({ sequence: 'by-layer' }))['first_layer_print_sequence']).toBeUndefined()
    expect(plateConfig(meta({ sequence: 'by-layer', filamentOrder: [1] }))['first_layer_print_sequence']).toBeUndefined()
  })

  it('passes the plate filament order for the first and every other layer', () => {
    expect(plateConfig(meta({ sequence: 'by-layer', filamentOrder: [3, 1, 2] }))).toEqual({
      print_sequence: 'by layer',
      first_layer_print_sequence: [3, 1, 2],
      other_layers_print_sequence: [1, 9999, 3, 1, 2],
      other_layers_print_sequence_nums: 1,
    })
  })
})
