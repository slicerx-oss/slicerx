// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the prompt says about building a request in full. A Pi case asked for in one message (base, standoffs, port
// cutouts, vents, a snap-fit lid) is one design with one sheet and one plan, built after one Go; a lid lies top down on
// the bed beside its base, not on top of it, so it prints open and flat.
import { describe, expect, it } from 'vitest'
import { systemPrompt } from '../src/prompt'

describe('the prompt builds what was asked in one plan', () => {
  for (const scope of ['full', 'cad'] as const) {
    it(`${scope}: one sheet and one plan for all of it, built after one Go`, () => {
      const text = systemPrompt(scope)
      expect(text).toContain('Each thing the message asks for that is its own part (a planter and a saucer) gets its own design.')
      expect(text).toMatch(/is one design: one sheet with every size, one plan with every feature, all built after one Go without stopping between features\./)
      expect(text).toContain('Never restart the part you started under a new name; fix it with the design tools.')
    })

    // A planter and a saucer asked for in one message: after the planter's Go, mimir asked "Plan the planter saucer
    // next?" with a card of its own. The saucer was asked for already, so mimir goes on to it without asking.
    it(`${scope}: separate parts asked for are each built in turn, with no question about the next one`, () => {
      const text = systemPrompt(scope)
      expect(text).toContain('Each thing the message asks for that is its own part (a planter and a saucer) gets its own design. Once one is built and checked, go on to the next at once: plan it, or build it when it needs no plan. Never ask whether to do a part the message already asked for.')
    })

    it(`${scope}: a lid prints open and flat, on its hinge when it prints in place, beside the base when put on after`, () => {
      const text = systemPrompt(scope, undefined, '', { cloud: true })
      expect(text).toContain('A lid planned with its case stays in that design, and a lid or moving piece prints open and flat')
      // option a (owner, 2026-11-12): a print in place lid prints open on its hinge; 10 mm apart only for a lid put on after.
      // A local model keeps the one rule it had; design.plan refuses a print in place lid laid apart for either.
      expect(systemPrompt(scope)).toContain('A lid planned with its case stays in that design, and a lid or moving piece prints open and flat: a lid top down on the bed beside the base, 10 mm apart, never on top.')
      expect(text).toContain("a lid that prints in place on its hinge lies open flat on the shared hinge axis, its knuckles between the base's, never apart; a lid put on after printing lies top down on the bed beside the base, 10 mm apart, never on top.")
    })
  }

  for (const scope of ['full', 'cad'] as const)
    it(`${scope}: every step of a planned feature names that feature, so the check ties it to the plan`, () => {
      expect(systemPrompt(scope)).toContain('- On every step of a planned feature, pass feature with its name exactly as the plan has it. Leave it off finishing steps the plan does not list.')
    })

  it('says none of it where design.plan is not offered', () => {
    const has = (n: string) => n !== 'design.plan'
    const text = systemPrompt('full', has)
    expect(text).not.toContain('one plan with every feature')
    expect(text).not.toContain('prints open and flat')
    expect(text).not.toContain('pass feature')
  })
})
