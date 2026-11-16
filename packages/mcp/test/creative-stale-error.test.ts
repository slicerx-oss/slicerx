// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A stale replay is left out of the score, and the CLI prints STALE for it. A stale run that also diverged carries the
// divergence in its error, so the lines for a stale run print that error too, in the form a broken run's error uses.
import { describe, expect, it } from 'vitest'
import { staleLines, STALE_PLAN_GOES_ON } from '../evals/creative/run'

describe('the lines a stale replay prints', () => {
  it('prints STALE, then the run error in the broken-run form', () => {
    const error = 'replay diverged at request 3 (pilot.sheet): recorded failed "Invalid arguments", got ok "Confirmed as shown"'
    expect(staleLines('hinge-box', { stale: STALE_PLAN_GOES_ON, error })).toEqual([
      `STALE    ${'hinge-box'.padEnd(28)} not scored: ${STALE_PLAN_GOES_ON}`,
      `     error: ${error}`,
    ])
  })

  it('prints only STALE when the run has no error', () => {
    expect(staleLines('gear-pair', { stale: STALE_PLAN_GOES_ON })).toEqual([`STALE    ${'gear-pair'.padEnd(28)} not scored: ${STALE_PLAN_GOES_ON}`])
  })
})
