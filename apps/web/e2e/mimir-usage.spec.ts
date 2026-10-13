// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Account > Usage: what is left of today's free mimir and when it resets, and use over the last 24 hours and
// the last 7 days (charts only: there is no weekly limit). It shows only while mimir runs on mimir cloud, never names a
// price, and fits a phone.
import type { Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

async function noHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

type Report = 'loaded' | 'loading' | 'out' | 'none' | 'no-days'

/** Stands in for mimir cloud and its /quota (v1 fields, the usage report under v2) through the debug hook in pilot-connect/cloud.ts, before the app renders. */
async function setUp(page: Page, provider: 'mimir-cloud' | 'anthropic', report: Report): Promise<void> {
  await page.addInitScript(
    ([provider, report]) => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'on', provider } }))
      const now = Date.now()
      const usage = {
        day: { used: report === 'out' ? 1 : 0.62, resetsAt: new Date(now + (5 * 60 + 12) * 60_000 + 30_000).toISOString() },
        week: { used: 0.31, resetsAt: new Date(now + 4 * 86400_000).toISOString() },
        hourly: [...Array(20).fill(0), 0.05, 0.1, 0.02, 0.01],
        ...(report === 'no-days' ? {} : { daily: [0.2, 0, 0.5, 0.9, 0.3, 0.1, 0.62] }),
        perMinute: { limit: 10 },
      }
      const v1 = { edition: 'slicerx', day: '2026-10-13', installUsed: 0, installCap: 500000, ipUsed: 0, ipCap: 2000000, editionOpen: true }
      const quota = () => (report === 'loading' ? new Promise(() => undefined) : Promise.resolve(report === 'none' ? v1 : { ...v1, v2: usage }))
      const h = { quota, forget: async () => 0, register: async () => undefined }
      Object.defineProperty(window, '__sxMimirCloud', { configurable: true, set: (fn: (h: unknown, base: string) => void) => fn(h, 'https://cloud.example.invalid/functions/v1/mimir') })
    },
    [provider, report] as const,
  )
}

async function openAccount(page: Page): Promise<void> {
  await page.goto('./')
  await plateReady(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Account' }).click()
  await expect(dialog.getByRole('heading', { name: 'Account' })).toBeVisible()
}

test('on free mimir, Account shows what is left today, use over the last 24 hours and 7 days, and the per-minute limit', async ({ page }) => {
  await setUp(page, 'mimir-cloud', 'loaded')
  await openAccount(page)
  const usage = page.getByTestId('mu-section')
  await expect(usage.getByRole('heading', { name: 'Usage' })).toBeVisible()
  await expect(page.getByTestId('mu-today-left')).toHaveText('38%')
  await expect(page.getByTestId('mu-today-bar')).toHaveAttribute('aria-valuenow', '38')
  await expect(usage.getByText('Free mimir has a daily limit.')).toBeVisible()
  await expect(usage.getByText('Last 7 days', { exact: true })).toBeVisible()
  await expect(page.getByTestId('mu-days').locator('i')).toHaveCount(7)
  // the hours and days are use only: the one share on the page is today's
  await expect(usage.getByText(/%/)).toHaveCount(1)
  await expect(usage.getByRole('meter')).toHaveCount(1)
  await expect(page.getByTestId('mu-today-reset')).toHaveText(/^Resets in 5 h 1[23] min \(\d{1,2}:\d{2}\s?[AP]M\)$/)
  // only today resets
  await expect(usage.getByText(/^Resets in /)).toHaveCount(1)
  await expect(page.getByTestId('mu-hours').locator('i')).toHaveCount(24)
  await expect(page.getByTestId('mu-rate')).toHaveText('Up to 10 messages a minute.')
  await expect(page.getByTestId('mu-today-out')).toHaveCount(0)
  await expect(usage).not.toContainText(/\$|used\b|left this week|7-day limit/)
  await noHorizontalScroll(page)
})

test('while the report loads, the section keeps its final size with placeholders', async ({ page }) => {
  await setUp(page, 'mimir-cloud', 'loading')
  await openAccount(page)
  const usage = page.getByTestId('mu-section')
  await expect(usage).toHaveAttribute('aria-busy', 'true')
  // the placeholder charts have a shape, not a flat line
  for (const [id, n] of [['mu-hours', 24], ['mu-days', 7]] as const) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-loading', 'true')
    const heights = await page.getByTestId(id).locator('i').evaluateAll((bars) => bars.map((b) => b.getBoundingClientRect().height))
    expect(heights).toHaveLength(n)
    expect(Math.max(...heights), id).toBeGreaterThan(Math.min(...heights) + 4)
  }
  for (const id of ['mu-today-left', 'mu-today-reset', 'mu-rate']) {
    const box = await page.getByTestId(id).boundingBox()
    expect(box?.height ?? 0, id).toBeGreaterThan(10)
  }
  await noHorizontalScroll(page)
})

test('with today used up, it says so and when it comes back', async ({ page }) => {
  await setUp(page, 'mimir-cloud', 'out')
  await openAccount(page)
  await expect(page.getByTestId('mu-today-left')).toHaveText('0%')
  await expect(page.getByTestId('mu-today-out')).toBeVisible()
  await expect(page.getByTestId('mu-today-reset')).toHaveText(/^Resets in /)
  await expect(page.getByTestId('mu-days').locator('i')).toHaveCount(7)
})

test('with a proxy that sends no days yet, the last 7 days row stays out', async ({ page }) => {
  await setUp(page, 'mimir-cloud', 'no-days')
  await openAccount(page)
  await expect(page.getByTestId('mu-hours').locator('i')).toHaveCount(24)
  await expect(page.getByTestId('mu-days')).toHaveCount(0)
})

test('on a key of your own, Account has no usage section', async ({ page }) => {
  await setUp(page, 'anthropic', 'loaded')
  await openAccount(page)
  await expect(page.getByTestId('mu-section')).toHaveCount(0)
})

test('with a proxy that sends no usage report, Account has no usage section', async ({ page }) => {
  await setUp(page, 'mimir-cloud', 'none')
  await openAccount(page)
  await expect(page.getByTestId('mu-section')).toHaveCount(0)
})

test('with no mimir cloud in the build, Account has no usage section', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'on', provider: 'mimir-cloud' } }))
  })
  await openAccount(page)
  await expect(page.getByTestId('mu-section')).toHaveCount(0)
})
