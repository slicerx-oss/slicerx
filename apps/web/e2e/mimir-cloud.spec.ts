// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud before the first chat: the one-time notice in the mimir tab (what is sent, what is kept, the share switch)
// and Settings > mimir's share switch and delete control. The web build has no cloud shell, so the test stands one in
// through the debug hook. Controls stay put when pressed. A screenshot of the notice goes to the test output for review.
import { type Locator, type Page } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type Sx = { setState(p: unknown): void; getState(): { mimirShare: boolean; mimirNotice: number | null } }
type W = { __sx: Sx; __sxMimirCloud(h: unknown, base: string): void }

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'unset' } }))
  })
  await page.goto('./')
  await viewportReady(page)
  await standIn(page)
}

/** A mimir cloud shell: the quota, and a forget that deleted three sessions. */
async function standIn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const quota = { edition: 'slicerx', day: '2026-10-12', installUsed: 0, installCap: 500000, ipUsed: 0, ipCap: 2000000, editionOpen: true }
    ;(window as unknown as W).__sxMimirCloud({ quota: async () => quota, forget: async () => 3, register: async () => undefined }, 'http://127.0.0.1:9/functions/v1/mimir')
  })
}

const state = (page: Page) => page.evaluate(() => (window as unknown as W).__sx.getState())

/** Presses a control and checks that it and the others named stay where they were. */
async function pressStill(target: Locator, others: Locator[]): Promise<void> {
  const all = [target, ...others]
  // in view first, so the click's own scroll is not taken for a shift
  await target.scrollIntoViewIfNeeded()
  const before = await Promise.all(all.map((l) => l.boundingBox()))
  await target.click()
  const after = await Promise.all(all.map((l) => l.boundingBox()))
  expect(after).toEqual(before)
}

test.describe('mimir cloud', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only: phones have no modeling tabs')

  test('in the dock, the header, the notice, the chat and its composer span the dock', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('sx-mimir-dock', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'mimir-cloud' } }))
      const h = { quota: async () => ({ edition: 'slicerx', day: '2026-10-13', installUsed: 0, installCap: 1000000, ipUsed: 0, ipCap: 2000000, editionOpen: true }), forget: async () => 0, register: async () => undefined }
      Object.defineProperty(window, '__sxMimirCloud', { configurable: true, set: (fn: (h: unknown, base: string) => void) => fn(h, 'http://127.0.0.1:9/functions/v1/mimir') })
    })
    await page.goto('./')
    await viewportReady(page)
    const notice = page.locator('.mimir-dock').getByTestId('mimir-cloud-notice')
    await expect(notice).toBeVisible()
    const dock = await page.locator('.mimir-dock').boundingBox()
    const box = await notice.boundingBox()
    // below the dock's header, nearly its full width, and no taller than the dock
    expect(box!.width).toBeGreaterThan(dock!.width * 0.8)
    expect(box!.y + box!.height).toBeLessThanOrEqual(dock!.y + dock!.height)
    // the header spans it too: the dock is one column, not the chat page's three
    expect((await page.locator('.mimir-dock > .mimir-head').boundingBox())!.width).toBeGreaterThan(dock!.width - 2)
    await expect(page.locator('.mimir-dock').getByTestId('mimir-notice-ok')).toBeInViewport()
    await page.locator('.mimir-dock').screenshot({ path: test.info().outputPath('mimir-dock-notice.png') })
    // and so does the chat once the notice is read
    await page.locator('.mimir-dock').getByTestId('mimir-notice-ok').click()
    const term = page.locator('.mimir-dock > .term')
    await expect(term).toBeVisible()
    expect((await term.boundingBox())!.width).toBeGreaterThan(dock!.width - 2)
    const composer = page.locator('.mimir-dock').getByTestId('mimir-composer')
    await expect(composer).toBeVisible()
    expect((await composer.boundingBox())!.width).toBeGreaterThan(dock!.width * 0.85)
    await page.locator('.mimir-dock').screenshot({ path: test.info().outputPath('mimir-dock-chat.png') })
  })

  test('the mimir tab shows the notice once before the first chat', async ({ page }) => {
    await open(page)
    await page.getByTestId('tab-mimir').click()
    const notice = page.getByTestId('mimir-cloud-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(/mimir in \S+ runs on a cloud model provider\. Your messages, photos and the parts mimir works on go to the provider/)
    await expect(notice).toContainText(/keeps your mimir sessions for 180 days to improve mimir/)
    await expect(page.locator('.mimir-empty')).toHaveCount(0)
    // for review: the notice in the chat column
    await page.getByTestId('mimir-chat').screenshot({ path: test.info().outputPath('mimir-cloud-notice.png') })

    const share = page.getByTestId('mimir-notice-share')
    const start = page.getByTestId('mimir-notice-ok')
    await expect(share).toHaveAttribute('aria-checked', 'true')
    await pressStill(share, [start, page.getByTestId('mimir-composer')])
    await expect(share).toHaveAttribute('aria-checked', 'false')
    expect((await state(page)).mimirShare).toBe(false)

    await start.click()
    await expect(notice).toHaveCount(0)
    await expect(page.locator('.mimir-empty')).toBeVisible()
    expect((await state(page)).mimirNotice).toBe(1)

    // read once: it stays gone after a reload
    await page.reload()
    await viewportReady(page)
    await standIn(page)
    await page.getByTestId('tab-mimir').click()
    await expect(page.getByTestId('mimir-chat')).toBeVisible()
    await expect(page.getByTestId('mimir-cloud-notice')).toHaveCount(0)
    expect((await state(page)).mimirShare).toBe(false)
  })

  test('Settings, mimir: the share switch is on by default, and delete says what it deleted', async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as unknown as W).__sx.setState({ settingsOpen: true, settingsSection: 'pilot' }))
    const share = page.getByTestId('mimir-share')
    const forget = page.getByTestId('danger-mimir-forget')
    await expect(share).toHaveAttribute('aria-checked', 'true')
    await pressStill(share, [forget])
    await expect(share).toHaveAttribute('aria-checked', 'false')
    expect((await state(page)).mimirShare).toBe(false)
    await pressStill(share, [forget])
    expect((await state(page)).mimirShare).toBe(true)
    await forget.click()
    await expect(page.getByRole('status').filter({ hasText: 'Deleted 3 shared sessions.' })).toBeVisible()
  })
})
