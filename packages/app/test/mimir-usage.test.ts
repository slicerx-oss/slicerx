// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Account > Usage: what is left of today's free mimir and when it resets, and use over the last 24 hours and
// the last 7 days (charts only: there is no weekly limit). It shows only while mimir runs on mimir cloud and the proxy
// sends a report, and never names a price. Moved from the mimir-usage Playwright spec; the phone checks (the section
// keeps its size while loading, no sideways scroll) are measured in a real layout, in phone-responsive.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditionConfig } from '@slicerx/edition-config'
import { EditionContext, NEUTRAL } from '../src/edition'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { MimirUsageSection } from '../src/pilot-connect/usage'
import { set } from '../src/state/store'

const CLOUD: EditionConfig = { ...NEUTRAL, ai: { ...NEUTRAL.ai, keySource: 'cloud' as const }, backend: { ...NEUTRAL.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } }

type Report = 'loaded' | 'loading' | 'out' | 'none' | 'no-days'

/** mimir cloud's /quota: the v1 fields, and the usage report under v2. */
function stand(report: Report): void {
  const now = Date.now()
  const v2 = {
    day: { used: report === 'out' ? 1 : 0.62, resetsAt: new Date(now + (5 * 60 + 12) * 60_000 + 30_000).toISOString() },
    week: { used: 0.31, resetsAt: new Date(now + 4 * 86400_000).toISOString() },
    hourly: [...Array(20).fill(0), 0.05, 0.1, 0.02, 0.01],
    ...(report === 'no-days' ? {} : { daily: [0.2, 0, 0.5, 0.9, 0.3, 0.1, 0.62] }),
    perMinute: { limit: 10 },
  }
  const v1 = { edition: 'slicerx', day: '2026-10-13', installUsed: 0, installCap: 500000, ipUsed: 0, ipCap: 2000000, editionOpen: true }
  const quota = () => (report === 'loading' ? new Promise(() => undefined) : Promise.resolve(report === 'none' ? v1 : { ...v1, v2 }))
  registerMimirCloud({ quota, forget: async () => 0, register: async () => undefined } as never)
}

beforeEach(() => {
  set({ pilot: { mode: 'on', provider: 'mimir-cloud' } })
})

afterEach(() => {
  cleanup()
  registerMimirCloud(null)
  set({ pilot: { mode: 'off' } })
})

const show = async (edition = CLOUD) => void (await act(async () => void render(createElement(EditionContext.Provider, { value: edition }, createElement(MimirUsageSection)))))
const bars = (id: string) => [...screen.getByTestId(id).querySelectorAll('i')]

describe('Account > Usage on free mimir', () => {
  it('shows what is left today, use over the last 24 hours and 7 days, and the per-minute limit', async () => {
    stand('loaded')
    await show()
    const usage = screen.getByTestId('mu-section')
    await waitFor(() => expect(screen.getByTestId('mu-today-left').textContent).toBe('38%'))
    expect(usage.querySelector('h3')?.textContent).toBe('Usage')
    expect(screen.getByTestId('mu-today-bar').getAttribute('aria-valuenow')).toBe('38')
    expect(usage.textContent).toContain('Free mimir has a daily limit.')
    expect(usage.textContent).toContain('Last 7 days')
    expect(bars('mu-days')).toHaveLength(7)
    expect(bars('mu-hours')).toHaveLength(24)
    // the hours and days are use only: the one share on the page is today's, and the one reset
    expect(usage.textContent?.match(/%/g)).toHaveLength(1)
    expect(usage.querySelectorAll('[role="meter"]')).toHaveLength(1)
    expect(screen.getByTestId('mu-today-reset').textContent).toMatch(/^Resets in 5 h 1[23] min \(\d{1,2}:\d{2}\s?[AP]M\)$/)
    expect(usage.textContent?.match(/Resets in /g)).toHaveLength(1)
    expect(screen.getByTestId('mu-rate').textContent).toBe('Up to 10 messages a minute.')
    expect(screen.queryByTestId('mu-today-out')).toBeNull()
    expect(usage.textContent).not.toMatch(/\$|used\b|left this week|7-day limit/)
  })

  it('while the report loads, keeps its final shape with placeholder charts', async () => {
    stand('loading')
    await show()
    const usage = screen.getByTestId('mu-section')
    expect(usage.getAttribute('aria-busy')).toBe('true')
    for (const [id, n] of [['mu-hours', 24], ['mu-days', 7]] as const) {
      expect(screen.getByTestId(id).getAttribute('data-loading')).toBe('true')
      // the placeholder bars have a shape, not a flat line
      const heights = bars(id).map((b) => parseFloat(b.style.height))
      expect(heights, id).toHaveLength(n)
      expect(Math.max(...heights), id).toBeGreaterThan(Math.min(...heights) + 4)
    }
    for (const id of ['mu-today-left', 'mu-today-reset', 'mu-rate']) expect(screen.getByTestId(id).getAttribute('data-loading'), id).toBe('true')
  })

  it('with today used up, says so and when it comes back', async () => {
    stand('out')
    await show()
    await waitFor(() => expect(screen.getByTestId('mu-today-left').textContent).toBe('0%'))
    expect(screen.getByTestId('mu-today-out')).toBeTruthy()
    expect(screen.getByTestId('mu-today-reset').textContent).toMatch(/^Resets in /)
    expect(bars('mu-days')).toHaveLength(7)
  })

  it('leaves the last 7 days row out for a proxy that sends no days yet', async () => {
    stand('no-days')
    await show()
    await waitFor(() => expect(bars('mu-hours')).toHaveLength(24))
    expect(screen.queryByTestId('mu-days')).toBeNull()
  })
})

describe('Account > Usage elsewhere', () => {
  it('is not there on a key of your own', async () => {
    stand('loaded')
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    await show()
    expect(screen.queryByTestId('mu-section')).toBeNull()
  })

  it('is not there when the proxy sends no usage report', async () => {
    stand('none')
    await show()
    await act(async () => new Promise<void>((r) => setTimeout(r, 20)))
    expect(screen.queryByTestId('mu-section')).toBeNull()
  })

  it('is not there when the build has no mimir cloud', async () => {
    stand('loaded')
    await show(NEUTRAL)
    expect(screen.queryByTestId('mu-section')).toBeNull()
  })
})
