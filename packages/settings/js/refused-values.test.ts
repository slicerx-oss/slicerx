// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings a project file carries leave out what other slicers refuse from a project: a filament ironing speed on
// automatic and a post-processing list of empty scripts. A real script and a set ironing speed stay.
import { describe, expect, it } from 'vitest'
import { withoutRefusedValues } from './import'

describe('settings without the values other slicers refuse', () => {
  it('leaves out a filament ironing speed on automatic, as no value, 0 or nil', () => {
    for (const v of [[], ['0'], [0, 0], '0', ['nil'], ['']]) expect(withoutRefusedValues({ filament_ironing_speed: v, layer_height: '0.2' })).toEqual({ layer_height: '0.2' })
  })

  it('gives a filament on automatic the process ironing speed when another filament sets its own', () => {
    expect(withoutRefusedValues({ filament_ironing_speed: ['0', '25'], ironing_speed: '30' })['filament_ironing_speed']).toEqual(['30', '25'])
    expect(withoutRefusedValues({ filament_ironing_speed: ['25', 'nil'] })['filament_ironing_speed']).toEqual(['25', '20'])
  })

  it('keeps a filament ironing speed every filament sets', () => {
    expect(withoutRefusedValues({ filament_ironing_speed: ['25', '30'] })['filament_ironing_speed']).toEqual(['25', '30'])
  })

  it('leaves out a post-processing list of empty scripts and keeps a real one', () => {
    for (const v of [[''], [], ['', ' '], '']) expect(withoutRefusedValues({ post_process: v })).toEqual({})
    expect(withoutRefusedValues({ post_process: ['/usr/bin/tidy'] })).toEqual({ post_process: ['/usr/bin/tidy'] })
  })

  it('changes nothing else and leaves its input alone', () => {
    const input = { filament_ironing_speed: [], post_process: [''], wall_loops: '3' }
    expect(withoutRefusedValues(input)).toEqual({ wall_loops: '3' })
    expect(input).toEqual({ filament_ironing_speed: [], post_process: [''], wall_loops: '3' })
  })
})
