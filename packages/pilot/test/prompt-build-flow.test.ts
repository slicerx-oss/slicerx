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
      const text = systemPrompt(scope)
      for (const key of ['is one part', 'one sheet with every size', 'one plan with every feature', 'after one Go']) expect(text).toContain(key)
    })

    it(`${scope}: a lid prints open and flat beside the base`, () => {
      const text = systemPrompt(scope)
      for (const key of ['prints open and flat', 'beside the base', 'never on top']) expect(text).toContain(key)
    })
  }

  it('says neither where design.plan is not offered', () => {
    const has = (n: string) => n !== 'design.plan'
    const text = systemPrompt('full', has)
    expect(text).not.toContain('one plan with every feature')
    expect(text).not.toContain('prints open and flat')
  })
})
