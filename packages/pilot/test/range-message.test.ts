// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { evalKb } from '../evals/harness'
import { checkChanges } from '../skills/optimize_to_target/proxy'
import type { KnowledgeBase } from '../src/kb/kb'

// A knowledge base with one setting bounded below only and one bounded above only.
const oneSided = {
  setting: (k: string) => ({ low_only: { key: k, unit: 'mm', bounds: { min: 0.01 } }, high_only: { key: k, unit: 'C', bounds: { max: 300 } } })[k],
} as unknown as KnowledgeBase

describe('rejected values', () => {
  it('name only the limit a setting has', () => {
    expect(checkChanges(oneSided, { low_only: 0 }).rejected).toEqual(['low_only is 0; it must be at least 0.01 mm.'])
    expect(checkChanges(oneSided, { high_only: 400 }).rejected).toEqual(['high_only is 400; it must be at most 300 C.'])
  })

  it('keep both limits when a setting has both', () => {
    expect(checkChanges(evalKb(), { layer_height: 5 }).rejected).toEqual(['layer_height is 5, outside 0.04 to 0.8 mm.'])
  })
})
