// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A print time whose minutes round up to a whole hour reads as the next hour, never as 60 minutes.
import { describe, expect, it } from 'vitest'
import { formatDuration } from '../src/lib/preview-stats'

describe('formatDuration carries a rounded hour', () => {
  it('reads 2 h 59.6 min as 3h 0m', () => {
    expect(formatDuration(10776)).toBe('3h 0m')
  })
  it('reads 59.6 min as 1h 0m', () => {
    expect(formatDuration(3576)).toBe('1h 0m')
  })
  it('never shows 60 minutes', () => {
    for (let s = 1; s < 6 * 3600; s += 7) expect(formatDuration(s)).not.toMatch(/\b60m$/)
  })
  it('keeps the times it read before', () => {
    expect(formatDuration(8605)).toBe('2h 23m')
    expect(formatDuration(5400)).toBe('1h 30m')
    expect(formatDuration(3600)).toBe('1h 0m')
    expect(formatDuration(600)).toBe('10m')
    expect(formatDuration(12)).toBe('12 s')
    expect(formatDuration(0)).toBe('0m')
  })
})
