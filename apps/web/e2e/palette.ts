// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The command bar (Cmd+K) in the specs. On a busy machine the bar is slower than the keys: Cmd+K can land before the page
// listens, the input takes the focus a moment after the dialog shows, and the list of commands loads after both. Keys and
// clicks sent into any of those gaps are lost, or run the wrong row. So a spec opens the bar here, waits for the input to
// hold the focus and the list to be there, puts the query in with fill, waits for the row it wants, and only then runs it.
import { expect, test, type Locator, type Page } from '@playwright/test'

/** The command bar's dialog. */
export function paletteDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Commands' })
}

/** The row for `wanted` (text in its row), first in the list order. */
export function paletteRow(page: Page, wanted: string | RegExp): Locator {
  return page.locator('.sx-palette-item', { hasText: wanted }).first()
}

/**
 * Opens the command bar and returns its input, ready for text: the focus is in it and the list of commands has loaded.
 * It opens with Cmd+K, or with a click on `trigger` (a phone's Search button). The press goes again if the first one found
 * the page not listening yet, or a dialog open (the app ignores the key under a dialog, as the dialog keeps the page inert);
 * when the bar did not open for a press, the run's annotations say what had the focus and what else was open.
 */
export async function openPalette(page: Page, trigger?: Locator): Promise<Locator> {
  const palette = paletteDialog(page)
  let presses = 0
  await expect(async () => {
    if (!(await palette.isVisible())) {
      if (presses++ > 0) {
        const seen = await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 160), open: [...document.querySelectorAll('dialog[open], [role=dialog], [role=menu]')].map((d) => d.getAttribute('aria-label') ?? d.className), toasts: document.querySelectorAll('[data-testid="toast"]').length }))
        test.info().annotations.push({ type: 'palette did not open', description: JSON.stringify(seen) })
      }
      if (trigger) await trigger.click()
      else await page.keyboard.press('ControlOrMeta+k')
    }
    await expect(palette).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 20_000 })
  const input = palette.getByRole('combobox')
  await expect(input).toBeFocused()
  // Before the commands have loaded the list is empty and says so.
  await expect(palette.getByRole('option').first()).toBeVisible()
  return input
}

/** Puts `query` in the open bar and waits for the row for `wanted` (the query itself by default), which it returns. */
export async function searchPalette(page: Page, query: string, wanted: string | RegExp = query): Promise<Locator> {
  const input = paletteDialog(page).getByRole('combobox')
  await input.fill(query)
  await expect(input).toHaveValue(query)
  const row = paletteRow(page, wanted)
  await expect(row).toBeVisible()
  return row
}

/** Runs the row Enter would run: waits for it to be the selected one (the list may still be filtering), then presses Enter. */
export async function submitPalette(page: Page, row: Locator): Promise<void> {
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
}

/**
 * Opens the bar, searches for `query` and runs the row for `wanted` (the query itself by default): with Enter, once the
 * row is the selected one, or with a click.
 */
export async function command(page: Page, query: string, { wanted = query, via = 'click' }: { wanted?: string | RegExp; via?: 'click' | 'enter' } = {}): Promise<void> {
  await openPalette(page)
  const row = await searchPalette(page, query, wanted)
  if (via === 'click') {
    await row.click()
    return
  }
  await submitPalette(page, row)
}
