// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Vault's featured cover shows the whole drawing, centered, at desktop and phone widths. The demo catalog has no
// cover pictures, so the spec puts one in the hero the way the app does (an img in .lib-hero-art), at the size the
// starters' covers are drawn (800 by 600), and measures what is on screen.
import { expect, test, type Page } from '@playwright/test'

async function vault(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'feed', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await expect(page.locator('.lib-hero h2')).toBeVisible({ timeout: 120_000 })
}

test('the featured cover fits whole and centered in the hero', async ({ page }) => {
  await vault(page)
  const r = await page.evaluate(async () => {
    const art = document.querySelector('.lib-hero-art') as HTMLElement
    const c = document.createElement('canvas')
    c.width = 800
    c.height = 600
    const g = c.getContext('2d')!
    g.fillStyle = '#bd93f9'
    g.fillRect(0, 0, 800, 600)
    const img = document.createElement('img')
    img.alt = ''
    img.src = c.toDataURL('image/png')
    await img.decode()
    art.replaceChildren(img)
    const a = art.getBoundingClientRect()
    const i = img.getBoundingClientRect()
    // What object-fit draws inside the img box: contain scales the whole picture in; cover fills the box and crops.
    const fit = getComputedStyle(img).objectFit
    const s = fit === 'cover' ? Math.max(i.width / 800, i.height / 600) : Math.min(i.width / 800, i.height / 600)
    const w = 800 * s
    const h = 600 * s
    const x = i.left + (i.width - w) / 2
    const y = i.top + (i.height - h) / 2
    return { art: { l: a.left, t: a.top, r: a.right, b: a.bottom }, drawn: { l: x, t: y, r: x + w, b: y + h }, box: { l: i.left, t: i.top, r: i.right, b: i.bottom }, fit }
  })
  // The whole picture is on screen: the drawn picture is inside the img box (nothing cropped), and the box inside the hero.
  for (const [inner, outer] of [[r.drawn, r.box], [r.box, r.art]] as const) {
    expect(inner.l).toBeGreaterThanOrEqual(outer.l - 0.5)
    expect(inner.t).toBeGreaterThanOrEqual(outer.t - 0.5)
    expect(inner.r).toBeLessThanOrEqual(outer.r + 0.5)
    expect(inner.b).toBeLessThanOrEqual(outer.b + 0.5)
  }
  // Centered both ways, and as large as the hero lets it be.
  expect(Math.abs((r.drawn.l + r.drawn.r) / 2 - (r.art.l + r.art.r) / 2)).toBeLessThan(1)
  expect(Math.abs((r.drawn.t + r.drawn.b) / 2 - (r.art.t + r.art.b) / 2)).toBeLessThan(1)
  const fills = Math.max((r.drawn.r - r.drawn.l) / (r.art.r - r.art.l), (r.drawn.b - r.drawn.t) / (r.art.b - r.art.t))
  expect(fills).toBeGreaterThan(0.8)
})
