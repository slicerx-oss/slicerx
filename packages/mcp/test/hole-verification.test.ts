// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { verifyHole } from '../src/hole-verification'

const before = { entry: [0, 0, 3], axis: [0, 0, 1], diameterMm: 4, depthMm: 3, through: true }
it('detects a no-op edit and verifies the requested measured diameter', () => {
  expect(verifyHole(before, before, { diameter_mm: 6 })).toMatchObject({ status: 'failed', checks: { diameter: false } })
  expect(verifyHole(before, before, { diameter_mm: 4.001 }).status).toBe('failed')
  expect(verifyHole(before, { ...before, diameterMm: 6 }, { diameter_mm: 6 })).toMatchObject({ status: 'verified', toleranceMm: 0.01 })
})
it('does not verify nonfinite measurements or a different hole axis', () => {
  expect(verifyHole(before, { ...before, diameterMm: NaN }, {})).toMatchObject({ status: 'failed', checks: { finite: false } })
  expect(verifyHole(before, { ...before, entry: [NaN, 0, 0] }, {})).toMatchObject({ status: 'failed', measuredDepthMm: null })
  expect(verifyHole(before, { ...before, entry: [2, 0, 3] }, {})).toMatchObject({ status: 'failed', checks: { targetAxis: false } })
})
it('accepts measuring from the opposite entry and checks a blind depth change', () => {
  expect(verifyHole(before, { ...before, entry: [0, 0, 0], axis: [0, 0, -1] }, {})).toMatchObject({ status: 'verified', measuredDepthMm: 3 })
  const blind = { ...before, through: false }
  expect(verifyHole(blind, { ...blind, depthMm: 5 }, { depth_mm: 5 })).toMatchObject({ status: 'verified', measuredDepthMm: 5 })
})
it('does not claim requested head dimensions were verified', () => {
  expect(verifyHole(before, before, { counterbore: { diameter_mm: 8, depth_mm: 1 } })).toMatchObject({ status: 'unverified', checks: { diameter: true } })
})
