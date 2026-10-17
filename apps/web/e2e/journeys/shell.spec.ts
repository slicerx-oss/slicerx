// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's frame on a desktop window: the top bar and its tabs, the edge tabs and pane resizing, the Slice and Model
// modes, toasts and the Settings dialog fitting the window, the Slice sidebar fitting without scrolling, and the
// look and the tips that sit over all of it. One page per worker; each test starts from the state it sets up itself.
// The phone legs are in phone-shell.spec.ts.
import { type Locator, type Page } from '@playwright/test'
import { pushTop, steps } from '../cad-helpers'
import { addMenu, expect, panesSettled, sliceCount, sliced, viewportReady, viewSized } from '../fixtures'
import { atSize, box, command, dismiss, exampleX, goSlice, layoutReset, mode, postToast, setState, settingsReset, slicedBox, sliceNow, test, toastAwayFromPlate, visibleControls } from './lib/shell'

test.skip(({ isMobile }) => isMobile, 'Desktop window; the phone legs are in phone-shell.spec.ts')

type Sx = { getState(): { workspace: string; modelMode: string; sliceLook: string; plateLoading: boolean; motion: string | null }; setState(p: unknown): void }
const sx = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

// ---- minimal UI ----------------------------------------------------------------------------------------------

test('The plate tab with an object selected shows 44 controls or fewer, Simple mode', { tag: '@smoke' }, async ({ page }) => {
  await exampleX(page)
  await mode(page, 'simple')
  await viewportReady(page)
  const list = await visibleControls(page)
  console.log('prepare selected', list.length, list.join(' | '))
  // 36: calibration by need added a Tune button on each used filament that is not tuned yet (two on the two-color
  // reference plate). It belongs: it is the one way into the tests a new spool needs.
  // 37: the drawing tools are on by default, which shows Add shape beside Add model.
  // 38: the drying note's It's dry is not counted (see visibleControls): the note appears when the settings plan
  // finishes loading, before or after the count, which made the total 38 or 39 from run to run.
  // 39: the plate toolbar keeps still (static controls), so Drop to bed stays in place, disabled with nothing
  // selected, and Arrange options always shows beside Arrange all.
  // 42: the plate picker replaces the plate chip, which was a label, with Previous plate, the plate (which opens every
  // plate, with Add plate) and Next plate. They keep their places with one plate, so adding one moves nothing.
  // 44: every loaded spool shows in the Filament section, not only the ones in use (two more on the reference AMS).
  expect(list.length).toBeLessThanOrEqual(44)
})

test('a saved Preview tab opens Slice, with no Preview tab in the bar', async ({ page }) => {
  // A start with the old Preview tab saved: the stored prefs say so, and the page loads again.
  await page.evaluate(() => {
    const key = 'slicerx.prefs.v1'
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), workspace: 'preview' }))
  })
  await page.reload()
  await viewportReady(page)
  await expect(page.locator(':is(.sx-tab, .phone-tab)[aria-current=page]')).toHaveText('Slice')
  await expect(page.locator(':is(.sx-tab, .phone-tab)', { hasText: 'Preview' })).toHaveCount(0)
})

// ---- top bar -------------------------------------------------------------------------------------------------

const LONG = 'Bracket for the left side of the garage shelf, second try with thicker ribs.sx3mf'

/** Every direct child of the bar and of the tabs lies inside the bar, and neither scrolls sideways. */
async function noOverflow(page: Page): Promise<void> {
  const r = await page.locator('.sx-appbar').evaluate((bar) => {
    const b = bar.getBoundingClientRect()
    const nav = bar.querySelector('.sx-tabs')!
    const kids = [...bar.children, ...nav.children].filter((el) => (el as HTMLElement).offsetParent !== null)
    const out = kids.filter((el) => {
      const k = el.getBoundingClientRect()
      return k.left < b.left - 0.5 || k.right > b.right + 0.5
    })
    return { barScroll: bar.scrollWidth - bar.clientWidth, navScroll: nav.scrollWidth - nav.clientWidth, out: out.map((el) => el.className) }
  })
  expect(r).toEqual({ barScroll: 0, navScroll: 0, out: [] })
}

/** Opens Printers from the bar: its tab, or More's first item. */
async function openPrinters(page: Page): Promise<void> {
  const printers = page.getByTestId('tab-printers')
  if (await printers.isVisible()) await printers.click()
  else {
    await page.getByTestId('tab-overflow').click()
    const items = page.getByRole('menu', { name: 'More tabs' }).getByRole('menuitem')
    await expect(items.first()).toHaveText(/Printers/)
    await page.getByTestId('tab-overflow-printers').click()
  }
  await expect(page.locator('.sx-appbar [aria-current="page"]')).toHaveAttribute('data-testid', /^tab-(printers|overflow)$/)
}

test('the top bar fits from 1440 px down to the 960 px minimum, Printers stays one click away, and the room comes back', async ({ page }, info) => {
  await goSlice(page)
  await atSize(page, { width: 1440, height: 800 }, async () => {
    try {
      for (const [width, labels] of [[1440, true], [1100, true], [960, false]] as const) {
        await page.setViewportSize({ width, height: 800 })
        await goSlice(page)
        // A long project name, as an opened file sets it.
        await setState(page, { projectFile: { name: LONG, path: `/home/maker/${LONG}` } })
        const name = page.locator('.sx-projname')
        await expect(name).toContainText('Bracket for the left')
        await noOverflow(page)
        // The name truncates with an ellipsis, and its tip has the whole path.
        const cut = await name.locator('b').evaluate((el) => ({ truncated: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }))
        if (width < 1440) expect(cut).toEqual({ truncated: true, overflow: 'ellipsis' })
        await expect(name).toHaveAttribute('data-tip-title', `/home/maker/${LONG}`)
        // Model and Slice keep their labels down to 1100 px at least.
        if (labels) {
          await expect(page.getByTestId('tab-model').locator('span')).toBeVisible()
          await expect(page.getByTestId('tab-prepare').locator('span')).toBeVisible()
        }
        if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath(`top-bar-${width}.png`), clip: { x: 0, y: 0, width, height: 120 } })
        await openPrinters(page)
        await noOverflow(page)
      }
      // The window widens again: the tabs come back out of More.
      await page.setViewportSize({ width: 1440, height: 800 })
      await expect(page.getByTestId('tab-printers')).toBeVisible()
      await expect(page.getByTestId('tab-overflow')).toHaveCount(0)
      await expect(page.locator('.sx-appbar')).not.toHaveAttribute('data-narrow-tabs', /.*/)
    } finally {
      await setState(page, { projectFile: null })
    }
  })
  await goSlice(page)
})

