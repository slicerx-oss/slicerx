// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the prompt says about building a request in full. A Pi case asked for in one message (base, standoffs, port
// cutouts, vents, a snap-fit lid) is one part with one sheet and one plan, built after one Go; a lid lies top down on
// the bed beside its base, not on top of it, so it prints open and flat.
import { describe, expect, it } from 'vitest'
import { systemPrompt } from '../src/prompt'

describe('the prompt builds what was asked in one plan', () => {
  for (const scope of ['full', 'cad'] as const) {
    it(`${scope}: one sheet and one plan for all of it, built after one Go`, () => {
      expect(systemPrompt(scope)).toContain('All the message asks for (a case with its lid, clips, standoffs and cutouts) is one part: one sheet with every size, one plan with every feature, all built after one Go without stopping between features.')
    })

    it(`${scope}: a lid prints open and flat beside the base`, () => {
      expect(systemPrompt(scope)).toContain('A lid or moving piece prints open and flat: a lid top down on the bed beside the base, 10 mm apart, never on top.')
    })
  }

  it('says neither where design.plan is not offered', () => {
    const has = (n: string) => n !== 'design.plan'
    expect(systemPrompt('full', has)).not.toContain('one plan with every feature')
  })
})
