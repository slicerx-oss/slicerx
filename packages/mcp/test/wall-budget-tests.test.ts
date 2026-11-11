// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.check stops reading the wall after 1.5 s of wall clock. A lofted bottle shelled to 2 mm reads in under a second
// on a quiet machine, but a recorded square bottle replay read "part too dense" on a loaded CI runner and its last check
// flipped to fail. Tests and replays read by the facet cap alone (SX_WALL_COUNT_ONLY=1 in vitest.config.ts), and the
// app reads with both limits as before.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkWallBudget, WALL_BUDGET } from '../src/body-facts'

describe('the wall budget design.check reads with', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is the facet cap alone under the test config', () => {
    expect(process.env['SX_WALL_COUNT_ONLY']).toBe('1')
    expect(checkWallBudget()).toEqual({ maxFacets: WALL_BUDGET.maxFacets, maxMs: Infinity })
  })

  it('keeps the time limit when the flag is off', () => {
    vi.stubEnv('SX_WALL_COUNT_ONLY', '')
    expect(checkWallBudget()).toBe(WALL_BUDGET)
    expect(WALL_BUDGET).toEqual({ maxFacets: 1_000_000, maxMs: 1500 })
  })
})
