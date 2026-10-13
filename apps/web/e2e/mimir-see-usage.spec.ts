// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// See usage on a mimir cloud refusal, against a stubbed proxy: a used-up day (day_used), the edition's day
// (edition_day_used) or the per-minute limit (slow_down) puts See usage on the chat's error line, and pressing it opens
// Settings at Account with the Usage section in view. Other refusals show no link. The proxy's own codes are tested in
// supabase/functions/mimir.
import { type Page, type Route } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type W = { __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string | null): unknown }
type Sx = { __sx: { setState(p: unknown): void } }

// a stand-in session token: the stub checks only that it arrives
const SESSION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlMmUifQ.c2ln'

const MESSAGES: Record<string, [number, string]> = {
  day_used: [429, "You've used today's free mimir. It resets in 5 h 12 min."],
  edition_day_used: [429, 'Free mimir is busy for today. It resets in 5 h 12 min.'],
  slow_down: [429, 'Slow down a moment, then try again.'],
  paused: [503, 'Free mimir is paused right now. We know and are fixing it. Your own key or a local model still works.'],
}

/** The proxy, on the page's own origin: every message is refused with `code`, and the quota reports today used up. */
async function stubProxy(page: Page, code: keyof typeof MESSAGES): Promise<void> {
  const [status, message] = MESSAGES[code]!
  await page.route('**/functions/v1/mimir/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const at = path.slice(path.indexOf('/mimir') + '/mimir'.length)
    if (at === '/quota') {
      const now = Date.now()
      const v2 = {
        day: { used: 1, resetsAt: new Date(now + (5 * 60 + 12) * 60_000 + 30_000).toISOString() },
        hourly: [...Array(20).fill(0), 0.3, 0.4, 0.2, 0.1],
        daily: [0.2, 0, 0.5, 0.9, 0.3, 0.1, 1],
        perMinute: { limit: 10 },
      }
      return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-13', install_used: 250000, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true, v2 } })
    }
    if (at === '/v1/messages') return route.fulfill({ status, json: { type: 'error', error: { type: status === 429 ? 'mimir_limit' : 'overloaded_error', code, message } } })
    return route.fulfill({ status: 404, json: { type: 'error', error: { type: 'not_found_error', code: 'not_found', message: 'No such mimir route.' } } })
  })
}

/** Opens the dock on mimir cloud, signed in through the build's browser host pointed at the stub, and asks once. */
async function askAndRefuse(page: Page, code: keyof typeof MESSAGES): Promise<void> {
  await stubProxy(page, code)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('sx-mimir-dock', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'mimir-cloud' } }))
  })
  await page.goto('./')
  await viewportReady(page)
  await page.evaluate((token) => {
    const w = window as unknown as W
    const base = `${location.origin}/functions/v1/mimir`
    w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
  }, SESSION)
  await page.evaluate(() => (window as unknown as Sx).__sx.setState({ pilotPrompt: 'a 20 mm cube' }))
  await page.getByTestId('mimir-notice-ok').click()
  const line = page.locator('.mimir-dock').getByTestId('mimir-limit')
  await expect(line).toHaveAttribute('data-code', code, { timeout: 30_000 })
  await expect(line).toContainText(MESSAGES[code]![1])
}

test.describe('See usage on a mimir cloud refusal', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only: the dock is where the chat runs here')

  test('a used-up day links to Settings > Account with Usage in view', async ({ page }) => {
    await askAndRefuse(page, 'day_used')
    const link = page.locator('.mimir-dock').getByTestId('mimir-see-usage')
    await expect(link).toHaveText('See usage')
    await page.locator('.mimir-dock').screenshot({ path: test.info().outputPath('mimir-see-usage-line.png') })
    await link.click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByRole('heading', { name: 'Account' })).toBeVisible()
    // the account above loads after the section draws; Usage stays at the top of the pane with the used-up line in full view
    await expect(dialog.getByText('You have no API tokens.')).toBeAttached()
    await expect(dialog.getByRole('heading', { name: 'Usage' })).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('mu-today-left')).toHaveText('0%')
    await expect(page.getByTestId('mu-today-out')).toBeInViewport({ ratio: 1 })
    // only the section's own pane scrolls: the nav stays put, with Account shown as the current section
    const account = dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Account' })
    await expect(account).toHaveAttribute('aria-current', 'true')
    await expect(account).toBeInViewport({ ratio: 1 })
    const nav = await dialog.getByRole('navigation', { name: 'Settings sections' }).boundingBox()
    const body = await dialog.locator('.sx-dialog-body').first().boundingBox()
    expect(nav!.y).toBeGreaterThanOrEqual(body!.y - 1)
    await page.screenshot({ path: test.info().outputPath('mimir-see-usage-account.png') })
  })

  for (const code of ['edition_day_used', 'slow_down'] as const) {
    test(`${code} links to usage too`, async ({ page }) => {
      await askAndRefuse(page, code)
      await page.locator('.mimir-dock').getByTestId('mimir-see-usage').click()
      await expect(page.getByTestId('mu-today-out')).toBeInViewport({ ratio: 1 })
    })
  }

  test('a pause has no usage link', async ({ page }) => {
    await askAndRefuse(page, 'paused')
    await expect(page.locator('.mimir-dock').getByTestId('mimir-see-usage')).toHaveCount(0)
  })
})