// ---- export menu ---------------------------------------------------------------------------------------------

test('the Export menu is not cut off by the side pane', async ({ page }, info) => {
  await goSlice(page)
  await dismiss(page)
  await addMenu(page, 'Export')
  const menu = page.getByRole('menu', { name: 'Export' })
  await expect(menu).toBeVisible()
  const bounds = (await menu.boundingBox())!
  const view = page.viewportSize()!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(view.width)
  // its items keep their one line instead of wrapping in a squeezed column
  const item = (await menu.getByRole('menuitem', { name: /Save project/ }).boundingBox())!
  expect(item.height).toBeLessThan(40)
  // the menu's own right edge is the topmost thing there: nothing clips or covers it
  const onTop = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[role="menu"]')), { x: bounds.x + bounds.width - 6, y: bounds.y + 12 })
  expect(onTop).toBe(true)
  if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath('export-menu.png') })
  await dismiss(page)
})

// ---- edge tabs -----------------------------------------------------------------------------------------------

const viewWidth = (page: Page) => page.locator('.vp').evaluate((el) => Math.round(el.getBoundingClientRect().width))
const canvasWidth = (page: Page) => page.locator('.vp canvas').first().evaluate((el) => Math.round(el.getBoundingClientRect().width))
const target = (page: Page) => page.evaluate(() => (window as unknown as { __vp: { getCamera(): { target: number[] } } }).__vp.getCamera().target)

/**
 * Waits for the view to reach a width with no pane sliding or camera framing, then for the canvas to fill it. The panes are checked
 * before the width is read: two reads in one frame of a slide match, and the slide can end before a later check.
 */
