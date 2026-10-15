// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { brandSchema } from '../src/schema.ts'

const brand = { name: 'Harbor', logo: { mark: 'mark.svg' } }

describe('edition visual tokens', () => {
  it('keeps shared and separate light and dark overrides in the resolved config', () => {
    const theme = {
      base: 'subban',
      tokens: { colors: { purple: '#123456' }, visuals: { '--ti-sk': '#abcdef' } },
      light: { visuals: { '--accent': '#146676', '--stage-a1': '#aaddcc', '--glyph-picked-line': '#664400' } },
      dark: { colors: { purple: '#abcdef' }, visuals: { '--accent': '#77ddcc', '--glyph-halo': '#112233dd' } },
    }
    expect(brandSchema.parse({ ...brand, theme }).theme).toEqual(theme)
  })

  it('rejects unknown visual properties and non-color values', () => {
    for (const visuals of [{ '--stage-a9': '#123456' }, { '--width': '#123456' }, { '--accent': 'url(example.svg)' }, { '--accent': '#12345688' }]) {
      for (const location of ['tokens', 'light', 'dark']) {
        expect(brandSchema.safeParse({ ...brand, theme: { base: 'subban', [location]: { visuals } } }).success, JSON.stringify({ location, visuals })).toBe(false)
      }
    }
  })

  it('keeps the default theme unchanged', () => {
    expect(brandSchema.parse(brand).theme).toBe('subban')
  })
})
