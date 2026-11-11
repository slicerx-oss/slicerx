// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every creative eval recording replays on the current code as it was captured. It keeps what the model read before
// each reply, and no replay diverges from that, leaves recorded replies unused or ends early, and none the eval marks
// stale. A change that moves what a tool returns (a design's coordinates, a tool renamed) fails here, on the CI job that
// builds the geometry engine, instead of showing up later as a score that dropped for no reason. The score itself may
// be a fail: a recording keeps the model's own miss. Recapture a recording this names with eval:creative --mode live
// --record.
import { describe, expect, it } from 'vitest'
import { evalGeom } from '@slicerx/pilot/evals/node'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { loadRecording } from '../evals/creative/recordings'
import { runPrompt } from '../evals/creative/run'
import { liveEngine } from './geom-engine'

/**
 * Recordings left out here, each with why: captured again on a branch that has not landed yet (the line goes when it
 * lands), or not captured again yet.
 */
const ELSEWHERE: Record<string, string> = {
  'gear-pair': 'not captured again yet: two live runs stopped at their cost cap before the model finished',
}

// the replays build real geometry, so they run where the engine is built (the web job), and skip on the replay job
describe.skipIf(!liveEngine)('creative eval recordings on the current code', () => {
  const geom = liveEngine ? evalGeom() : undefined
  for (const p of CREATIVE_PROMPTS) {
    const rec = loadRecording(p.id)
    if (rec.status !== 'recorded' || p.id in ELSEWHERE) continue
    it(`${p.id} replays as captured`, { timeout: 60_000 }, async () => {
      // a recording keeps what the model read before each reply (seen), so the replay can tell where it parts from it;
      // one from before that cannot be checked, and a replay of it can fail far from the cause
      if (rec.steps.some((s) => s.calls?.length)) expect(rec.steps.some((s) => s.seen?.length), `${p.id} has no seen: capture it again`).toBe(true)
      const run = await runPrompt(p, { geom, steps: rec.steps, defaultAnswer: true, answerRecorded: rec.defaultAnswer === true, tabTools: rec.tabTools === true, samePart: rec.samePart === true, planGoesOn: rec.planGoesOn === true })
      expect(run.stale, `${p.id} is stale`).toBeUndefined()
      expect(run.error, `${p.id} no longer replays`).toBeUndefined()
    })
  }
})
