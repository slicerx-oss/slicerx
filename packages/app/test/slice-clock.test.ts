// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { sliceClock } from '../../core/web/src/clock'

describe('the slice clock', () => {
  it('gives the time in seconds and the local offset in minutes east of UTC', () => {
    const c = sliceClock(new Date('2026-09-30T12:00:00Z'))
    expect(c.nowUnix).toBe(Date.UTC(2026, 8, 30, 12) / 1000)
    expect(Number.isInteger(c.nowOffsetMinutes)).toBe(true)
    expect(c.nowOffsetMinutes).toBe(-new Date('2026-09-30T12:00:00Z').getTimezoneOffset() || 0)
  })
})
