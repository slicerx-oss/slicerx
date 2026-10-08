// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model icons keep the set's contract: every grouped name drawn at 24 and at 16 (icons/small.mjs checks the 16px
// rules), no fills but dots, nothing outside the grid, and no step or tree row sharing an icon with another.
import { describe, expect, it } from 'vitest'
import { MODEL_ICON_GROUPS, MODEL_ICONS } from '../icons/model.mjs'
import { SMALL_ICONS } from '../icons/small.mjs'

const names = Object.values(MODEL_ICON_GROUPS).flat()
const numbers = (markup: string) => [...markup.matchAll(/\b(?:d|x|y|cx|cy|width|height)="([^"]+)"/g)].flatMap((m) => m[1]!.match(/-?\d*\.?\d+/g) ?? []).map(Number)

describe('the Model icons', () => {
  it('group every drawing once, and draw each at 16 too', () => {
    expect(new Set(names).size).toBe(names.length)
    expect(Object.keys(MODEL_ICONS).sort()).toEqual([...names].sort())
    for (const n of names) expect(SMALL_ICONS, n).toHaveProperty(n)
  })

  it('fill only dots, and stay on the 24px grid', () => {
    for (const [n, markup] of Object.entries(MODEL_ICONS)) {
      for (const tag of markup.match(/<[^>]*fill="currentColor"[^>]*>/g) ?? []) expect(tag, n).toMatch(/^<circle/)
      for (const v of numbers(markup)) expect(Math.abs(v), n).toBeLessThanOrEqual(24)
    }
  })

  it('give no two drawings the same art', () => {
    const big = Object.values(MODEL_ICONS)
    expect(new Set(big).size).toBe(big.length)
    const small = names.map((n) => SMALL_ICONS[n as keyof typeof SMALL_ICONS])
    expect(new Set(small).size).toBe(small.length)
  })
})
