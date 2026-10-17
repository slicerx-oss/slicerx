// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone legs of the session journeys (boot-session, mimir and vault), the ones with an assertion that only a phone
// has: no sideways scroll, setup with one step fewer, the Settings list, a Slice without a legend, the Vault's two
// covers and the edge of a third, a start screen with no gutter, and a part card with no Edit. What a phone shares with
// the desktop runs there. The tests with the shared page (journey) are on a phone-sized page; the cold ones start the
// app from nothing, as the desktop ones in boot-session.spec.ts do.
import { journey, expect } from '../journey'
import { goTab, plateReady, test as cold, viewportReady } from '../fixtures'
import {
  askDock,
  cadOnlyStudio,
  debugOn,
  escapeAndHandAdd,
  expectHeroCoverFits,
  iconsWithoutTable,
  lastUserText,
  measureRow,
  mimirConnectSteps,
  noHorizontalScroll,
  openVault,
  printersFleet,
  setPilot,
  setState,
  settingsAccount,
  sliceAndColorBy,
  stubProxy,
  signIn,
  themeAndLookAndFeel,
  vaultFeed,
  workspaceNeverDownloads,
  type Block,
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

  // The part card on a phone has no Edit: a phone has no modeling tools. The reply, the card and its Select are the same as at desktop.
  journey('a reply that makes a part shows the card, and a phone has no Edit', async ({ page }) => {
    await debugOn(page)
    // The tab the step before left is what the page comes back to, and the Vault has no view to wait for.
    await goTab(page, 'prepare')
    // the docked chat is a view choice the browser remembers, read as the page loads
    await page.evaluate(() => localStorage.setItem('sx-mimir-dock', '1'))
    await page.reload()
    await viewportReady(page)
    await setPilot(page, 'cloud')
    await stubProxy(page, (body) => {
      const text = lastUserText(body)
      if (text.includes('tool_result')) return [{ type: 'text', text: 'Want rounded edges, or a hole through it?' }]
      return [
        { type: 'text', text: 'Created a 20 mm cube at the origin.' },
        { type: 'tool_use', id: 'tu_20', name: 'text_to_part', input: { name: '20 mm cube', solids: [{ type: 'box', sizeMm: [20, 20, 20] }] } },
      ] satisfies Block[]
    })
    await signIn(page)
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    const dock = page.locator('.mimir-dock')
    await expect(dock).toBeVisible()
    const again = dock.getByRole('button', { name: 'New conversation' })
    if (await again.isVisible()) await again.click()
    await askDock(page, 'a 20 mm cube')
    const card = dock.getByTestId('mimir-part')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('button', { name: 'Select the 20 mm cube' }).click()
    await expect(card.getByRole('button', { name: 'Edit the 20 mm cube' })).toHaveCount(0)
    // the dock stays open in the browser for the next test on this page: put it away
    await page.evaluate(() => localStorage.setItem('sx-mimir-dock', '0'))
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
