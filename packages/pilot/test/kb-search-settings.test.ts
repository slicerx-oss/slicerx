// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// kb.search finds a setting by the words people and the knowledge base use for it, not only by its current label.
import { describe, expect, it } from 'vitest'
import { settingsForQuery } from '../src/tools/kb'
import { evalKb } from '../evals/harness'

describe('settings named in a kb.search query', () => {
  const settings = evalKb().settings()
  const keys = (q: string) => settingsForQuery(settings, q).map((s) => s.key)

  it('finds a setting by its key, with or without underscores', () => {
    expect(keys('what is filament_max_volumetric_speed')).toContain('filament_max_volumetric_speed')
    expect(keys('what is filament max volumetric speed')).toContain('filament_max_volumetric_speed')
  })

  it('finds a setting by the end of its key, as the knowledge base words it', () => {
    expect(keys('what max volumetric speed for PETG')).toContain('filament_max_volumetric_speed')
    expect(keys('what is the small perimeter speed')).toContain('small_perimeter_speed')
  })

  it('finds a setting by its label', () => {
    expect(keys('what does small wall speed do')).toContain('small_perimeter_speed')
    expect(keys('set the maximum volumetric speed')).toContain('filament_max_volumetric_speed')
  })

  it('names nothing for a question with no setting in it', () => {
    expect(keys('how do I dry petg')).toEqual([])
  })
})
