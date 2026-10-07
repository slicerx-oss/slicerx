// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shell loads only the startup icons (packages/ui/icons/startup.mjs); the rest come in a chunk of their own and
// draw as an empty box until it arrives. With that chunk held back, the first frame of each workspace must have
// every icon on screen drawn: the rail, the app bar and the panels show no icon popping in.
import { type Page } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

async function open(page: Page, workspace: 'prepare'): Promise<void> {
  // The full icon table never arrives in this test.
  await page.route(/\/icon-paths-[^/]*\.js$/, (route) => route.abort())
  await page.addInitScript((ws) => {
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: ws, pilot: { mode: 'off' } }))
  }, workspace)
  await page.goto('./')
  await expect(page.locator('.sx-tab[aria-current=page]')).toBeVisible()
  await viewportReady(page)
}

/** The visible icons still waiting for the full table, as "name (what holds it)". */
async function blankIcons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const svg of Array.from(document.querySelectorAll('svg[data-icon-pending]'))) {
      const r = svg.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue
      if (getComputedStyle(svg).visibility === 'hidden') continue
      const host = svg.closest('button, a, [role], li, label') ?? svg.parentElement
      const what = (host?.getAttribute('aria-label') ?? host?.textContent ?? '').trim().slice(0, 30)
      out.push(`${svg.getAttribute('data-icon-pending')} (${what})`)
    }
    return [...new Set(out)].sort()
  })
}

for (const workspace of ['prepare'] as const) {
  test(`the ${workspace} workspace draws every icon without the full icon table`, async ({ page }, info) => {
    await open(page, workspace)
    const shot = await page.screenshot({ path: info.outputPath(`${workspace}-first-frame.png`) })
    await info.attach(`${workspace}-first-frame`, { body: shot, contentType: 'image/png' })
    expect(await blankIcons(page)).toEqual([])
    // The rail and the app bar are there and carry icons.
    expect(await page.locator('svg.sx-ic').count()).toBeGreaterThan(10)
  })
}
