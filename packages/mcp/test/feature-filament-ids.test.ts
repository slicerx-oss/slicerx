// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { expect, it } from 'vitest'
import { featureFilaments } from '../src/feature-filaments'

it('preserves request ids and engine ids independently, including repeated names', () => {
  const features = { outerWall: [1], sparseInfill: [2] }
  const rows = featureFilaments([
    { object: 'o0-1', name: 'Bracket', features },
    { object: 'o0-2', name: 'Bracket', features },
    { object: 'o1', name: 'Native name', features },
  ], [{ id: 'archive', name: 'plate.3mf' }, { id: 'o0-1', name: 'Named part' }])
  expect(rows).toEqual([
    { object: 'archive', engine_object: 'o0-1', name: 'Bracket', features },
    { object: 'archive', engine_object: 'o0-2', name: 'Bracket', features },
    { object: 'o0-1', engine_object: 'o1', name: 'Named part', features },
  ])
  expect(new Set(rows.map((row) => row.engine_object)).size).toBe(3)
})

it('keeps file read-back without inventing project ids and ignores unknown engine references', () => {
  expect(featureFilaments([{ object: 'o0-2' }, { object: 'o0-0' }, { object: 'o9' }, { object: 'x0' }, {}], [{ name: 'plate.3mf' }])).toEqual([
    { engine_object: 'o0-2', name: 'plate.3mf (2)', features: {} },
  ])
})
