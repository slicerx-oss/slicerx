// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edge tabs: < and > on the side panes and ^ on the bottom panel, in Model and in Slice. A tab or its key shuts
// the panel and opens it again, the view takes the freed width without the camera moving, and each tab bar
// remembers its own panes across a reload.
import { type Page } from '@playwright/test'
import { openStudio } from './cad-helpers'
import { expect, sliceCount, sliced, test } from './fixtures'

const viewWidth = (page: Page) => page.locator('.vp').evaluate((el) => Math.round(el.getBoundingClientRect().width))
const canvasWidth = (page: Page) => page.locator('.vp canvas').first().evaluate((el) => Math.round(el.getBoundingClientRect().width))
const target = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { getCamera(): { target: number[] } } }).__vp.getCamera().target)

/** No pane is sliding: the slow tail of a slide can read the same width twice in a row. */
const panesStill = (page: Page) =>
  page.evaluate(() => !document.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running' && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.matches('.pane, .vp')))

/**
 * Waits for the view to reach a width with no pane sliding, then for the canvas to fill it. The panes are checked
 * before the width is read: two reads in one frame of a slide match, and the slide can end before a later check.
 */
async function viewAt(page: Page, ok: (w: number) => boolean): Promise<number> {
  let last = -1
  await expect
    .poll(async () => {
      const still = await panesStill(page)
      const w = await viewWidth(page)
      const done = still && ok(w) && w === last && Math.abs((await canvasWidth(page)) - w) <= 2
      last = w
      return done
    }, { intervals: [100] })
    .toBe(true)
  return last
}

/** Shuts a side pane by its tab, then by its key, and checks the panel, the tab and the view each time. */
async function shutAndOpen(page: Page, side: 'left' | 'right', panel: string, key: string, shutsFully: boolean): Promise<void> {
  const tab = page.getByTestId(`edge-tab-${side}`)
  const body = page.getByTestId(panel)
  await expect(tab).toHaveAttribute('data-panel', panel)
  await expect(tab).toHaveAttribute('aria-expanded', 'true')
  await expect(body).toBeVisible()
  const before = await viewAt(page, () => true)
  const cam = await target(page)
  await tab.click()
  await expect(tab).toHaveAttribute('aria-expanded', 'false')
  await expect(body).toBeHidden()
  // The view and its canvas take the freed width: all of the pane's on Model, all but the icon rail on Slice.
  await viewAt(page, (w) => w - before > (shutsFully ? 250 : 180))
  // No jump: the camera keeps its target, so the model stays at the middle of the wider view.
  expect(await target(page)).toEqual(cam)
  await tab.click()
  await expect(tab).toHaveAttribute('aria-expanded', 'true')
  await expect(body).toBeVisible()
  await viewAt(page, (w) => Math.abs(w - before) <= 1)
  // The key does the same.
  await page.mouse.move(700, 300)
  await page.keyboard.press(key)
  await expect(tab).toHaveAttribute('aria-expanded', 'false')
  await expect(body).toBeHidden()
  await page.keyboard.press(key)
  await expect(body).toBeVisible()
}

test.describe('edge tabs', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width')

  test('Model: the tree, the tool pane and the timeline shut and open from their tabs and keys', async ({ page }) => {
    await openStudio(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.locator('.studio[data-model-mode="design"]')).toBeVisible()
    await shutAndOpen(page, 'left', 'model-tree', 'BracketLeft', true)
    await shutAndOpen(page, 'right', 'model-inspector', 'BracketRight', true)
    // Shut all the way: the tab sits on the edge of the plate area.
    await page.getByTestId('edge-tab-left').click()
    const left = Math.round((await page.locator('.studio').boundingBox())!.x)
    await expect.poll(async () => Math.round((await page.getByTestId('edge-tab-left').boundingBox())!.x)).toBe(left)
    await page.getByTestId('edge-tab-left').click()
    // The bottom tab sits at the middle of the view: it slides along while the tree opens.
    await expect(page.getByTestId('model-tree')).toBeVisible()
    await viewAt(page, () => true)

    const bottom = page.getByTestId('edge-tab-bottom')
    const timeline = page.locator('.bpanel-body')
    await expect(bottom).toHaveAttribute('data-panel', 'model-timeline')
    await expect(timeline).toBeHidden()
    // One press where the tab is, not locator.click(): the pointer on the tab is in the band that opens the panel by
    // itself after a moment, and the tab then moves up above the panel. A click that Playwright retries chases the tab
    // there and shuts the panel again. A press that lands after the band opened it falls on the panel, which stays
    // open, as it does for a person.
    const tabBox = (await bottom.boundingBox())!
    await page.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2)
    await expect(timeline).toBeVisible()
    await expect(bottom).toHaveAttribute('aria-expanded', 'true')
    // The model size pill moves up above the open panel instead of sitting under it.
    await expect.poll(async () => (await page.locator('.dims').boundingBox())!.y + (await page.locator('.dims').boundingBox())!.height <= (await timeline.boundingBox())!.y).toBe(true)
    await page.keyboard.press('ControlOrMeta+j')
    await expect(timeline).toBeHidden()
    await page.mouse.move(700, 300)
    await page.keyboard.press('ControlOrMeta+j')
    await expect(timeline).toBeVisible()
  })

  test('Slice: the sidebar shuts to its icon rail, and the slice summary shuts and opens', async ({ page }) => {
    await openStudio(page)
    await shutAndOpen(page, 'left', 'slice-sidebar', 'BracketLeft', false)
    const rail = page.locator('aside.pane[data-side="left"]')
    await page.getByTestId('edge-tab-left').click()
    await expect(rail).toHaveAttribute('data-collapsed', 'true')
    await expect(rail.locator('.sx-rail-item').first()).toBeVisible()
    await page.getByTestId('edge-tab-left').click()

    // The right pane holds the objects before any slice, and the summary joins them after one.
    await expect(page.getByTestId('slice-summary').getByTestId('objects-list')).toBeVisible()
    await shutAndOpen(page, 'right', 'slice-summary', 'BracketRight', false)
    const n = await sliceCount(page)
    // Mod+Enter slices in every look, wherever the look puts the Slice button.
    await page.mouse.click(700, 450)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('slice-summary').locator('[data-section="totals"]')).toBeVisible()
  })

  test('each tab bar remembers its own panes across a reload', async ({ page }) => {
    await openStudio(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await page.getByTestId('edge-tab-left').click()
    await expect(page.getByTestId('model-tree')).toBeHidden()
    // Shutting Model's tree leaves Slice's sidebar open.
    await page.locator('.sx-tab[data-mode="slice"]').click()
    await expect(page.getByTestId('slice-sidebar')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('slice-sidebar')).toBeVisible()
    await expect(page.getByTestId('edge-tab-left')).toHaveAttribute('aria-expanded', 'true')
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.getByTestId('edge-tab-left')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('model-tree')).toBeHidden()
    await expect(page.getByTestId('edge-tab-right')).toHaveAttribute('aria-expanded', 'true')
  })

  test('the tips name the keys, and the shortcuts list has them', async ({ page }) => {
    await openStudio(page)
    await expect(page.getByTestId('edge-tab-left')).toHaveAttribute('data-tip-key', '[')
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.getByTestId('edge-tab-bottom')).toHaveAttribute('data-tip-key', 'Mod+J')
    await page.mouse.click(700, 300)
    await page.keyboard.press('Shift+?')
    const list = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(list.getByText('Show or hide the left panel')).toBeVisible()
    await expect(list.getByText('Show or hide the bottom panel')).toBeVisible()
  })
})

