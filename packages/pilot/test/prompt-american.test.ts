// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The reply rules ask for American spelling, so a sheet row reads "centerline" and not "centreline". The line is in the
// prompt of the full app and of the browser build, with or without the design tools.
import { describe, expect, it } from 'vitest'
import { AMERICAN_LINE, systemPrompt } from '../src/prompt'

describe('the prompt asks for American spelling', () => {
  it('says it in one short line with examples', () => {
    expect(AMERICAN_LINE).toBe('Write American spelling in replies, sheet rows and plan names (center, color, aluminum, gray, meter).')
    expect(AMERICAN_LINE.length).toBeLessThan(120)
  })

  for (const scope of ['full', 'cad'] as const) {
    for (const design of [true, false]) {
      it(`${scope}${design ? '' : ' without design tools'}: the line is in the prompt once`, () => {
        const text = systemPrompt(scope, (name) => (design ? true : name !== 'design.new'))
        expect(text.split(AMERICAN_LINE).length - 1).toBe(1)
      })
    }
  }
})
