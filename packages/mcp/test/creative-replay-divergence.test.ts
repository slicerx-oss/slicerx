// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A replay compares each tool result it gets with the one its recording saw at that request, and fails at the first one
// that differs in a way that matters: a stale recording names itself instead of showing up later as a part never built.
import type { LlmMessage } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { loadRecording, parseRecording, RECORDINGS_DIR } from '../evals/creative/recordings'
import { differs, divergence, fingerprint } from '../evals/creative/replay-divergence'
import { runPrompt } from '../evals/creative/run'

const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
const result = (summary: string, ok = true, more: object = {}): string => JSON.stringify({ ok, summary, result: { design: 'obj_mw87cgddd1', steps: 1, ...more } })
const asked = (...results: string[]): LlmMessage[] => [
  { role: 'user', content: 'a clip' },
  { role: 'assistant', content: '', toolCalls: results.map((_, i) => ({ id: `c${i}`, name: i ? 'geom.extrude' : 'design.new', arguments: '{}' })) },
  ...results.map((content, i): LlmMessage => ({ role: 'tool', callId: `c${i}`, content })),
]
const LANDED = 'Extruded: step 1, Rectangle extrude 3 mm. The part was off the bed, so it moved to the plate by (128, 128) mm.'

describe('replay divergence', () => {
  it('names the request and the tool when a recorded ok comes back as an error', () => {
    const was = [result('Started Cable clip (obj_mw87cgddd1)'), result(LANDED)]
    const got = asked(result('Started Cable clip (obj_zz11aa22bb)'), result('The step did not go through: The shape no longer reaches the part.', false))
    expect(divergence(6, was, got)).toBe('replay diverged at request 6 (geom.extrude): recorded ok "Extruded: step 1, Rectangle extrude 3 mm. The part was off the bed, so it moved to the plate by (128, 128) mm.", got failed "The step did not go through: The shape no longer reaches the part."')
  })

  it('counts a different error, a changed landing note, a changed count and a refusal code', () => {
    expect(differs(result('x', false), result('y', false), 'geom.extrude')).toBeDefined()
    expect(differs(result('x', false), result('y', false), 'design.check')).toBeDefined()
    // the part landed on the plate by another distance: only the end of the sentence differs, and that is what is shown
    const moved = differs(result(LANDED), result(LANDED.replace('(128, 128)', '(110, 90)')), 'geom.extrude')
    expect(moved?.recorded).toContain('(128, 128)')
    expect(moved?.got).toContain('(110, 90)')
    expect(differs(result('Cut', true, { steps: 3 }), result('Cut', true, { steps: 4 }), 'geom.extrude')).toEqual({ recorded: 'steps 3', got: 'steps 4' })
    expect(differs(result('Built', true, { parts: [{}] }), result('Built', true, { parts: [] }), 'geom.build')).toEqual({ recorded: 'parts 1', got: 'parts 0' })
    expect(differs(JSON.stringify({ ok: false, error: 'no', code: 'same_part' }), JSON.stringify({ ok: false, error: 'no' }))).toEqual({ recorded: 'code same_part', got: 'code none' })
  })

  it('ignores ids a run makes, and what a result carries beyond what it says', () => {
    expect(differs(result('Started Cable clip (obj_mw87cgddd1)'), result('Started Cable clip (obj_zz11aa22bb)'), 'design.new')).toBeUndefined()
    expect(differs(result('Joined: step 2, Circle extrude (smw87cn992 d1234567890)'), result('Joined: step 2, Circle extrude (sab12cd34ef d9876543210)'), 'geom.extrude')).toBeUndefined()
    expect(differs(result('Cut', true, { volumeMm3: 1200.5, ms: 40 }), result('Cut', true, { volumeMm3: 1200.4, ms: 90 }), 'geom.extrude')).toBeUndefined()
    expect(fingerprint('not json')).toEqual({ message: 'not json' })
  })

  it('lets a check or a lookup say the same thing in other words, but not go from ok to an error', () => {
    const was = result('1 of 3 checks against plan p failed: feature count (want 3, got 2)')
    const now = result('1 of 3 checks against plan p failed: feature count (want 3 features, each built by one or more steps, got 2 steps)')
    expect(differs(was, now, 'design.check')).toBeUndefined()
    expect(differs(result('M3 screw: clearance close 3.1 mm'), result('M3 screw: clearance close 3.2 mm'), 'parts.lookup')).toBeUndefined()
    // the same words from a tool that changes the design are a different build
    expect(differs(was, now, 'geom.extrude')).toBeDefined()
    expect(differs(was, result('Invalid arguments', false), 'design.check')).toEqual({ recorded: expect.stringMatching(/^ok /), got: 'failed "Invalid arguments"' })
  })

  it('lets a failure grow advice after the words it already gave, and counts a failure that says something else', () => {
    const was = result('The step did not go through: The cut left a sliver. The design is unchanged.', false)
    expect(differs(was, result('The step did not go through: The cut left a sliver. The design is unchanged.. Extend the cutting shape 0.05 mm.', false), 'geom.extrude')).toBeUndefined()
    expect(differs(was, result('The step did not go through: The shape no longer reaches the part.', false), 'geom.extrude')).toBeDefined()
    // a success that grows a note after its words is a new note about where the part went
    expect(differs(result('Extruded: step 1'), result(LANDED), 'geom.extrude')).toBeDefined()
  })

  it('says so when the replay gets a different number of results', () => {
    const got = asked(result('Started'))
    expect(divergence(3, [result('Started'), result('Extruded')], got)).toBe('replay diverged at request 3 (design.new): recorded 2 tool results, got 1')
  })

  it('does not check a request the recording kept no results for', () => {
    expect(divergence(2, undefined, asked(result('anything')))).toBeUndefined()
    expect(divergence(2, [], asked(result('anything')))).toBeUndefined()
  })

  const steps = [{ calls: [{ name: 'design.list', args: {} }] }, { text: 'Which size?' }]

  it('fails a creative replay at the first tool result that differs from the recording', async () => {
    const live = await runPrompt(P, { geom: undefined, steps, tabTools: true, defaultAnswer: false })
    expect(live.steps[1]?.seen).toHaveLength(1)
    expect(live.error).toBeUndefined()
    // the recording saw the list fail
    const stale = structuredClone(live.steps)
    stale[1]!.seen = [JSON.stringify({ ok: false, error: 'The shape no longer reaches the part.' })]
    const run = await runPrompt(P, { geom: undefined, steps: stale, tabTools: true, defaultAnswer: false })
    expect(run.error).toMatch(/^replay diverged at request 2 \(design\.list\): recorded failed "The shape no longer reaches the part\.", got ok "/)
  })

  it('passes a creative replay whose results match, and one from a recording that kept none', async () => {
    const live = await runPrompt(P, { geom: undefined, steps, tabTools: true, defaultAnswer: false })
    expect((await runPrompt(P, { geom: undefined, steps: live.steps, tabTools: true, defaultAnswer: false })).error).toBeUndefined()
    expect((await runPrompt(P, { geom: undefined, steps, tabTools: true, defaultAnswer: false })).error).toBeUndefined()
  })

  it('keeps the results in a recording file, and reads older files without them', () => {
    const base = { status: 'recorded', model: 'm', provider: 'p', capturedAt: '2026-11-08T00:00:00Z' }
    const rec = parseRecording(JSON.stringify({ ...base, steps: [{ calls: [{ name: 'design.list', args: {} }] }, { text: 'Done.', seen: ['{"ok":true}'] }] }))
    expect(rec.status === 'recorded' && rec.steps[1]?.seen).toEqual(['{"ok":true}'])
    expect(() => parseRecording(JSON.stringify({ ...base, steps: [{ text: 'x', seen: 'no' }] }))).toThrow(/seen must be a list/)
    const old = loadRecording('cable-organizer', RECORDINGS_DIR)
    expect(old.status === 'recorded' ? old.steps.some((s) => s.seen) : false).toBe(false)
  })
})
