// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip never covers the next thing a person presses: it takes no clicks, and it closes once the pointer leaves its
// control, even when the pointer crosses the tip on the way.
import { type Locator } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

test('the lock button\'s tip closes as the pointer moves to the name under it, and the name takes the click', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const row = page.getByTestId('object-row').first()
  const name = row.getByTestId('object-select')
  const lock = row.getByTestId('object-lock')
  await page.keyboard.press('Escape')
  await expect(name).toHaveAttribute('aria-pressed', 'false')
  await row.locator('.obj-row').hover()
  await lock.hover()
  const tip = page.locator('#sx-tip')
  await expect(tip).toContainText('Keep it from moving')
  // The tip takes no pointer: a press where it is drawn lands on what is under it.
  const t = (await tip.boundingBox())!
  const [cx, cy] = [t.x + t.width / 2, t.y + t.height / 2]
  expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('#sx-tip')), [cx, cy])).toBe(false)
  // Across the tip to the name: the lock's tip closes once the pointer leaves the button, and the name takes the click.
  await page.mouse.move(cx, cy, { steps: 4 })
  await expect(tip.filter({ hasText: 'Keep it from moving' })).toHaveCount(0)
  const n = (await name.boundingBox())!
  await page.mouse.click(n.x + n.width / 2, n.y + n.height / 2)
  await expect(name).toHaveAttribute('aria-pressed', 'true')
})

test('a tip in the settings sidebar opens beside it, level with its control, and covers nothing in the sidebar', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const pane = (await page.locator('.pane[data-side="left"]').boundingBox())!
  const tip = page.locator('#sx-tip')
  const beside = async (anchor: Locator, text: string) => {
    await anchor.hover()
    await expect(tip).toContainText(text)
    await expect(tip).toHaveAttribute('data-ready', 'true')
    const t = (await tip.boundingBox())!
    const a = (await anchor.boundingBox())!
    // clear of the sidebar, so the next row and the control under it stay in view
    expect(t.x).toBeGreaterThanOrEqual(pane.x + pane.width)
    // level with its control
    expect(t.y).toBeLessThanOrEqual(a.y + a.height)
    expect(t.y + t.height).toBeGreaterThanOrEqual(a.y)
    await page.mouse.move(pane.x + pane.width + 300, 40)
    await expect(tip).toHaveCount(0)
  }
  // sleipnir on the layer height, over Supports' segment before
  await beside(page.locator('#easy-layer'), 'sleipnir changes the layer height')
  // aegis on the wall generator: the option keeps its name, and its tip names it over the longer copy
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ expertOpen: true }))
  const aegis = page.locator('[data-key="wall_generator"]').getByRole('radio', { name: 'aegis' })
  // scrolled into view inside the sidebar only, so the page itself stays put
  await aegis.evaluate((el) => {
    const body = el.closest('.sx-rail-body')!
    body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 120
  })
  await beside(aegis, 'aegis varies wall width')
})

test('a tip with a loop holds its size while the loop loads, waits on its finished frame, then plays, in either theme', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  await page.locator('#easy-layer').hover()
  await expect(tip).toContainText('sleipnir')
  await expect(tip).toHaveAttribute('data-ready', 'true')
  // The box is there at once, at the stage's size, so the tip is the same height before and after the loop draws.
  await expect(stage).toBeVisible()
  // The tip scales in from 98% (sx-tip-in), so it is measured once that has finished: a box read mid-entrance is 2%
  // smaller and reads as a tip that grew.
  await tip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const first = (await tip.boundingBox())!
  await expect(stage.locator('svg.sxs')).toBeVisible()
  // It plays from the media stage on.
  await expect(stage).toHaveAttribute('data-play', 'true')
  const state = () => stage.locator('.s-a').first().evaluate((el) => getComputedStyle(el).animationPlayState)
  await expect.poll(state).toBe('running')
  const later = (await tip.boundingBox())!
  expect(Math.round(later.height)).toBe(Math.round(first.height))
  expect(Math.round(later.width)).toBe(Math.round(first.width))
  // Dark and light follow the theme: the stage's own tokens change with the root's color scheme.
  const ink = () => stage.evaluate((el) => getComputedStyle(el).getPropertyValue('--stage-t1').trim())
  const dark = await ink()
  await page.evaluate(() => document.documentElement.style.setProperty('color-scheme', 'light'))
  await expect.poll(ink).not.toBe(dark)
  await page.evaluate(() => document.documentElement.style.removeProperty('color-scheme'))
  await expect.poll(ink).toBe(dark)
})