async function viewAt(page: Page, ok: (w: number) => boolean): Promise<number> {
  let last = -1
  await expect
    .poll(async () => {
      await panesSettled(page)
      const still = await page.evaluate(() => !(window as unknown as { __vp: { stats(): { cameraMoving: boolean } } }).__vp.stats().cameraMoving)
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
  const edge = page.getByTestId(`edge-tab-${side}`)
  const body = page.getByTestId(panel)
  await expect(edge).toHaveAttribute('data-panel', panel)
  await expect(edge).toHaveAttribute('aria-expanded', 'true')
  await expect(body).toBeVisible()
  const before = await viewAt(page, () => true)
  const paneWidth = shutsFully ? await page.locator(`.pane[data-side="${side}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().width)) : 0
  const cam = await target(page)
  await edge.click()
  await expect(edge).toHaveAttribute('aria-expanded', 'false')
  await expect(body).toBeHidden()
  // The view and its canvas take the freed width: all of the pane's on Model, all but the icon rail on Slice.
  await viewAt(page, (w) => (shutsFully ? w - before >= paneWidth - 2 : w - before > 180))
  // No jump: the camera keeps its target, so the model stays at the middle of the wider view.
  expect(await target(page)).toEqual(cam)
  await edge.click()
  await expect(edge).toHaveAttribute('aria-expanded', 'true')
  await expect(body).toBeVisible()
  await viewAt(page, (w) => Math.abs(w - before) <= 1)
  // The key does the same.
  await page.mouse.move(700, 300)
  await page.keyboard.press(key)
  await expect(edge).toHaveAttribute('aria-expanded', 'false')
  await expect(body).toBeHidden()
  await page.keyboard.press(key)
  await expect(body).toBeVisible()
}

/** Opens the side panes of the tab bar in view, and shuts the bottom panel: where a fresh start has them. */
async function panesAsStarted(page: Page): Promise<void> {
  for (const side of ['left', 'right'] as const) {
    const edge = page.getByTestId(`edge-tab-${side}`)
    if ((await edge.getAttribute('aria-expanded')) === 'false') await edge.click()
    await expect(edge).toHaveAttribute('aria-expanded', 'true')
  }
  // Model's timeline starts shut. (Slice's bottom tab is the playback sliders, which belong to the slice.)
  const bottom = page.getByTestId('edge-tab-bottom')
  if ((await bottom.count()) && (await bottom.getAttribute('data-panel')) === 'model-timeline' && (await bottom.getAttribute('aria-expanded')) === 'true') {
    await bottom.click()
    await expect(bottom).toHaveAttribute('aria-expanded', 'false')
  }
  await viewSized(page)
}

/** Model, with every pane as a fresh start has it. */
async function goModel(page: Page): Promise<void> {
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect(page.locator('.studio[data-model-mode="design"]')).toBeVisible()
  await panesAsStarted(page)
}

/** Slice, with every pane as a fresh start has it. */
async function backToSlice(page: Page): Promise<void> {
  await goSlice(page)
  await page.locator('.sx-tab[data-mode="slice"]').click()
  await panesAsStarted(page)
}

test.describe('edge tabs', () => {
  test('Model: the tree, the tool pane and the timeline shut and open from their tabs and keys', async ({ page }) => {
    await box(page)
    await goModel(page)
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
    await page.keyboard.press('ControlOrMeta+j')
    await expect(timeline).toBeHidden()
    await backToSlice(page)
  })

  test('Slice: the sidebar shuts to its icon rail, and the slice summary shuts and opens', async ({ page }) => {
    await box(page)
    await backToSlice(page)
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
    await box(page)
    await goModel(page)
    try {
      await page.getByTestId('edge-tab-left').click()
      await expect(page.getByTestId('model-tree')).toBeHidden()
      // Shutting Model's tree leaves Slice's sidebar open.
      await page.locator('.sx-tab[data-mode="slice"]').click()
      await expect(page.getByTestId('slice-sidebar')).toBeVisible()
      await page.reload()
      await viewportReady(page)
      await expect(page.getByTestId('slice-sidebar')).toBeVisible()
      await expect(page.getByTestId('edge-tab-left')).toHaveAttribute('aria-expanded', 'true')
      await page.locator('.sx-tab[data-mode="design"]').click()
      await expect(page.getByTestId('edge-tab-left')).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByTestId('model-tree')).toBeHidden()
      await expect(page.getByTestId('edge-tab-right')).toHaveAttribute('aria-expanded', 'true')
    } finally {
      // The panes are saved: put Model's tree back for the tests after this one.
      const left = page.getByTestId('edge-tab-left')
      if ((await left.getAttribute('aria-expanded')) === 'false') await left.click()
      await backToSlice(page)
    }
  })
  // The tips naming the keys, and the phone's sheet tabs, are covered by packages/app/test/edge-tabs.test.ts:73 and :78.
})

// ---- pane edges ----------------------------------------------------------------------------------------------

const paneWidth = (page: Page) => page.locator('aside.pane').first().evaluate((el) => Math.round(el.getBoundingClientRect().width))
const sidebarEdge = (page: Page) => page.getByRole('separator', { name: /Resize printer and settings/i })

/**
 * The box of `el` once it has stopped moving. A pane slides its width (160 ms, longer on a busy runner), so a check
 * that the width passed a bound can pass mid-slide, and a box read then is not where the edge comes to rest: a drag
 * started there misses the 8 px edge and moves nothing.
 */
async function settledBox(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const seen: { box: { x: number; y: number; width: number; height: number } | null; last: string } = { box: null, last: '' }
  await expect
    .poll(async () => {
      seen.box = await el.boundingBox()
      const now = JSON.stringify(seen.box)
      const still = seen.box !== null && now === seen.last
      seen.last = now
      return still
    }, { intervals: [100] })
    .toBe(true)
  return seen.box!
}

/** The sidebar at its default width, the Slice tab, the panes open. */
async function defaultPanes(page: Page): Promise<void> {
  await goSlice(page)
  await layoutReset(page)
  await backToSlice(page)
  await viewSized(page)
}

test.describe('resizable panes', () => {
  test('resizing a pane does not reset the old canvas buffer first', async ({ page }) => {
    // Watches every write of the canvas width from here on: the page is already up, so no init script.
    await page.evaluate(() => {
      const state = window as unknown as { bufferWrites?: { previous: number; next: number }[] }
      if (state.bufferWrites) return
      state.bufferWrites = []
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!
      const read = descriptor.get!
      const write = descriptor.set!
      Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
        ...descriptor,
        set(this: HTMLCanvasElement, value: number) {
          const previous = read.call(this) as number
          write.call(this, value)
          if (this.matches('canvas.vp-canvas')) state.bufferWrites!.push({ previous, next: value })
        },
      })
    })
    await defaultPanes(page)
    try {
      await sidebarEdge(page).focus()
      await page.evaluate(() => { (window as unknown as { bufferWrites: unknown[] }).bufferWrites = [] })
      await page.keyboard.press('End')
      await expect.poll(() => paneWidth(page)).toBeGreaterThanOrEqual(540)
      await viewSized(page)
      const writes = await page.evaluate(() => (window as unknown as { bufferWrites: { previous: number; next: number }[] }).bufferWrites)
      expect(writes).toHaveLength(1)
      // Reassigning the current width clears the buffer and can block on software graphics.
      expect(writes.filter((w) => w.previous === w.next)).toEqual([])
    } finally {
      await layoutReset(page)
    }
  })

  test('the sidebar edge drags, responds to keys, collapses and reopens', async ({ page }) => {
    await defaultPanes(page)
    try {
      const edge = sidebarEdge(page)
      await expect(edge).toHaveAttribute('aria-orientation', 'vertical')
      const bounds = await settledBox(edge)
      const w0 = await paneWidth(page)
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 200)
      await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 200, { steps: 6 })
      await page.mouse.up()
      await expect.poll(() => paneWidth(page)).toBeGreaterThan(w0 + 60)
      // Keys: Home goes to the minimum, End to the maximum.
      await edge.focus()
      await page.keyboard.press('End')
      await expect.poll(() => paneWidth(page)).toBeGreaterThanOrEqual(540)
      await page.keyboard.press('Home')
      await expect.poll(() => paneWidth(page)).toBeLessThanOrEqual(250)
      // Dragging well past the minimum collapses to the rail, and a double-click opens it again.
      const b2 = await settledBox(edge)
      await page.mouse.move(b2.x + b2.width / 2, b2.y + 200)
      await page.mouse.down()
      await page.mouse.move(b2.x - 150, b2.y + 200, { steps: 8 })
      await page.mouse.up()
      await expect.poll(() => paneWidth(page)).toBeLessThan(80)
      await sidebarEdge(page).dblclick()
      await expect.poll(() => paneWidth(page)).toBeGreaterThan(200)
    } finally {
      await layoutReset(page)
    }
  })

  test('the edge has a tip, and the size survives a reload', async ({ page }) => {
    await defaultPanes(page)
    try {
      await sidebarEdge(page).focus()
      await page.keyboard.press('End')
      await expect.poll(() => paneWidth(page)).toBeGreaterThanOrEqual(540)
      // The width animates (a CSS transition on the rail); read it once it has stopped, not partway there.
      let wide = 0
      await expect
        .poll(async () => {
          const w = await paneWidth(page)
          const settled = w === wide
          wide = w
          return settled
        }, { intervals: [150] })
        .toBe(true)
      await page.reload()
      await viewportReady(page)
      // The saved width is a fraction of the window and rounds to a pixel either way.
      expect(Math.abs((await paneWidth(page)) - wide)).toBeLessThanOrEqual(1)
      await sidebarEdge(page).hover()
      await expect(page.locator('#sx-tip')).toContainText('Drag to resize. Double-click to collapse.')
    } finally {
      await layoutReset(page)
    }
  })

  test('dragging the playback bar shorter hides its sliders, and a double-click brings them back', async ({ page }) => {
    await defaultPanes(page)
    await slicedBox(page)
    const dock = page.getByRole('group', { name: 'Layers and moves' })
    await expect(dock).toHaveAttribute('data-mode', 'full')
    const edge = page.getByRole('separator', { name: /Resize the playback bar/i })
    await edge.focus()
    await page.keyboard.press('Home')
    await expect(dock).toHaveAttribute('data-mode', 'compact')
    // One more step down at the minimum collapses it to the slim bar.
    await page.keyboard.press('ArrowDown')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    await expect(dock.getByLabel('Layer', { exact: true })).toBeHidden()
    await edge.dblclick()
    await expect(dock).toHaveAttribute('data-mode', 'full')
  })
})

// ---- tab focus -----------------------------------------------------------------------------------------------

// Looks that bind Tab to the view switch take it only while the 3D view has focus. Anywhere else Tab moves focus as
// usual, so a keyboard user reaches the Printer card in every look. Of the four looks only slicerx (Tab is the switch)
// and bambu-studio (it is not) differ, so those two stand for all.
for (const look of ['slicerx', 'bambu-studio'] as const) {
  test(`${look}: Tab reaches the Printer card, and switches the view only from the 3D view`, async ({ page }) => {
    await exampleX(page)
    const was = await page.evaluate(() => (window as unknown as { __sx: { getState(): { lookAndFeel: Record<string, unknown> } } }).__sx.getState().lookAndFeel)
    const view = async () => { const s = await sx(page); return `${s.workspace}/${s.modelMode}/${s.sliceLook}` }
    try {
      await setState(page, { lookAndFeel: { ...was, id: look } })
      await expect(page.locator('.sx-block[data-section="printer"]')).toBeVisible()
      await viewSized(page)
      const before = await view()

      // From the top of the page, Tab walks the controls until it lands in the Printer card; the view never changes.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const printer = page.locator('.sx-block[data-section="printer"]')
      let reached = false
      for (let i = 0; i < 120 && !reached; i++) {
        await page.keyboard.press('Tab')
        const at = await page.evaluate(() => ({ canvas: document.activeElement?.classList.contains('vp-canvas') ?? false, printer: !!document.activeElement?.closest('.sx-block[data-section="printer"]') }))
        expect(at.canvas, 'the Printer card comes before the 3D view').toBe(false)
        reached = at.printer
      }
      expect(reached).toBe(true)
      await expect(printer.locator(':focus')).toHaveCount(1)
      expect(await view()).toBe(before)

      // On the focused 3D view, Tab is the switch in the looks that bind it, and focus stays on the view.
      const canvas = page.locator('canvas.vp-canvas').first()
      await canvas.focus()
      await page.keyboard.press('Tab')
      if (look === 'bambu-studio') {
        expect(await view()).toBe(before)
        await expect(canvas).not.toBeFocused()
      } else {
        await expect.poll(view).not.toBe(before)
        await expect(canvas).toBeFocused()
      }
    } finally {
      await setState(page, { lookAndFeel: was })
      await backToSlice(page)
    }
  })
}

// ---- Model and Slice -----------------------------------------------------------------------------------------

test.describe('Model and Slice', () => {
  test('there is no Preview tab, and tab-design still opens Model', async ({ page }) => {
    // Ctrl+E flipping the tabs and the order of the first tabs are covered by packages/app/test/mimir-tab.test.ts:36 and :75.
    await goSlice(page)
    await expect(page.locator('.sx-tab', { hasText: 'Preview' })).toHaveCount(0)
    // Model is tab-model, and answers to its old id, tab-design, while scripts move over.
    await expect(page.getByTestId('tab-model')).toHaveText('Model')
    await page.locator('[data-testid-alias="tab-design"]').click()
    await expect(page.getByTestId('tab-model')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.sx-tab', { hasText: 'Design' })).toHaveCount(0)
    await backToSlice(page)
  })

  test('Design has the tree, the shelf and the timeline; the shelf opens a tool in the side pane', async ({ page }) => {
    const id = await box(page)
    await goModel(page)
    const shelf = page.getByRole('toolbar', { name: 'Model tools' })
    await expect(shelf).toBeVisible()
    await expect(shelf.locator('.rb-grp')).toHaveCount(4)
    await expect(page.locator('.dtree-name', { hasText: 'Box' })).toBeVisible()
    // No plate toolbar and no Slice action in Design.
    await expect(page.getByRole('toolbar', { name: 'Plate tools' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Slice plate' })).toHaveCount(0)
    await shelf.locator('[data-tool="fillet"]').click()
    await expect(page.locator('.pane[data-side="right"] [data-section="cad-tool"]')).toContainText('Fillet')
    await page.keyboard.press('Escape')
    // A step made on the box shows in the tree and as a chip in the timeline.
    await page.locator('.dtree-name', { hasText: 'Box' }).click()
    await pushTop(page, id, 5)
    await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
    await page.getByRole('button', { name: 'Open Timeline' }).click()
    await expect(page.locator('.tl-chip')).toHaveCount(1)
    await expect(page.locator('.tl-chip')).toContainText('Pull 5')
    await backToSlice(page)
  })

  test('the timeline opens at the bottom edge of the view and closes when the pointer leaves', async ({ page }) => {
    await box(page)
    await goModel(page)
    const body = page.locator('.bpanel-body')
    await expect(page.getByTestId('edge-tab-bottom')).toBeVisible()
    await expect(body).toBeHidden()
    const view = (await page.locator('.vp').boundingBox())!
    await page.mouse.move(view.x + view.width / 3, view.y + view.height - 30)
    await page.mouse.move(view.x + view.width / 3 + 10, view.y + view.height - 24)
    await expect(body).toBeVisible()
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 3)
    await expect(body).toBeHidden({ timeout: 3000 })
    await backToSlice(page)
  })

  test('a modeling tool from the Slice Tools menu opens Design', async ({ page }) => {
    await box(page)
    await backToSlice(page)
    await addMenu(page, 'Tools')
    await page.getByRole('menuitem', { name: 'Sketch' }).click()
    await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('model-shelf').locator('[data-tool="sketch"]')).toHaveAttribute('aria-pressed', 'true')
    await setState(page, { objectTool: null })
    await backToSlice(page)
  })

  test('Slice shows the slice in place, toolpaths first and solid on request, and Model never shows it', async ({ page }) => {
    await box(page)
    await backToSlice(page)
    await setState(page, { sliceLook: 'toolpaths' })
    await sliceNow(page)
    const layersGroup = page.getByRole('group', { name: 'Layers and moves' })
    await expect(layersGroup).toBeVisible()
    const look = page.getByRole('radiogroup', { name: 'How the plate shows the slice' })
    // The slice command lands on the toolpaths just after the slice: pick Solid once that has settled.
    await expect(async () => {
      await look.getByRole('radio', { name: /^Solid/ }).click()
      await expect(page.locator('.studio[data-layers]')).toHaveCount(0, { timeout: 1000 })
    }).toPass({ timeout: 10_000 })
    await look.getByRole('radio', { name: /^Toolpaths/ }).click()
    await expect(page.locator('.studio[data-layers]')).toHaveCount(1)
    // Model never shows the slice: no toolpaths, layer slider or legend, and Slice brings them back.
    await expect(page.getByTestId('legend-color-by')).toBeVisible()
    await page.getByTestId('tab-model').click()
    await expect(page.locator('.studio[data-model-mode="design"]')).toBeVisible()
    // The slice is still there; Model just doesn't draw it.
    await expect(page.locator('.studio[data-layers]')).toHaveCount(0)
    await expect(layersGroup).toBeHidden()
    await expect(page.getByTestId('legend-color-by')).toBeHidden()
    await expect(page.getByTestId('legend-slot')).toHaveCount(0)
    await page.getByTestId('tab-prepare').click()
    await expect(page.locator('.studio[data-layers]')).toHaveCount(1)
    await expect(layersGroup).toBeVisible()
  })
})

// ---- toasts --------------------------------------------------------------------------------------------------

type Rect = { x: number; y: number; width: number; height: number }
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** The boxes of every visible control in the viewport a toast must not cover. */
async function controls(page: Page): Promise<{ name: string; box: Rect }[]> {
  return page.locator('.vp').evaluate((vp) => {
    const sel = ['.hud-bl > *', '.dock', '.plate-tools', '.slice-look', '.hud-top .hud-col > *']
    return sel.flatMap((s) =>
      [...vp.querySelectorAll<HTMLElement>(s)]
        .map((el) => ({ name: `${s} ${el.className}`, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .map(({ name, r }) => ({ name, box: { x: r.x, y: r.y, width: r.width, height: r.height } })),
    )
  })
}

/** The toast covers none of the viewport's controls. */
async function clearOfControls(page: Page, toast: Rect): Promise<void> {
  const hits = (await controls(page)).filter((c) => intersects(toast, c.box)).map((c) => c.name)
  expect(hits).toEqual([])
}

test.describe('toasts', () => {
  test('a toast sits above the plate bar, over the viewport, on no control', { tag: '@gpu' }, async ({ page }) => {
    await box(page)
    await defaultPanes(page)
    const toast = await postToast(page, 'Saved the plate.')
    await clearOfControls(page, toast)
    // Above the bar, not beside it.
    const bar = (await page.locator('.vp > .hud-bl').boundingBox())!
    expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y + 1)
    const vp = (await page.locator('.vp').boundingBox())!
    // Centered over the viewport (within a pixel of rounding).
    expect(Math.abs(toast.x + toast.width / 2 - (vp.x + vp.width / 2))).toBeLessThanOrEqual(1)
    // Still centered after the side pane changes width: the viewport moved, the stack follows.
    try {
      await setState(page, { paneSizes: { 'slicerx:prepare-left': 300 } })
      await expect.poll(async () => {
        const t = await postToast(page, 'Saved the plate again.')
        const v = (await page.locator('.vp').boundingBox())!
        return Math.round(Math.abs(t.x + t.width / 2 - (v.x + v.width / 2)))
      }).toBeLessThanOrEqual(1)
    } finally {
      await layoutReset(page)
    }
  })

  // A frame-exact race (a second ResizeObserver told in the same frame as the stack's own), so it is a nightly check.
  test('a toast is moved clear of a panel in the frame the panel opens', { tag: '@nightly' }, async ({ page }) => {
    await box(page)
    await goModel(page)
    await expect(page.getByTestId('edge-tab-bottom')).toBeVisible()
    await expect(page.locator('.bpanel-body')).toBeHidden()
    // All in the page, since a toast leaves after 2.6 s. A second observer on the panel, made after the stack's own, is
    // told of the panel's new size in the same frame and before it paints: where the toast lies then is where the first
    // frame of the open panel shows it.
    const covered = await page.evaluate(async () => {
      const store = (window as unknown as { __sx: { setState(p: unknown): void } }).__sx
      const nextFrame = () => new Promise((r) => requestAnimationFrame(r))
      store.setState({ toast: { id: Date.now(), text: 'Saved the plate.', tone: 'info' } })
      let stack = document.querySelector<HTMLElement>('[data-testid="toasts"]')
      for (let i = 0; !stack && i < 100; i++) {
        await nextFrame()
        stack = document.querySelector<HTMLElement>('[data-testid="toasts"]')
      }
      if (!stack) throw new Error('no toast stack')
      await Promise.all(stack.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)))
      await nextFrame()
      await nextFrame()
      const body = document.querySelector<HTMLElement>('.bpanel-body')!
      const edge = document.querySelector<HTMLElement>('[data-testid="edge-tab-bottom"]')!
      const apart = (a: DOMRect, b: DOMRect) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
      const firstFrame = new Promise<string[]>((resolve) => {
        const ro = new ResizeObserver(() => {
          if (body.hidden) return
          ro.disconnect()
          const toast = stack.getBoundingClientRect()
          resolve([['tab', edge], ['panel', body]].filter(([, el]) => !apart(toast, (el as HTMLElement).getBoundingClientRect())).map(([name]) => name as string))
        })
        ro.observe(body)
      })
      edge.click()
      return Promise.race([firstFrame, new Promise<string[]>((_, no) => setTimeout(() => no(new Error('the panel did not open')), 5000))])
    })
    expect(covered).toEqual([])
    await backToSlice(page)
  })

  test('with the toolpaths showing, a toast clears the playback panel, the layer slider and the view switch', { tag: '@gpu' }, async ({ page }) => {
    await slicedBox(page)
    await defaultPanes(page)
    await expect(page.locator('.vp > .dock')).toBeVisible()
    // The toast offset follows the panels a frame later, so a toast that lands as the panes settle is posted again.
    await expect
      .poll(async () => {
        const toast = await postToast(page, 'Saved the plate.')
        return (await controls(page)).filter((c) => intersects(toast, c.box)).map((c) => c.name)
      })
      .toEqual([])
  })

  test('away from the plate tab, toasts keep their place at the window bottom', { tag: '@gpu' }, async ({ page }) => {
    await toastAwayFromPlate(page)
  })
})

// ---- the Settings dialog -------------------------------------------------------------------------------------

const same = (a: Rect, b: Rect) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) <= 0.5

test('the Settings footer stays in view at 1440 x 768 and x 900, and sections move nothing', async ({ page }) => {
  await goSlice(page)
  const was = page.viewportSize()!
  for (const height of [768, 900]) {
    await atSize(page, { width: 1440, height }, async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await expect(dialog).toBeVisible()
      const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
      const parts = () => Promise.all([dialog, dialog.locator(':scope > .sx-dialog-h'), dialog.locator(':scope > .sx-dialog-foot'), nav].map(async (l) => (await l.boundingBox())!))
      const first = await parts()
      for (const name of await nav.getByRole('button').allTextContents()) {
        await nav.getByRole('button', { name: name.trim(), exact: true }).click()
        const now = await parts()
        now.forEach((b, i) => expect(same(b, first[i]!), `${name}: part ${i} moved`).toBe(true))
        // the footer's actions are inside the window and inside the dialog
        for (const label of [/^About /, /^Close$/]) {
          const b = (await dialog.locator(':scope > .sx-dialog-foot').getByRole('button', { name: label }).boundingBox())!
          expect(b.y + b.height).toBeLessThanOrEqual(Math.min(height, now[0]!.y + now[0]!.height))
        }
      }
      // a long section scrolls in the body, not the dialog
      await nav.getByRole('button', { name: 'Look and feel', exact: true }).click()
      const body = dialog.locator(':scope > .sx-dialog-body')
      if (height === 768) expect(await body.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)
      await body.evaluate((e) => e.scrollTo(0, e.scrollHeight))
      expect(await dialog.evaluate((e) => e.scrollTop)).toBe(0)
      const after = await parts()
      after.forEach((b, i) => expect(same(b, first[i]!), `scrolled: part ${i} moved`).toBe(true))
      await expect(dialog.locator(':scope > .sx-dialog-foot').getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
      await dialog.locator(':scope > .sx-dialog-foot').getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    })
  }
  expect(page.viewportSize()).toEqual(was)
})

// ---- the printer button's tip --------------------------------------------------------------------------------

// Tab focus showing the tip, and the keyboard closing the printer popover without bringing it back, are covered by
// packages/ui/test/tooltip-focus.test.ts:14 and :24.
test('the printer tip shows on hover, below the card and clear of the plate toolbar', async ({ page }) => {
  await exampleX(page)
  await mode(page, 'simple')
  await expect(page.getByTestId('slice-machine-card')).toBeVisible()
  const tip = page.locator('.sx-tip[data-ready]')
  await page.getByTestId('slice-machine-printer').hover()
  await expect(tip).toContainText('Pick another printer, or add one.')
  // A tip that opens while another is showing (warm) slides from the old spot to the new one over 120 ms, so a position
  // read right after it shows can still be the previous control's. The position is polled until the slide ends.
  await expect
    .poll(async () => {
      const t = await tip.boundingBox()
      const card = await page.getByTestId('slice-machine-card').boundingBox()
      return t && card ? t.y - (card.y + card.height) : -1
    })
    .toBeGreaterThanOrEqual(0)
  const t = (await tip.boundingBox())!
  const bar = await page.locator('.plate-tools').boundingBox()
  if (bar) expect(t.y >= bar.y + bar.height || t.x + t.width <= bar.x || t.x >= bar.x + bar.width).toBe(true)
  await page.mouse.move(700, 500)
})

// ---- the Slice sidebar fits ----------------------------------------------------------------------------------

const left = (page: Page) => page.locator('aside.pane[data-side="left"]')

/** How far the sidebar's settings scroll: 0 when everything is on screen. */
function overflow(page: Page): Promise<number> {
  return left(page).locator('.sx-rail-body').evaluate((el) => el.scrollHeight - el.clientHeight)
}

test.describe('the Slice sidebar at 1440 x 900', () => {
  test('Simple fits without scrolling, before and after a slice and with more objects, and the one Print is in its footer', async ({ page }) => {
    await box(page)
    await mode(page, 'simple')
    await defaultPanes(page)
    const body = left(page).locator('.sx-rail-body')
    await expect(body.getByTestId('slice-machine-card')).toBeVisible()
    await expect(body.locator('[data-section="filament"]')).toBeVisible()
    // The objects are in the right pane, not the sidebar.
    await expect(left(page).getByTestId('objects-list')).toHaveCount(0)
    await expect(page.getByTestId('slice-summary').getByTestId('objects-list')).toBeVisible()
    for (const id of ['slice-goal-standard', 'slice-machine-plate']) await expect(page.getByTestId(id)).toBeInViewport()
    await expect(page.getByRole('radiogroup', { name: 'Supports' })).toBeInViewport()
    expect(await overflow(page)).toBeLessThanOrEqual(1)
    await sliceNow(page)
    expect(await overflow(page)).toBeLessThanOrEqual(1)
    // The slice summary has no Print of its own: the one Print is in the sidebar footer.
    await expect(page.getByTestId('slice-summary').locator('[data-section="totals"]')).toBeVisible()
    await expect(page.getByTestId('slice-summary').getByRole('button', { name: /^Print/ })).toHaveCount(0)
    await expect(left(page).locator('.sx-rail-foot').getByTestId('danger-slice-print')).toBeVisible()
    await command(page, 'Add a cylinder')
    await command(page, 'Add a cylinder')
    await expect(page.getByTestId('slice-summary').getByTestId('object-row')).toHaveCount(3)
    expect(await overflow(page)).toBeLessThanOrEqual(1)
  })

  test('Advanced scrolls the printer and settings together above a fixed footer', async ({ page }) => {
    await box(page)
    await mode(page, 'advanced')
    await defaultPanes(page)
    const card = page.getByTestId('slice-machine-card')
    const before = await card.boundingBox()
    const footer = left(page).locator('.sx-rail-foot')
    const footerBefore = await footer.boundingBox()
    expect(await overflow(page)).toBeGreaterThan(0)
    await left(page).locator('.sx-rail-body').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(card).not.toBeInViewport()
    expect(await footer.boundingBox()).toEqual(footerBefore)
    await expect(footer).toBeInViewport()
    await left(page).locator('.sx-rail-body').evaluate((el) => el.scrollTo(0, 0))
    await expect(card).toBeInViewport()
    expect((await card.boundingBox())?.y).toBe(before?.y)
  })
})

// ---- tips ----------------------------------------------------------------------------------------------------

// One hover per kind of tip: a tip that takes no presses, one beside the sidebar, one on the legend, one with a recorded
// clip, one with a loop and one with a still. The rest of the loops and stills are checked by packages/app/test/demo-loop.test.ts:138-266.
test.describe('tips', () => {
  test('the lock button\'s tip closes as the pointer moves to the name under it, and the name takes the click', async ({ page }) => {
    await exampleX(page)
    await mode(page, 'simple')
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

  test('a tip in the settings sidebar opens beside it, level with its control, and covers nothing in the sidebar', async ({ page }) => {
    await exampleX(page)
    await mode(page, 'advanced')
    await defaultPanes(page)
    await settingsReset(page)
    try {
      const pane = (await page.locator('.pane[data-side="left"]').boundingBox())!
      const tip = page.locator('#sx-tip')
      const beside = async (anchor: Locator, text: string) => {
        // Watch from the first positioned frame, not only after the entrance transition has finished.
        const positions = page.evaluate(() => new Promise<number[]>((resolve, reject) => {
          const xs: number[] = []
          const timeout = window.setTimeout(() => { observer.disconnect(); reject(new Error('Tip did not become positioned')) }, 5000)
          const observer = new MutationObserver(() => {
            const el = document.querySelector<HTMLElement>('#sx-tip[data-ready]')
            if (!el) return
            observer.disconnect()
            window.clearTimeout(timeout)
            const start = performance.now()
            const sample = () => {
              xs.push(el.getBoundingClientRect().left)
              if (performance.now() - start < 180) requestAnimationFrame(sample)
              else resolve(xs)
            }
            sample()
          })
          observer.observe(document.body, { subtree: true, childList: true, attributes: true })
        }))
        await anchor.hover()
        await expect(tip).toContainText(text)
        await expect(tip).toHaveAttribute('data-ready', 'true')
        const tb = (await tip.boundingBox())!
        const a = (await anchor.boundingBox())!
        const xs = await positions
        // clear of the sidebar, so the next row and the control under it stay in view
        expect(tb.x).toBeGreaterThanOrEqual(pane.x + pane.width)
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(pane.x + pane.width)
        // level with its control
        expect(tb.y).toBeLessThanOrEqual(a.y + a.height)
        expect(tb.y + tb.height).toBeGreaterThanOrEqual(a.y)
        await page.mouse.move(pane.x + pane.width + 300, 40)
        await expect(tip).toHaveCount(0)
      }
      // sleipnir on the layer height, over Supports' segment before
      await beside(page.locator('#easy-layer'), 'sleipnir changes the layer height')
      // Reopen while the tip is warm, without scrolling to a different control.
      await beside(page.locator('#easy-layer'), 'sleipnir changes the layer height')
      // aegis on the wall generator, in the open Walls section of Quality: the option keeps its name, and its tip names it over the longer copy
      await setState(page, { expertOpen: true, settingsTab: 'quality', settingsSections: { 'quality/walls': true } })
      const aegis = page.locator('[data-key="wall_generator"]').getByRole('radio', { name: 'aegis' })
      // scrolled into view inside the sidebar only, so the page itself stays put
      await aegis.evaluate((el) => {
        const body = el.closest('.sx-rail-body')!
        body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 120
      })
      await beside(aegis, 'aegis varies wall width')
    } finally {
      await settingsReset(page)
    }
  })

  test('a tip on a row of the legend opens beside the legend and covers none of its rows', async ({ page }) => {
    await exampleX(page)
    await mode(page, 'advanced')
    await sliceNow(page)
    const legend = page.getByRole('list', { name: 'Toolpath legend' })
    const rows = legend.locator('.legend-markers label')
    await expect(rows.nth(1)).toBeVisible({ timeout: 40_000 })
    const tip = page.locator('#sx-tip')
    const n = await rows.count()
    for (let i = 0; i < n - 1; i++) {
      await rows.nth(i).hover()
      await expect(tip).toHaveAttribute('data-ready', 'true')
      // the next row, and every other row of the legend, stays in view; a tip that opens warm, right after the last one
      // closed, appears in place rather than gliding in from the corner
      const overlaps = () =>
        page.evaluate((i) => {
          const t = document.getElementById('sx-tip')!.getBoundingClientRect()
          const list = document.querySelector('[aria-label="Toolpath legend"]')!.getBoundingClientRect()
          const next = document.querySelectorAll('.legend-markers label')[i + 1]!.getBoundingClientRect()
          const over = (b: DOMRect) => t.left < b.right && b.left < t.right && t.top < b.bottom && b.top < t.bottom
          const at = (b: DOMRect) => `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`
          return over(next) || over(list) ? `tip ${at(t)} over the legend ${at(list)} or the next row ${at(next)}` : 'clear'
        }, i)
      await expect.poll(overlaps, { message: `tip of row ${i}`, timeout: 2_000 }).toBe('clear')
      await page.mouse.move(5, 5)
      await expect(tip).toHaveCount(0)
    }
  })

  test('a real-app clip shows its poster on the first hover, fetches the clip only then, and stays still under reduced motion', async ({ page }) => {
    await exampleX(page)
    await mode(page, 'simple')
    const fetched: string[] = []
    const onRequest = (r: { url(): string }) => {
      if (/\/(paint|arrange|color-by|layer-add|toolhead|follow)-(dark|light)-[^/]*\.webp/.test(r.url())) fetched.push(r.url())
    }
    page.on('request', onRequest)
    const motion = (await sx(page)).motion
    try {
      // no clip has loaded before the first hover
      expect(fetched).toEqual([])
      const arrange = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Arrange all' })
      const tip = page.locator('#sx-tip')
      await arrange.hover()
      await expect(tip).toContainText('Nest every object')
      await expect.poll(() => tip.locator('.sx-demo-poster').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320)
      const loop = tip.locator('.sx-demo-loop')
      await expect(loop).toHaveAttribute('data-ready', 'true')
      expect(await loop.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320)
      // its own clip and poster, for the theme in use, and no other clip
      expect(fetched.length).toBeGreaterThanOrEqual(2)
      expect(fetched.every((u) => /\/arrange-(dark|light)-/.test(u))).toBe(true)
      expect(fetched.some((u) => /\/arrange-(dark|light)-poster-/.test(u))).toBe(true)
      expect(fetched.some((u) => /\/arrange-(dark|light)-(?!poster)/.test(u))).toBe(true)
      await page.mouse.move(5, 5)
      await expect(tip).toHaveCount(0)
      // reduced motion: the poster, never the clip
      await setState(page, { motion: 'reduced' })
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced', { timeout: 30_000 })
      await arrange.hover()
      await expect(tip.locator('.sx-demo-poster')).toBeVisible()
      await page.waitForTimeout(1200)
      await expect(tip.locator('.sx-demo-loop')).toBeHidden()
    } finally {
      page.off('request', onRequest)
      await page.mouse.move(5, 5)
      await setState(page, { motion })
    }
  })

  test('a tip with a loop holds its size while the loop loads, waits on its finished frame, then plays, in either theme', async ({ page }) => {
    await exampleX(page)
    await mode(page, 'simple')
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
    await page.mouse.move(5, 5)
  })

  test('Model controls show their stills', async ({ page }) => {
    await box(page)
    await goModel(page)
    const tip = page.locator('#sx-tip')
    const stage = tip.locator('.sx-stage')
    // a still is told apart by its figure's label, the sentence under it
    const shows = async (anchor: Locator, label: string) => {
      await anchor.hover()
      await expect(stage.locator('svg.sxs'), label).toBeVisible()
      await expect(stage, label).toHaveAttribute('aria-label', label)
      await page.mouse.move(5, 5)
      await expect(tip).toHaveCount(0)
    }
    await shows(page.locator('.dtree-folder-name', { hasText: 'Bodies' }), 'Each entry in the tree is one thing in the view: a sketch lies on its plane, a body stands on the plate.')
    await shows(page.locator('[data-testid="model-shelf-tool"][data-tool="measure"]'), 'Pick two places: the panel gives the distance between them and how far apart they are along X, Y and Z.')
    await backToSlice(page)
  })
})
