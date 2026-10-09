// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The main flows of the browser build, at desktop and phone widths.
import { type Page } from '@playwright/test'
import { COLD_START_MS, expect, plateReady, sliceCount, sliced, tab, tabName, test } from './fixtures'

async function open(page: Page, workspace: string): Promise<void> {
  // Seed the starting workspace once per test; a reload must keep what the app saved.
  await page.addInitScript((ws) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: ws, settingsMode: 'advanced', cadTools: true }))
  }, workspace)
  await page.goto('./')
  // The app is up (goto waited for that); the workspace is a lazy chunk, which software graphics can hold up on a busy machine.
  await expect(page.locator('main .sx-rail, main .page, main .feed, main .three').first()).toBeVisible({ timeout: COLD_START_MS })
}

async function noHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

test('the reference plate loads on the plate tab', async ({ page }) => {
  await open(page, 'prepare')
  await plateReady(page)
  await expect(page.getByText('Layered X', { exact: true }).first()).toBeVisible()
  await noHorizontalScroll(page)
})

test('Cmd+K opens from every workspace and lists at least 30 commands', async ({ page }) => {
  await open(page, 'prepare')
  for (const id of ['prepare', 'feed', 'printers']) {
    await tab(page, id).click()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await page.keyboard.press('ControlOrMeta+k')
  const footer = await page.locator('.sx-palette-foot').innerText()
  const total = Number(/of (\d+) commands/.exec(footer)?.[1] ?? 0)
  expect(total).toBeGreaterThanOrEqual(30)
  await page.keyboard.type('go printers')
  await page.keyboard.press('Enter')
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Printers')
})

test('free text in Cmd+K goes to the assistant dock', async ({ page }) => {
  await open(page, 'prepare')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('why is my first layer peeling')
  await expect(page.locator('.sx-palette-item', { hasText: 'Ask mimir: why is my first layer peeling' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.mimir-dock')).toBeVisible()
  await expect(page.locator('.mimir-dock')).toContainText('why is my first layer peeling')
})

test('Slice runs and shows the layers in place', async ({ page, isMobile }) => {
  await open(page, 'prepare')
  await plateReady(page)
  const slices1 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible()
  if (isMobile) {
    // A phone gives the toolpaths the room and drops the legend; the color choice is in Cmd+K.
    await expect(page.getByTestId('legend-color-by')).toBeHidden()
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('Color toolpaths by Layer time')
    await page.locator('.sx-palette-item', { hasText: 'Color toolpaths by Layer time' }).click()
    await expect(page.getByTestId('legend-color-by')).toContainText('Layer time')
    return
  }
  await page.getByTestId('legend-color-by').click()
  await page.getByRole('menuitem', { name: 'Layer time' }).click()
  await expect(page.getByRole('button', { name: 'Color by Layer time' })).toBeVisible()
})

test('Printers shows the demo fleet', async ({ page }) => {
  await open(page, 'printers')
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible()
  await expect(page.locator('.pcard')).toHaveCount(6)
  await expect(page.getByRole('list', { name: 'Printers by state' }).getByRole('listitem')).toHaveCount(5)
  await noHorizontalScroll(page)
  // By bay puts printers with no bay under Unassigned; All printers is one grid again.
  await page.getByRole('radio', { name: 'By bay' }).click()
  await expect(page.getByRole('heading', { name: 'Unassigned' })).toBeVisible()
  await noHorizontalScroll(page)
  await page.getByRole('radio', { name: 'All printers' }).click()
  await expect(page.getByRole('heading', { name: 'Unassigned' })).toHaveCount(0)
  // The whole tile is one button: Enter on it opens the printer's live view.
  await page.locator('.pcard .wall-open').first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: / live view$/ })).toBeVisible()
})

test('the Vault shows a featured design and rows, opens creators, and switches between Feed and Saved', async ({ page }) => {
  await open(page, 'feed')
  await expect(page.locator('.lib-hero h2')).toBeVisible()
  await expect(page.locator('.lib-hero').getByRole('button', { name: /^Open in / })).toBeVisible()
  await expect.poll(() => page.locator('.lib-row').count()).toBeGreaterThanOrEqual(3)
  // Search shows the grid, and a nonsense word empties it.
  await page.getByLabel('Search models', { exact: true }).fill('zzzzqx')
  await expect(page.getByText('No models match')).toBeVisible()
  await page.getByLabel('Search models', { exact: true }).fill('')
  await expect(page.locator('.lib-hero')).toBeVisible()
  // See all opens the full sorted grid; the back button returns to the rows.
  await page.getByRole('region', { name: 'Most popular' }).getByRole('button', { name: 'See all' }).click()
  await expect.poll(() => page.locator('.lib-grid-cards .lib-mini').count()).toBeGreaterThan(2)
  await page.locator('.lib-grid-h').getByRole('button', { name: 'Vault' }).click()
  // The uploader opens the creator sheet, with About and Uploads tabs; Escape closes it.
  await page.locator('.lib-hero .lib-who').click()
  const sheet = page.getByRole('dialog', { name: /creator page$/ })
  await expect(sheet.getByRole('tab', { name: 'About' })).toBeVisible()
  await sheet.getByRole('tab', { name: /Uploads/ }).click()
  await expect.poll(() => sheet.locator('.cs-thumb').count()).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await noHorizontalScroll(page)
  // The Vault switch is Feed | Saved; My models has no tab of its own here.
  await expect(page.locator('.sx-tab', { hasText: 'My models' })).toHaveCount(0)
  const vault = page.getByRole('radiogroup', { name: 'Vault' })
  await expect(vault.getByRole('radio')).toHaveText(['Feed', 'Saved'])
  await vault.getByRole('radio', { name: 'Saved' }).click()
  await expect(page.getByRole('heading', { name: /^Saved/ })).toBeVisible()
  await vault.getByRole('radio', { name: 'Feed' }).click()
  await noHorizontalScroll(page)
})

test('Settings opens with Account and Phone access', async ({ page }) => {
  await open(page, 'prepare')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Account' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Phone access' }).click()
  const sw = dialog.getByRole('switch', { name: /Phone access on this network/ })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
})

