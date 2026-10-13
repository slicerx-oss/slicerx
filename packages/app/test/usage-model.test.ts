// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { chartBars, leftPercent, resetsIn, usedPercent } from '../src/pilot-connect/usage-model'
import { usageFromQuota } from '../src/pilot-connect/usage-quota'

describe('usage model', () => {
  it('shows what is left, and left and used always add up to 100', () => {
    expect([leftPercent(0.62), leftPercent(0.31), leftPercent(0), leftPercent(1)]).toEqual([38, 69, 100, 0])
    for (const used of [0.004, 0.125, 0.5, 0.995, -1, 3, Number.NaN]) expect(leftPercent(used) + usedPercent(used)).toBe(100)
    expect([usedPercent(-1), usedPercent(3), usedPercent(Number.NaN)]).toEqual([0, 100, 0])
  })

  it('says when today resets in hours and minutes, with the clock', () => {
    const now = new Date('2026-10-13T18:48:00Z')
    expect(resetsIn('2026-10-14T00:00:00Z', now, 'en-US', 'UTC')).toBe('Resets in 5 h 12 min (12:00 AM)')
    expect(resetsIn('2026-10-13T19:00:00Z', now, 'en-US', 'UTC')).toBe('Resets in 12 min (7:00 PM)')
    expect(resetsIn('2026-10-13T18:00:00Z', now, 'en-US', 'UTC')).toBe('Resets in 0 min (6:00 PM)')
    expect(resetsIn('not a time', now)).toBe('')
  })

  it("takes the server's reset and shows it on each person's own clock", () => {
    // a reset at midnight in Melbourne (14:00 UTC during standard time) is the afternoon in Los Angeles and
    // midnight in Melbourne; the time left is the same everywhere
    const now = new Date('2026-07-01T09:00:00Z')
    const at = '2026-07-01T14:00:00Z'
    expect(resetsIn(at, now, 'en-US', 'Australia/Melbourne')).toBe('Resets in 5 h 0 min (12:00 AM)')
    expect(resetsIn(at, now, 'en-US', 'America/Los_Angeles')).toBe('Resets in 5 h 0 min (7:00 AM)')
    expect(resetsIn(at, now, 'en-US', 'Europe/London')).toBe('Resets in 5 h 0 min (3:00 PM)')
  })

  it('names the day when the reset is a day or more away', () => {
    const now = new Date('2026-10-13T00:00:00Z')
    expect(resetsIn('2026-10-15T03:00:00Z', now, 'en-US', 'UTC')).toBe('Resets in 2 d 3 h (Thu 3:00 AM)')
  })

  it('draws the last 24 hours or 7 days against the busiest one, and an empty stretch flat', () => {
    const bars = chartBars([0.5, 0.25, ...Array(22).fill(0)], 24)
    expect(bars).toHaveLength(24)
    expect(bars.slice(0, 2)).toEqual([1, 0.5])
    expect(chartBars([], 24)).toEqual(Array(24).fill(0))
    expect(chartBars([...Array(30).fill(0), 0.1], 24)[23]).toBe(1)
    expect(chartBars([0.2, 0.4, 0.8], 7)).toEqual([0, 0, 0, 0, 0.25, 0.5, 1])
  })
})

describe('the usage report under v2 in /quota', () => {
  const report = {
    day: { used: 0.62, resetsAt: '2026-10-14T13:00:00Z' },
    week: { used: 0.31, resetsAt: '2026-10-14T13:00:00Z' },
    hourly: [0, 0.1, 'x', null],
    daily: [0.4, 0.9, 0.62],
    perMinute: { limit: 10 },
  }

  const quota = (v2: unknown) => ({ edition: 'slicerx', day: '2026-10-14', installUsed: 1, installCap: 2, editionOpen: true, v2 })

  it('reads the agreed fields', () => {
    // there is no weekly limit, so the week's share is not read
    expect(usageFromQuota(quota(report))).toEqual({ day: report.day, hourly: [0, 0.1, 0, 0], daily: [0.4, 0.9, 0.62], perMinute: { limit: 10 } })
  })

  it('reads a report missing a part, or of another shape, as no report', () => {
    expect(usageFromQuota(null)).toBeNull()
    expect(usageFromQuota(report)).toBeNull()
    expect(usageFromQuota(quota(undefined))).toBeNull()
    expect(usageFromQuota(quota({ ...report, day: { used: 0.5, resetsAt: 'soon' } }))).toBeNull()
    expect(usageFromQuota(quota({ ...report, perMinute: {} }))).toBeNull()
  })

  it('takes a report with no hours as an empty day, and one with no days as having none', () => {
    expect(usageFromQuota(quota({ ...report, hourly: undefined }))?.hourly).toEqual([])
    expect(usageFromQuota(quota({ ...report, daily: undefined }))).not.toHaveProperty('daily')
  })
})
