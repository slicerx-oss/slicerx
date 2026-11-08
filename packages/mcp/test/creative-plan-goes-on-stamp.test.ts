// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When mimir's reply would end with the plan approved in the same run unfinished, the run goes on once with a note
// (plan_left). A recording captured before that note replays into it with no reply of the model's to give, so it is
// marked stale and left out of the score, as a recording to capture again, never a failure of the model. A live capture
// in which the note came stamps the recording planGoesOn, and a stamped recording replays as recorded.
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { parseRecording } from '../evals/creative/recordings'
import { replayScored, runPrompt, STALE_PLAN_GOES_ON, STALE_RESTART } from '../evals/creative/run'

const FISH = CREATIVE_PROMPTS.find((x) => x.id === 'flexi-fish')!
const card = { name: 'design.plan', args: { part: 'Segmented fish', units: 'mm', features: [{ name: 'Body segments', kind: 'extrude', sizes: { segment_length: 16, segment_height: 24, segment_width: 12, count: 6 } }, { name: 'Hinge pins and sockets', kind: 'hole', sizes: { pin_diameter: 2, socket_diameter: 2.4 } }], assumptions: [], questions: [] } }
// the plan gets Go and the reply ends with nothing built: mimir goes on once with its note
const before = [{ text: 'Here is the plan.', calls: [card] }, { text: 'The plan is approved.' }]
// a capture made since the note: the model answered it by starting the part, then ended
const since = [...before, { calls: [{ name: 'design.new', args: { name: 'Segmented fish' } }] }, { text: 'Started the fish.' }]

describe('the planGoesOn stamp on a recording', () => {
  it('a recording from before the note replays as stale and is not scored', async () => {
    const run = await runPrompt(FISH, { geom: undefined, steps: before, answerRecorded: true, tabTools: true, samePart: true })
    expect(run.planGoesOn).toBe(true)
    expect(run.stale).toBe(STALE_PLAN_GOES_ON)
    expect(run.stale).toMatch(/plan_left/)
    expect(replayScored(run)).toBe(false)
  })

  it('a recording captured since, which saw the note, replays as recorded and is scored', async () => {
    const run = await runPrompt(FISH, { geom: undefined, steps: since, answerRecorded: true, tabTools: true, samePart: true, planGoesOn: true })
    expect(run.planGoesOn).toBe(true)
    expect(run.stale).toBeUndefined()
    expect(run.calls).toEqual(['design.plan', 'design.new'])
    expect(run.reply).toContain('Started the fish.')
    expect(replayScored(run)).toBe(true)
  })

  it('a run with no note carries no stamp and stays scored', async () => {
    const sheetOnly = [{ calls: [{ name: 'design.new', args: { name: 'Fish' } }] }, { text: 'Started.' }]
    const run = await runPrompt(FISH, { geom: undefined, steps: sheetOnly, answerRecorded: true, tabTools: true, samePart: true })
    expect(run.planGoesOn).toBeUndefined()
    expect(run.stale).toBeUndefined()
    expect(replayScored(run)).toBe(true)
    // other stale reasons are scored as before
    expect(replayScored({ ...run, stale: STALE_RESTART })).toBe(true)
  })

  it('is kept when a recording is read, and must be true or false', () => {
    const base = { status: 'recorded', model: 'm', provider: 'p', capturedAt: '2026-11-08T00:00:00Z', steps: [{ text: 'hi' }], tabTools: true }
    expect(parseRecording(JSON.stringify({ ...base, planGoesOn: true }))).toMatchObject({ planGoesOn: true })
    expect(parseRecording(JSON.stringify(base))).not.toHaveProperty('planGoesOn')
    expect(() => parseRecording(JSON.stringify({ ...base, planGoesOn: 'yes' }))).toThrow(/planGoesOn must be true or false/)
  })
})
