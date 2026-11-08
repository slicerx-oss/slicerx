// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A recording whose reply met mimir's refusal of a design.new that starts the same part again replays as stale when it
// was captured before that refusal, since the model never saw it. A live capture made since then saw it and answered
// it, so the recording carries a stamp (samePart) and replays as recorded instead of asking for a capture again.
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { parseRecording } from '../evals/creative/recordings'
import { runPrompt, STALE_RESTART } from '../evals/creative/run'

const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
const sheet = { calls: [{ name: 'pilot.sheet', args: { title: 'Tray size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }] }
// the second design.new comes before the first part has a body, so mimir refuses it (same_part)
const steps = [sheet, { calls: [{ name: 'design.new', args: { name: 'Cable tray' } }] }, { calls: [{ name: 'design.new', args: { name: 'Cable tray v2' } }] }, { text: 'Done.' }]

describe('the same_part stamp on a recording', () => {
  it('a recording from before the refusal replays as stale', async () => {
    const run = await runPrompt(P, { geom: undefined, steps, answerRecorded: true, tabTools: true })
    expect(run.stale).toBe(STALE_RESTART)
  })

  it('a recording captured since, which saw the refusal, replays as recorded', async () => {
    const run = await runPrompt(P, { geom: undefined, steps, answerRecorded: true, tabTools: true, samePart: true })
    expect(run.stale).toBeUndefined()
    // the refused design.new built nothing, and the reply after it is the recorded one
    expect(run.calls).toEqual(['pilot.sheet', 'design.new'])
    expect(run.reply).toBe('Done.')
  })

  it('is kept when a recording is read, and must be true or false', () => {
    const base = { status: 'recorded', model: 'm', provider: 'p', capturedAt: '2026-11-08T00:00:00Z', steps: [{ text: 'hi' }], tabTools: true }
    expect(parseRecording(JSON.stringify({ ...base, samePart: true }))).toMatchObject({ samePart: true })
    expect(parseRecording(JSON.stringify(base))).not.toHaveProperty('samePart')
    expect(() => parseRecording(JSON.stringify({ ...base, samePart: 'yes' }))).toThrow(/samePart must be true or false/)
  })
})
