// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project's layer heights by height go to the slice as its height ranges' layer_height, and the engine plans the
// plate's layers from them. The app's side of each case is held to one record,
// packages/core/tests/fixtures/range-layer-heights.json, which the engine's test (packages/core/tests/range_layer_heights.rs)
// slices from its side: the ranges the app sends give the layer tops the app planned itself before (125 on the range
// box), and the app's rule for objects that change layer height at different heights is the engine's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HeightRange, SettingValue } from '@slicerx/contracts'
import { heightRangesOf, layerHeightsDiffer } from '../src/plate/layer-ranges'

const repo = join(__dirname, '..', '..', '..')
const record = JSON.parse(readFileSync(join(repo, 'packages/core/tests/fixtures/range-layer-heights.json'), 'utf8')) as {
  note: string
  config: { layer_height: number; initial_layer_print_height: number }
  cases: {
    name: string
    objects: { id: string; heightMm: number; layerRanges: { minZ: number; maxZ: number; settings: Record<string, SettingValue> }[] }[]
    heightRanges: HeightRange[]
    differ: boolean
    tops: number[] | null
  }[]
}

describe("a project's layer heights by height", () => {
  it.each(record.cases.map((c) => [c.name, c] as const))('%s: go to the slice as the record says', (_name, c) => {
    const entries = c.objects.map((o) => ({ id: o.id, printable: true, layerRanges: o.layerRanges }))
    expect(heightRangesOf(entries, { layerHeights: true })).toEqual(c.heightRanges)
    expect(layerHeightsDiffer(entries)).toBe(c.differ)
    // Without a plan by ranges (sleipnir, a calibration plate, a resume's tops) only the range keys go.
    expect(heightRangesOf(entries).some((r) => 'layer_height' in r.settings)).toBe(false)
  })

  it('the range box is the 125 layers the app planned for it before', () => {
    const box = record.cases.find((c) => c.name === 'range box')!
    const every = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) }, (_, i) => Math.round((from + (i + 1) * step) * 1e6) / 1e6)
    expect(box.tops).toEqual([...every(0, 5, 0.2), ...every(5, 10, 0.1), ...every(10, 20, 0.2)])
    expect(box.tops).toHaveLength(125)
    expect(record.config).toEqual({ layer_height: 0.2, initial_layer_print_height: 0.2 })
  })
})
