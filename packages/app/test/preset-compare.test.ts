// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { comparable, comparePresets } from '../src/presets/compare'
import { formatValue, settingDef } from '@slicerx/settings'
import type { UserPreset } from '../src/presets/store'

const preset = (id: string, kind: UserPreset['kind'], values: UserPreset['values']): UserPreset => ({ id, kind, name: id, values, createdAt: 1, updatedAt: 1 })
const text = { label: (k: string) => settingDef(k)?.label ?? k, format: (k: string, v: Parameters<typeof formatValue>[1]) => formatValue(settingDef(k), v) }

describe('compare presets', () => {
  it('lists only the settings that differ, with labels and readable values', () => {
    const a = preset('a', 'process', { layer_height: 0.2, sparse_infill_density: '15%', outer_wall_speed: 60 })
    const b = preset('b', 'process', { layer_height: 0.12, sparse_infill_density: '15%' })
    const rows = comparePresets(a, b, text)
    expect(rows.map((r) => r.key).sort()).toEqual(['layer_height', 'outer_wall_speed'])
    const lh = rows.find((r) => r.key === 'layer_height')!
    expect(lh.label).toMatch(/layer height/i)
    expect(lh.a).toContain('0.2')
    expect(lh.b).toContain('0.12')
    expect(rows.find((r) => r.key === 'outer_wall_speed')!.b).toBe('not set')
  })

  it('finds nothing between identical presets and compares only the same kind', () => {
    const a = preset('a', 'filament', { nozzle_temperature: 210 })
    expect(comparePresets(a, preset('b', 'filament', { nozzle_temperature: 210 }), text)).toEqual([])
    expect(comparable(a, [a, preset('b', 'filament', {}), preset('c', 'process', {})]).map((p) => p.id)).toEqual(['b'])
  })
})
