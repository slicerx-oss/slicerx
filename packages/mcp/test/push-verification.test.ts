// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { verifyPush } from '../src/push-verification'

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const mesh = (z: number) => ({ name: 'Plane', slot: 1, positions: [0, 0, z, 2, 0, z, 0, 2, z], indices: [0, 1, 2], faces: { ids: [0], keys: [17], table: [{ kind: 'plane', normal: [0, 0, 1], offset: z }] } })
it('distinguishes a requested signed move from a no-op', () => {
  expect(verifyPush(mesh(0), identity, 0, [0, 0, 0], [0, 0, 1], 2)).toMatchObject({ status: 'failed', measuredDistanceMm: 0 })
  expect(verifyPush(mesh(0), identity, 0, [0, 0, 0], [0, 0, 1], 0.001)).toMatchObject({ status: 'failed', toleranceMm: 0.00001 })
  expect(verifyPush(mesh(-2), identity, 0, [0, 0, 0], [0, 0, 1], -2)).toMatchObject({ status: 'verified', measuredDistanceMm: -2 })
})
it('measures after rotation, placement and nonuniform scaling', () => {
  const transform = [0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 10, 20, 30, 1]
  expect(verifyPush(mesh(0.5), transform, 0, [10, 20, 30], [1, 0, 0], 2)).toMatchObject({ status: 'verified', measuredDistanceMm: 2 })
})
it('does not use another face when the target is missing', () => {
  expect(verifyPush(mesh(2), identity, undefined, [0, 0, 0], [0, 0, 1], 2)).toMatchObject({ status: 'unverified', measuredDistanceMm: null })
})
it('refuses tilted, degenerate and invalid target measurements', () => {
  const tilted = mesh(2); tilted.positions[8] = 3
  expect(verifyPush(tilted, identity, 0, [0, 0, 0], [0, 0, 1], 2).status).toBe('failed')
  const invalid = mesh(2); invalid.positions[0] = NaN
  expect(verifyPush(invalid, identity, 0, [0, 0, 0], [0, 0, 1], 2).status).toBe('failed')
  const degenerate = mesh(2); degenerate.indices = [0, 0, 0]
  expect(verifyPush(degenerate, identity, 0, [0, 0, 0], [0, 0, 1], 2).status).toBe('unverified')
})
