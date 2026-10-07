// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Setup asks what the plate tab opens in (Slicing or CAD design) after the slicer screen, in editions with the modeling
// tools. The answer is written when setup finishes, a stored open step resumes on that screen, and editions without
// the modeling tools keep their two screens.
import { describe, expect, it } from 'vitest'
import { contractStep, initialFlow, normalizeStep, outcome, reduceFlow, setupSteps, stepLabel, type FlowEvent, type FlowState } from '../src/first-run/model'

const LOOK = { id: 'slicerx' as const }
const run = (s: FlowState, ...events: FlowEvent[]) => events.reduce(reduceFlow, s)

describe('the open step', () => {
  it('comes after the slicer screen in editions with the modeling tools, and not in the others', () => {
    expect(setupSteps({ cad: true, mimir: false })).toEqual(['printer', 'look', 'open'])
    expect(setupSteps({ cad: true, mimir: true })).toEqual(['printer', 'look', 'open', 'mimir'])
    expect(setupSteps({ cad: false, mimir: false })).toEqual(['printer', 'look'])
    expect(stepLabel('open', setupSteps({ cad: true, mimir: false })).text).toBe('Step 3 of 3, Opens in')
  })

  it('goes forward and back through it, keeping the choice', () => {
    const steps = setupSteps({ cad: true, mimir: false })
    let s = run(initialFlow('printer', LOOK, null, steps), { type: 'no-printer' }, { type: 'next' })
    expect(s.step).toBe('open')
    s = run(s, { type: 'pick-open', openIn: 'design' }, { type: 'back' })
    expect(s.step).toBe('look')
    s = run(s, { type: 'next' })
    expect(s.openIn).toBe('design')
  })

  it('writes the choice when setup finishes, and nothing when it is left', () => {
    const steps = setupSteps({ cad: true, mimir: false })
    const done = run(initialFlow('open', LOOK, null, steps), { type: 'pick-open', openIn: 'design' }, { type: 'next' })
    expect(done.closed).toBe('finished')
    expect(outcome(done, 'now', null).openIn).toBe('design')
    const left = run(initialFlow('open', LOOK, null, steps), { type: 'pick-open', openIn: 'design' }, { type: 'request-leave' }, { type: 'leave' })
    expect(outcome(left, 'now', null).openIn).toBeNull()
    // Skip, use defaults keeps what was there.
    const skipped = run(initialFlow('printer', LOOK, null, steps, 'design'), { type: 'skip-all' })
    expect(outcome(skipped, 'now', null).openIn).toBe('design')
  })

  it('without the modeling tools, finishing writes no choice', () => {
    const steps = setupSteps({ cad: false, mimir: false })
    const done = run(initialFlow('look', LOOK, null, steps), { type: 'next' })
    expect(outcome(done, 'now', null).openIn).toBeNull()
  })

  it('resumes on the open screen, and a run left on mimir resumes on it too', () => {
    const steps = setupSteps({ cad: true, mimir: true })
    expect(normalizeStep('open', steps)).toBe('open')
    expect(contractStep('open', steps)).toBe('open')
    expect(contractStep('mimir', steps)).toBe('open')
    // An edition without it lands on the slicer screen instead.
    expect(normalizeStep('open', setupSteps({ cad: false, mimir: false }))).toBe('look')
  })
})
