// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrintConfig } from '@slicerx/contracts/settings'
import { resolveAuto } from './auto'
import { SETTINGS, defaultConfig } from './schema'
import { validate } from './validate'

const cfg = (o: Record<string, unknown>) => o as unknown as PrintConfig

describe('resolveAuto', () => {
  it('turns every automatic line width in the defaults into a concrete one for a 0.4 mm nozzle', () => {
    const out = resolveAuto(cfg(defaultConfig()), { nozzleDiameter: 0.4 })
    expect(out['line_width']).toBe('0.42')
    expect(out['outer_wall_line_width']).toBe('0.42')
    expect(out['inner_wall_line_width']).toBe('0.42')
    expect(out['top_surface_line_width']).toBe('0.42')
    expect(out['initial_layer_line_width']).toBe('0.48')
    expect(out['sparse_infill_line_width']).toBe('0.45')
    expect(out['internal_solid_infill_line_width']).toBe('0.45')
    for (const d of SETTINGS.filter((s) => s.auto)) expect(out[d.key], d.key).not.toBe('0')
    expect(validate(out).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('scales with the nozzle and reads it from the config when not given', () => {
    expect(resolveAuto(cfg({ line_width: '0', outer_wall_line_width: '0' }), { nozzleDiameter: 0.6 })['outer_wall_line_width']).toBe('0.63')
    expect(resolveAuto(cfg({ nozzle_diameter: [0.6], inner_wall_line_width: '0', sparse_infill_line_width: '0' }))['sparse_infill_line_width']).toBe('0.675')
    expect(resolveAuto(cfg({ top_surface_line_width: '0' }))['top_surface_line_width']).toBe('0.42')
  })

  it('lets a set default line width stand in for the automatic ones', () => {
    const out = resolveAuto(cfg({ line_width: '0.5', outer_wall_line_width: '0', initial_layer_line_width: '0' }), { nozzleDiameter: 0.4 })
    expect(out['line_width']).toBe('0.5')
    expect(out['outer_wall_line_width']).toBe('0.5')
    expect(out['initial_layer_line_width']).toBe('0.5')
    expect(resolveAuto(cfg({ line_width: '110%', inner_wall_line_width: '0' }), { nozzleDiameter: 0.4 })['inner_wall_line_width']).toBe('0.44')
  })

  it('leaves set widths, other keys and missing keys alone, and does not change its input', () => {
    const input = cfg({ line_width: '0', outer_wall_line_width: '0.6', inner_wall_line_width: '105%', layer_height: 0.2 })
    const copy = structuredClone(input)
    const out = resolveAuto(input, { nozzleDiameter: 0.4 })
    expect(input).toEqual(copy)
    expect(out['outer_wall_line_width']).toBe('0.6')
    expect(out['inner_wall_line_width']).toBe('105%')
    expect(out['layer_height']).toBe(0.2)
    expect('sparse_infill_line_width' in out).toBe(false)
  })

  it('resolves the filament ironing speed from the process ironing speed', () => {
    expect(resolveAuto(cfg({ filament_ironing_speed: 0, ironing_speed: 30 }))['filament_ironing_speed']).toBe(30)
    expect(resolveAuto(cfg({ filament_ironing_speed: [0, 0] }))['filament_ironing_speed']).toEqual([20, 20])
  })
})
