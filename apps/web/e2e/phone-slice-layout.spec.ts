// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice after a slice: no control sits over another. On a phone Print is on screen with nothing over it, and opening
// the playback bar moves neither its own toggle nor Print; at 1440 the color legend stays clear of the plate toolbar.
import { expect, plateReady, sliceCount, sliced, test } from './fixtures'
import type { Page } from '@playwright/test'

type Box = { name: string; x: number; y: number; w: number; h: number }
type Sx = { setState(p: unknown): void }

/** The boxes of the controls laid over and under the 3D view. */
async function controls(page: Page): Promise<Box[]> {
  return page.locator('.vp').evaluate((vp) => {
    const sel = ['.hud-top .hud-col > *', '.slice-look', '.plate-tools', '.lstrip', '.hud-bl > *', '.dock', '.slice-float']
    return sel.flatMap((s) =>
      [...vp.querySelectorAll<HTMLElement>(s)]
        .filter((el) => getComputedStyle(el).opacity !== '0' && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .map(({ el, r }) => ({ name: `${s} ${el.className}`, x: r.x, y: r.y, w: r.width, h: r.height })),
    )
  })
}

const meet = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5

/** Print is inside the window and is what a tap on its middle reaches. */
async function printInReach(page: Page): Promise<void> {
  const print = page.getByTestId('danger-slice-print')
  await expect(print).toBeVisible()
  const hit = await print.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, reached: top !== null && el.contains(top) }
  })
  expect(hit).toEqual({ inside: true, reached: true })
}

for (const width of [390, 360]) {
  test(`at ${width} px, after a slice nothing overlaps and Print is in reach`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone width')
    test.slow()
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, settingsMode: 'simple' }))
    })
    await page.goto('./')
    await plateReady(page)
    const n = await sliceCount(page)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('.vp .dock')).toBeVisible()

    const boxes = await controls(page)
    const pairs = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => meet(a, b)).map((b) => `${a.name} / ${b.name}`))
    expect(pairs).toEqual([])
    await printInReach(page)

    // The playback bar opens over the foot of the view: its toggle and Print stay where they were.
    const toggle = page.getByRole('button', { name: 'More playback controls' })
    const before = { toggle: await toggle.boundingBox(), print: await page.getByTestId('danger-slice-print').boundingBox() }
    await toggle.click()
    await expect(page.getByRole('button', { name: 'Fewer playback controls' })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Playback speed' })).toBeVisible()
    expect(await page.getByRole('button', { name: 'Fewer playback controls' }).boundingBox()).toEqual(before.toggle)
    expect(await page.getByTestId('danger-slice-print').boundingBox()).toEqual(before.print)
    await printInReach(page)
  })
}

test('at 1440 by 900, the toolpath controls stay clear of each other with the legend by feature type', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop width')
  test.slow()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, settingsMode: 'simple' }))
  })
  await page.goto('./')
  await plateReady(page)
  const n = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).first().click()
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ colorMode: 'feature', colorModePicked: true }))
  await expect(page.locator('.vp .legend')).toBeVisible()
  const boxes = await controls(page)
  const pairs = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => meet(a, b)).map((b) => `${a.name} / ${b.name}`))
  expect(pairs).toEqual([])
})
