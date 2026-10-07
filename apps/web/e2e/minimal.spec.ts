// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Minimal UI: how many controls each workspace shows at once in Simple mode.
import { type Page } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

const INTERACTIVE = 'button, a[href], input, select, textarea, [role=radio], [role=switch], [role=slider], [role=tab], [role=menuitem]'

async function open(page: Page, workspace: string): Promise<void> {
  await page.addInitScript((ws) => {
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: ws, pilot: { mode: 'off' } }))
  }, workspace)
  await page.goto('./')
  await expect(page.locator('.sx-tab[aria-current=page]')).toBeVisible()
  await viewportReady(page)
}

async function visibleControls(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const seen = new Set<Element>()
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (seen.has(el)) continue
      seen.add(el)
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
      if (r.right < 0 || r.left > innerWidth) continue
      // A canvas gizmo, the menu list of a closed select, and sr-only skip links do not count.
      if (el.closest('.sr-only, [hidden], [aria-hidden=true]')) continue
      // Hover-revealed controls (opacity 0 on the control or a parent) are not on screen.
      let hidden = false
      for (let p: Element | null = el; p; p = p.parentElement) if (Number(getComputedStyle(p).opacity) === 0) hidden = true
      if (hidden) continue
      // A segmented group or a row of axis fields reads as one control.
      const group = el.closest('[role=radiogroup], .tf-row')
      if (group) {
        if (seen.has(group)) continue
        seen.add(group)
      }
      out.push(`${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28)}`)
    }
    return out
  }, INTERACTIVE)
}

test('The plate tab with an object selected shows 38 controls or fewer, Simple mode', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop width')
  await open(page, 'prepare')
  const list = await visibleControls(page)
  console.log('prepare selected', list.length, list.join(' | '))
  // 36: calibration by need added a Tune button on each used filament that is not tuned yet (two on the two-color
  // reference plate). It belongs: it is the one way into the tests a new spool needs.
  // 37: the drawing tools are on by default, which shows Add shape beside Add model.
  // 38: the drying note shows in Simple mode and carries It's dry, its one way to be answered. The button belongs to
  // the note, so it shows exactly when the note does.
  expect(list.length).toBeLessThanOrEqual(38)
})

test('a saved Preview tab opens Slice, with no Preview tab in the bar', async ({ page }) => {
  await open(page, 'preview')
  await expect(page.locator('.sx-tab[aria-current=page]')).toHaveText('Slice')
  await expect(page.locator('.sx-tab', { hasText: 'Preview' })).toHaveCount(0)
})
