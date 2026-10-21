// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone legs of the session journeys (boot-session, mimir and vault), the ones with an assertion that only a phone
// has: no sideways scroll, setup with one step fewer, the Settings list, a Slice without a legend, the Vault's two
// covers and the edge of a third, a start screen with no gutter, and the mimir tab with its chat under the view. What a phone shares with
// the desktop runs there. The tests with the shared page (journey) are on a phone-sized page; the cold ones start the
// app from nothing, as the desktop ones in boot-session.spec.ts do.
import type { Locator } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab, plateReady, test as cold } from '../fixtures'
import {
  answer,
  askTab,
  cadOnlyStudio,
  debugOn,
  escapeAndHandAdd,
  expectHeroCoverFits,
  iconsWithoutTable,
  measureRow,
  mimirConnectSteps,
  noHorizontalScroll,
  openVault,
  printersFleet,
  setPilot,
  setState,
  settingsAccount,
  shotsDir,
  shotsOn,
  sliceAndColorBy,
  stubProxy,
  signIn,
  themeAndLookAndFeel,
  vaultFeed,
  workspaceNeverDownloads,
} from './lib/session'

// Worker options go at the top of the file. Mimir is put in the state it needs by the test that uses it.
journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true } })

/* ------------------------------------------------------------------ the app, up */

journey.describe('the main flows on a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('the reference plate loads, with no sideways scroll', async ({ page }) => {
    await goTab(page, 'prepare')
    await plateReady(page)
    await expect(page.getByText('Layered X', { exact: true }).first()).toBeVisible()
    await noHorizontalScroll(page)
  })

  journey('Slice runs and shows the layers, and the color choice is in Cmd+K', async ({ page }) => {
    await sliceAndColorBy(page, true)
  })

  journey('Printers shows the demo fleet', async ({ page }) => {
    await printersFleet(page)
  })

  journey('the Vault shows a featured design and rows, with no sideways scroll', async ({ page }) => {
    await vaultFeed(page)
  })

  journey('Settings opens on its list of sections, with Account and Phone access', async ({ page }) => {
    await settingsAccount(page)
  })

  journey('the featured cover fits whole and centered in the hero', async ({ page }) => {
    await openVault(page)
    await expectHeroCoverFits(page)
  })

  journey('on a phone a Vault row shows two covers and the edge of the next', async ({ page }) => {
    await openVault(page)
    const m = await measureRow(page)
    expect(m.whole).toBe(2)
    expect(m.coverW).toBeGreaterThan(130)
    if (m.count > 2) {
      expect(m.scrolls).toBe(true)
      expect(m.reach).toBeGreaterThan(m.rowW - 4)
    }
    await noHorizontalScroll(page)
  })
})

/* ------------------------------------------------------------------ mimir */

