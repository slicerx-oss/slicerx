// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The eval score takes efficiency points off a run for its errors. Free mimir's wait for its per-minute limit, which the
// run went on from, is the proxy's traffic and no error of the model's, so it costs nothing; the line that the run
// stopped at the limit, and any other error, still does.
import type { PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import type { Audit } from '../evals/harness'
import { score } from '../evals/score'
import type { Scenario } from '../evals/types'

const audit = (): Audit => ({ verifies: [], sideEffects: [], granted: new Map(), unapproved: () => [] })
const scenario = { id: 'wait', title: 'wait', expect: {} } as unknown as Scenario
const run = (...events: PilotEvent[]) => score(scenario, { events, overrides: {}, audit: audit() })

const waiting: PilotEvent = { type: 'error', message: 'Free mimir hit its limit for this minute.', retryable: false, code: 'slow_down', waiting: true }

describe('the eval score and free mimir waiting for its limit', () => {
  it('a wait the run went on from costs no efficiency', () => {
    const s = run(waiting, waiting)
    expect(s.efficiency).toBe(10)
    expect(s.notes.join(' ')).not.toMatch(/error/)
  })

  it('the line that the run stopped at the limit still counts as an error', () => {
    const s = run(waiting, { type: 'error', message: 'Free mimir is still at its limit.', retryable: false, code: 'slow_down' })
    expect(s.efficiency).toBe(6)
    expect(s.notes).toContain('1 errors')
  })

  it('any other error still counts', () => {
    expect(run({ type: 'error', message: 'Used up for today.', retryable: false, code: 'day_used' }).efficiency).toBe(6)
  })
})
