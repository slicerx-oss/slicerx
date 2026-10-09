// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The specs drive the Slice button, so they start with Auto slice off, and with the plate reveal off. auto-slice.spec.ts uses the plain
// test and gets the default (on); plate-reveal.spec.ts turns the reveal back on.
//
// Cold start waits on the app's own ready mark, `data-sx-ready` on the root element: "engine" once the app is up
// with the slicer loaded, "plate" once the first plate has loaded, "viewport" once the 3D view is up too. Nothing waits on a fixed time, so a slow
// machine (software WebGL, many pages starting at once) only takes longer and a fast one does not wait.
import { execFileSync, execSync } from 'node:child_process'
import { expect, test as base, type Locator, type Page } from '@playwright/test'

/** How long a cold start may take before a spec gives up, on a loaded machine with software graphics. */
export const COLD_START_MS = 120_000

/** Waits until the app is up with its slicer loaded. */
export async function appReady(page: Page): Promise<void> {
  await page.locator('html[data-sx-ready]').waitFor({ state: 'attached', timeout: COLD_START_MS })
}

/** Waits until the first plate has loaded (the example plate, or a restored one), then checks it is the layered X. */
export async function plateReady(page: Page): Promise<void> {
  await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible()
}

/** Waits until the plate has loaded and the 3D view is up, ready for picks, touches and a first frame. */
export async function viewportReady(page: Page): Promise<void> {
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
}

export const test = base.extend<object, { graphics: void }>({
  // The browser starts its graphics process with the first WebGL context, and drops it when the last page using it
  // closes. On a machine with software graphics that start can take over a minute, so a test that opened the first
  // page paid for it. One page with a live context stays open for the worker's run: the start is paid once, here,
  // before the first test, and not counted in any test's time. On the GPU (SX_E2E_GPU=1) the workers start theirs 2 s
  // apart, since several graphics processes starting at once can fail, and each worker logs the renderer it got.
  graphics: [
    async ({ browser }, use, worker) => {
      const gpu = process.env['SX_E2E_GPU'] === '1'
      if (gpu) await new Promise((r) => setTimeout(r, worker.parallelIndex * 2000))
      const holder = await browser.newPage()
      const renderer = await holder.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2')
        ;(window as unknown as { __holdGl: unknown }).__holdGl = gl
        const info = gl?.getExtension('WEBGL_debug_renderer_info')
        return gl === null ? 'none' : String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      })
      if (gpu) console.log(`worker ${worker.parallelIndex}: WebGL2 renderer ${renderer}`)
      await use()
      await holder.close()
    },
    { scope: 'worker', auto: true, timeout: 300_000 },
  ],
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      sessionStorage.setItem('sx-no-auto-slice', '1')
      // The plate reveal plays on a window's first plate; specs that compare pictures want the plate as it settles.
      sessionStorage.setItem('sx-reveal', 'off')
    })
    await use(context)
  },
  page: async ({ page }, use) => {
    // A reload can find the autosave of a plate a test never saved and offer it back before the reference plate
    // loads. No spec tests that offer, so it is dismissed wherever it shows up.
    await page.addLocatorHandler(page.getByRole('dialog', { name: 'Restore unsaved work?' }), async (dialog) => {
      await dialog.getByRole('button', { name: 'Discard' }).click()
    })
    // A page that goes to the app or reloads it has the app up, with the slicer loaded, before the spec goes on.
    const goto = page.goto.bind(page)
    const reload = page.reload.bind(page)
    page.goto = (async (...args: Parameters<Page['goto']>) => {
      const response = await goto(...args)
      await appReady(page)
      return response
    }) as Page['goto']
    page.reload = (async (...args: Parameters<Page['reload']>) => {
      const response = await reload(...args)
      await appReady(page)
      return response
    }) as Page['reload']
    await use(page)
  },
})
export { expect }

/** A top tab by its id (`model`, `prepare` for Slice, `library`, `printers`). The look can rename a tab, so specs do not type its label. */
export function tab(page: Page, id: string): Locator {
  return page.locator(`.sx-tab[data-tab="${id}"]`)
}

