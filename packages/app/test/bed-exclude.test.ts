// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { excludedPolygons } from '../src/viewport/bed-exclude'

describe('bed exclusion areas', () => {
  it('reads the number pairs resolved profiles carry', () => {
    // Bambu Lab P1P: the corner by the purge chute.
    expect(excludedPolygons([[0, 0], [18, 0], [18, 28], [0, 28]])).toEqual([[[0, 0], [18, 0], [18, 28], [0, 28]]])
  })

  it("reads OrcaSlicer's text form, as a list or one string", () => {
    const want = [[[246, 0], [256, 0], [256, 20], [246, 20]]]
    expect(excludedPolygons(['246x0', '256x0', '256x20', '246x20'])).toEqual(want)
    expect(excludedPolygons('246x0, 256x0,256x20,246x20')).toEqual(want)
  })

  it('treats the usual empty values as no area', () => {
    expect(excludedPolygons([[0, 0]])).toEqual([])
    expect(excludedPolygons(['0x0'])).toEqual([])
    expect(excludedPolygons('')).toEqual([])
    expect(excludedPolygons(undefined)).toEqual([])
    expect(excludedPolygons([[0, 0], [10, 0], [20, 0]])).toEqual([])
    expect(excludedPolygons(['0x0', 'nonsense', '5x5'])).toEqual([])
  })
})