journey.describe('mimir on a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  // The tab bar opens the mimir tab: the design's view on top, the chat under it, and a reply in the chat.
  journey('the tab bar opens the mimir tab, with the chat under the view', async ({ page }) => {
    await debugOn(page)
    // The tab the step before left is what the page comes back to, and the Vault has no view to wait for.
    await goTab(page, 'prepare')
    await setPilot(page, 'cloud')
    await stubProxy(page, () => answer('A PETG part on a hot dashboard wants ASA instead, per the material guide.'))
    await signIn(page)
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
    await expect(page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]')).toHaveAttribute('aria-current', 'page')
    const chat = page.getByTestId('mimir-chat')
    await expect(chat).toBeVisible()
    const view = (await page.locator('.studio > .vp').boundingBox())!
    const box = (await chat.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(view.y + view.height - 1)
    const again = chat.getByRole('button', { name: 'New conversation' })
    await again.click()
    await askTab(page, 'What should I print a car phone mount in?')
    await expect(chat).toContainText('wants ASA instead', { timeout: 30_000 })
    await noHorizontalScroll(page)
    // the first tab leaves it
    await page.locator('.phone-tab >> nth=0').click()
    await expect(chat).toBeHidden()
  })

  // A part card on a phone has no Edit (a phone has no modeling tools), and tapping its body selects the part.
  journey("a scripted box's card has no Edit, and tapping it selects the part", async ({ page }, info) => {
    await debugOn(page)
    await goTab(page, 'prepare')
    await setPilot(page, 'scripted')
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
    const chat = page.getByTestId('mimir-chat')
    await chat.getByRole('button', { name: 'New conversation' }).click()
    await askTab(page, 'Can you make a box with a lid?')
    await page.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-transcript')).toContainText('Done: the box and its lid', { timeout: 30_000 })
    const card = page.getByTestId('mimir-part').last()
    await expect(page.getByTestId('mimir-part')).toHaveCount(1)
    // the reply has finished, so its next steps show under the card
    await expect(page.getByTestId('mimir-transcript')).toContainText('Both parts are in Model with their steps.')
    await expect(card.getByRole('button', { name: /^Edit the / })).toHaveCount(0)
    const id = await card.getAttribute('data-part')
    // the build leaves the part selected; clear that, so Select is what selects it
    await setState(page, { selection: null, selectedIds: [] })
    await card.scrollIntoViewIfNeeded()
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/phone-part-card.png` })
    await card.getByRole('button', { name: /^Select the / }).tap()
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __sx: { getState(): { selectedIds: string[] } } }).__sx.getState().selectedIds))).toEqual([id])
    await noHorizontalScroll(page)
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/phone-part-select.png` })
  })

  // The timeline's edge tab sits centered on the view's bottom edge. On a phone the lookup card and the size pill stand
  // above it, at 390 and at 360 wide, and the pill steps aside while a card covers its place.
  journey('the lookup card and the size pill keep clear of the timeline tab at 390 and 360 px', async ({ page }, info) => {
    await debugOn(page)
    await goTab(page, 'prepare')
    await setPilot(page, 'scripted')
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
    const chat = page.getByTestId('mimir-chat')
    await chat.getByRole('button', { name: 'New conversation' }).click()
    await askTab(page, 'Hey mimir, I need a wall mount for this thermostat. Can we print it?')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'Yes, that one' }).click()
    await page.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-transcript')).toContainText('The backplate is on the plate', { timeout: 30_000 })
    const tab = page.locator('.studio > .vp .bpanel .sx-edge-tab')
    const card = page.getByTestId('mimir-lookup-card').first()
    const pill = page.locator('.studio > .vp .hud-bl .dims')
    // the share of a's box that b covers, 0 when they do not touch
    const overlap = async (a: Locator, b: Locator): Promise<number> => {
      const p = (await a.boundingBox())!
      const q = (await b.boundingBox())!
      const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)
      const h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)
      return w > 0 && h > 0 ? (w * h) / (p.width * p.height) : 0
    }
    const was = page.viewportSize()!
    try {
      for (const [w, h] of [[390, 844], [360, 780]] as const) {
        await page.setViewportSize({ width: w, height: h })
        await expect(tab).toBeVisible()
        await expect(card).toBeVisible()
        // the build may open the timeline for a moment; the card stands clear of its tab either way
        await expect.poll(() => overlap(card, tab), { message: `card over the tab at ${w}` }).toBe(0)
        // the pill is under the card's place, so it steps aside while the card shows
        await expect(pill).toBeHidden()
        if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/phone-lookup-clear-${w}.png` })
      }
      await card.getByTestId('mimir-lookup-close').tap()
      await expect(page.getByTestId('mimir-lookup-card')).toHaveCount(0)
      for (const [w, h] of [[390, 844], [360, 780]] as const) {
        await page.setViewportSize({ width: w, height: h })
        await expect(pill).toBeVisible()
        await expect(pill).toContainText('mm')
        await expect.poll(() => overlap(pill, tab), { message: `pill over the tab at ${w}` }).toBe(0)
        if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/phone-pill-clear-${w}.png` })
      }
    } finally {
      await page.setViewportSize(was)
    }
    await noHorizontalScroll(page)
  })
})

/* ------------------------------------------------------------------ starts that need a page of their own */

cold.describe('a phone start', () => {
  cold.skip(({ isMobile }) => !isMobile, 'The phone project')

  cold('the prepare workspace draws every icon without the full icon table', async ({ page }, info) => {
    await iconsWithoutTable(page, info)
  })

  cold('a workspace whose code never downloads says so once, filling the whole screen', async ({ page }) => {
    await workspaceNeverDownloads(page, true)
  })

  // Setup has four steps on a phone (no "Opens in"), and mimir opens from the tab bar.
  cold('Escape asks, a hand added printer goes on untested, and mimir offers its connect step', async ({ page }) => {
    await escapeAndHandAdd(page, true)
    await page.getByRole('button', { name: 'Skip, use defaults' }).click()
    await expect(page.locator('.fr')).toHaveCount(0)
    await mimirConnectSteps(page, true)
  })

  cold('the theme step applies at once and stays after a reload, and Settings, Look and feel works one section at a time', async ({ page }) => {
    await themeAndLookAndFeel(page)
  })

  cold('the CAD-only studio: theme, then mimir, then the plate, with no sideways scroll', async ({ page }) => {
    await cadOnlyStudio(page, true)
  })
})