/** Opens a top tab by its id. On a narrow window the tabs past Model and Slice live in More. */
export async function goTab(page: Page, id: string): Promise<void> {
  if (await tab(page, id).isVisible()) return tab(page, id).click()
  await page.getByTestId('tab-overflow').click()
  await page.getByTestId(`tab-overflow-${id}`).click()
}

/** Checks that a tab's workspace is open: its tab is current, or More is, with the tab's name as its tip. */
export async function expectCurrentTab(page: Page, id: string, label: string): Promise<void> {
  if (await tab(page, id).isVisible()) return expect(tab(page, id)).toHaveAttribute('aria-current', 'page')
  const more = page.getByTestId('tab-overflow')
  await expect(more).toHaveAttribute('aria-current', 'page')
  await expect(more).toHaveAttribute('data-tip-title', label)
}

/** Checks a top tab's label, reading it from More when the tab is folded in there. */
export async function expectTabLabel(page: Page, id: string, label: string): Promise<void> {
  if (await tab(page, id).isVisible()) return expect(tab(page, id)).toContainText(label)
  await page.getByTestId('tab-overflow').click()
  await expect(page.getByTestId(`tab-overflow-${id}`)).toContainText(label)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'More tabs' })).toHaveCount(0)
}

/**
 * On a phone the side panes are bottom sheets: opens the one holding `panel` (slice-sidebar, slice-summary, model-tree,
 * model-inspector) and waits until it is up. Does nothing at desktop widths, where the panes are always there.
 */
export async function openSheet(page: Page, panel = 'slice-sidebar'): Promise<void> {
  // The studio settles once the plate is in; a sheet opened before that can close again as the panes mount.
  await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
  const tab = page.locator(`.sheet-tab[data-panel="${panel}"]`)
  if (!(await tab.count())) return
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click()
  await expect.poll(() => page.getByTestId(panel).evaluate((el) => el.closest('aside')!.getBoundingClientRect().top < innerHeight * 0.5)).toBe(true)
}

/** On a phone, closes an open side sheet so the view under it can be used. Does nothing when none is open. */
export async function closeSheet(page: Page): Promise<void> {
  const open = page.locator('.sheet-tab[aria-expanded="true"]')
  if (!(await open.count())) return
  await page.keyboard.press('Escape')
  await expect(open).toHaveCount(0)
  await expect.poll(() => page.locator('aside.pane.sheet').first().evaluate((el) => el.getBoundingClientRect().top >= innerHeight - 2)).toBe(true)
}

/** How many slices have finished so far. Read it before starting a slice, and pass it to `sliced`. */
export async function sliceCount(page: Page): Promise<number> {
  return Number((await page.locator('.studio').getAttribute('data-slices')) ?? 0)
}

/**
 * Slice showing the toolpaths of a slice of the plate as it is now: where a finished slice lands, now that there is
 * no Preview tab. With `after` (from `sliceCount`), only a slice that finished since then counts.
 */
export function sliced(page: Page, after?: number): Locator {
  return page.locator(`.studio[data-layers][data-slice="current"]${after === undefined ? '' : `:not([data-slices="${after}"])`}`)
}

/** What the look calls that tab right now, for the buttons and groups that carry its name. */
export async function tabName(page: Page, id: string): Promise<string> {
  return (await tab(page, id).getAttribute('aria-label')) ?? id
}

/**
 * Runs pnpm and waits for it. On Windows pnpm is a .cmd script, which only a shell starts (spawning it directly fails
 * with ENOENT), so there it goes through the shell with each argument quoted.
 */
export function pnpmSync(args: string[], cwd: string): void {
  if (process.platform === 'win32') execSync(['pnpm', ...args.map((a) => `"${a.replace(/"/g, '""')}"`)].join(' '), { cwd, stdio: 'ignore' })
  else execFileSync('pnpm', args, { cwd, stdio: 'ignore' })
}