test.describe('edge tabs on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone width')

  /** The sheet's top edge is on screen when it is open. */
  const onScreen = (page: Page, panel: string) =>
    page.getByTestId(panel).evaluate((el) => {
      const r = el.closest('aside')!.getBoundingClientRect()
      return r.top < innerHeight - 40
    })

  test('the tab opens its sheet, and Escape and a tap outside close it', async ({ page }) => {
    await openStudio(page)
    const left = page.getByTestId('edge-tab-left')
    await expect(left).toHaveAttribute('data-panel', 'slice-sidebar')
    expect(await onScreen(page, 'slice-sidebar')).toBe(false)
    await left.tap()
    await expect(left).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => onScreen(page, 'slice-sidebar')).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => onScreen(page, 'slice-sidebar')).toBe(false)

    // A tap outside, on the scrim, closes it too. (A phone has Slice only, with no Model and its sheets.)
    await page.getByTestId('edge-tab-left').tap()
    await expect.poll(() => onScreen(page, 'slice-sidebar')).toBe(true)
    await page.locator('.sheet-scrim').tap({ position: { x: 380, y: 200 } })
    await expect.poll(() => onScreen(page, 'slice-sidebar')).toBe(false)
    await expect(page.getByTestId('edge-tab-left')).toHaveAttribute('aria-expanded', 'false')
  })
})