test('side panes collapse to a rail and remember it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones stack the panes instead')
  await open(page, 'prepare')
  await page.getByRole('button', { name: /Collapse Printer and settings/ }).click()
  // Move away so the hover peek does not reopen the rail.
  await page.mouse.move(700, 450)
  await expect(page.locator('.sx-rail[data-side=left]')).toHaveAttribute('data-collapsed', 'true')
  await page.reload()
  await expect(page.locator('.sx-rail[data-side=left]')).toHaveAttribute('data-collapsed', 'true')
})

test('About shows the attribution line, the license and the source link', async ({ page }) => {
  await open(page, 'prepare')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('About SlicerX and its source code')
  await page.locator('.sx-palette-item', { hasText: 'About SlicerX and its source code' }).first().click()
  const about = page.getByRole('dialog', { name: /About/ })
  // The edition's attribution: "Made possible by SlicerX", linking to the support page.
  const credit = about.getByTestId('about-attribution')
  await expect(credit).toHaveText('Made possible by SlicerX')
  await expect(credit.getByRole('link', { name: 'Made possible by SlicerX' })).toHaveAttribute('href', 'https://slicerx.app/support')
  await expect(about.getByText(/Apache-2\.0; stock printer profiles AGPL-3\.0-or-later/)).toBeVisible()
  // The license's source offer: the tree of exactly this build.
  await expect(about.getByText(/The source for exactly this build is at/)).toBeVisible()
  const source = about.getByRole('link', { name: /github\.com\/slicerx-oss\/slicerx\/tree\// })
  await expect(source).toBeVisible()
  await expect(source).toHaveAttribute('href', /^https:\/\/github\.com\/slicerx-oss\/slicerx\/tree\/\S+$/)
  // The LGPL notice for the STEP reader, with the Open CASCADE exception's acknowledgment.
  await expect(about.getByTestId('about-step-reader')).toContainText('makes use of facilities provided by the Open CASCADE Technology software')
})