test('each Simple setting, each of its choices and each plate tool opens its own loop and plays it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    // Advanced keeps the Simple rows open (Strength, Speed and Brim sit behind More in Simple)
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  const away = async () => {
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
  // each anchor's loop id is the class prefix of its drawing, so the loop on show is told apart by it
  const plays = async (anchor: Locator, text: string, loopId: string) => {
    await anchor.hover()
    await expect(tip).toContainText(text)
    await expect(stage.locator('svg.sxs')).toBeVisible()
    await expect(stage).toHaveAttribute('data-play', 'true')
    await expect(stage.locator(`[class*="${loopId}-"]`).first()).toBeAttached()
    await away()
  }
  const rows = page.locator('.srow')
  // layer height has a still figure too; the loop takes its place, so the tip shows one picture
  await rows.filter({ hasText: 'Layer height' }).locator('.srow-h').hover()
  await expect(stage.locator('svg.sxs')).toBeVisible()
  await expect(tip.locator('.sx-tip-fig')).toHaveCount(0)
  await away()
  await plays(rows.filter({ hasText: 'Layer height' }).locator('.srow-h'), 'Layer height', 'lh')
  await plays(page.locator('label[for="easy-strength"]'), 'Adds walls and infill', 'st')
  await plays(page.locator('label[for="easy-speed"]'), 'How fast the printer moves', 'sp')
  await plays(page.locator('output[for="easy-speed"]'), 'The preset speeds', 'sd')
  const supports = rows.filter({ hasText: 'Supports' })
  await plays(supports.locator('.srow-h'), 'Supports', 'su')
  await plays(supports.getByRole('radio', { name: 'Off' }), 'No supports', 'so')
  await plays(supports.getByRole('radio', { name: 'Auto' }), 'Organic tree supports', 'sa')
  await plays(supports.getByRole('radio', { name: 'Painted' }), 'Only where you paint support', 'sn')
  await plays(page.locator('label[for="easy-brim"]'), 'flat rings around the first layer', 'br')
  const tools = page.getByRole('toolbar', { name: 'Plate tools' })
  await plays(tools.getByRole('button', { name: 'Move', exact: true }), 'Drag the model across the plate', 'mv')
  await plays(tools.getByRole('button', { name: 'Rotate', exact: true }), 'Drag a ring', 'ro')
  await plays(tools.getByRole('button', { name: 'Scale', exact: true }), 'Resize the model', 'sc')
  await plays(tools.getByRole('button', { name: 'Lay on face', exact: true }), 'Pick a face', 'lf')
})

test('an Advanced setting row opens the loop of its drawing and plays it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ expertOpen: true }))
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  // setting key, its name to search for (the settings sit behind tabs), then the class prefix of the loop its row shows
  for (const [key, name, loopId] of [['print_flow_ratio', 'Print flow ratio', 'afr'], ['fuzzy_skin', 'Fuzzy skin', 'afz'], ['ironing_type', 'Ironing type', 'air'], ['draft_shield', 'Draft shield', 'ads'], ['elefant_foot_compensation', 'Elephant foot', 'aef']] as const) {
    await page.locator('#expert-search').fill(name)
    const row = page.locator(`li[data-key="${key}"]`).first()
    await row.scrollIntoViewIfNeeded()
    await row.locator('label').first().hover()
    await expect(stage.locator('svg.sxs'), key).toBeVisible()
    await expect(stage).toHaveAttribute('data-play', 'true')
    await expect(stage.locator(`[class*="${loopId}-"]`).first(), key).toBeAttached()
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
})
