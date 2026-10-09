// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Toasts never cover the plate bar or the playback bar: on the plate tab they center over the viewport and sit above
// what it stacks along its bottom edge, at desktop and phone width.
import { expect, type Locator, type Page } from '@playwright/test'
import { plateReady, sliceCount, sliced, test } from './fixtures'
import { projectZip } from './project-zip'

type Sx = { setState(p: unknown): void }

const P1S = {
  printer_settings_id: 'Bambu Lab P1S 0.2 nozzle',
  printer_model: 'Bambu Lab P1S',
  printer_variant: '0.2',
  nozzle_diameter: ['0.2'],
  layer_height: '0.08',
  different_settings_to_system: ['layer_height', '', ''],
}

const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

async function open(page: Page): Promise<void> {
  await page.addInitScript((a1) => {
    // The store hook the checks use to post a toast and switch the theme.
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, handPrinters: [a1], printerId: a1.id }))
  }, A1_MINI)
  await page.goto('./')
  await plateReady(page)
}

/** Opens a Bambu Studio project, which posts "Opened as P1S 0.2 mm from the project." */
async function openProject(page: Page): Promise<Locator> {
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles({ name: 'keychain.3mf', mimeType: 'model/3mf', buffer: projectZip(P1S, {}, [118, 118]) })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
  const note = page.getByTestId('toast').filter({ hasText: 'Opened as P1S' })
  await expect(note).toBeVisible()
  return note
}

/** Slices the plate and waits for the toolpaths. */
async function slice(page: Page): Promise<void> {
  const before = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
}

type Box = { x: number; y: number; width: number; height: number }

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * Posts a toast the way the app does and returns its box once its entry animation has settled. Both happen in the
 * page, since a toast leaves after 2.6 s and a busy test machine can take that long between two steps.
 */
async function postToast(page: Page, text: string): Promise<Box> {
  return page.evaluate(async (t) => {
    const id = Date.now()
    ;(window as unknown as { __sx: Sx }).__sx.setState({ toast: { id, text: t, tone: 'info' } })
    const find = () => [...document.querySelectorAll<HTMLElement>('[data-testid="toast"]')].filter((n) => n.textContent?.includes(t)).pop()
    let el = find()
    for (let i = 0; !el && i < 100; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      el = find()
    }
    if (!el) throw new Error(`no toast reading ${t}`)
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)))
    // The offset follows the overlays a frame later.
    await new Promise((r) => requestAnimationFrame(r))
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, text)
}

/** The boxes of every visible control in the viewport a toast must not cover. */
async function controls(page: Page): Promise<{ name: string; box: Box }[]> {
  return page.locator('.vp').evaluate((vp) => {
    const sel = ['.hud-bl > *', '.dock', '.lstrip', '.plate-tools', '.slice-look', '.hud-top .hud-col > *']
    return sel.flatMap((s) =>
      [...vp.querySelectorAll<HTMLElement>(s)]
        .map((el) => ({ name: `${s} ${el.className}`, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .map(({ name, r }) => ({ name, box: { x: r.x, y: r.y, width: r.width, height: r.height } })),
    )
  })
}

/** The toast covers none of the viewport's controls. */
async function clearOfControls(page: Page, toast: Box): Promise<void> {
  const hits = (await controls(page)).filter((c) => intersects(toast, c.box)).map((c) => c.name)
  expect(hits).toEqual([])
}

test('a toast sits above the plate bar, over the viewport, on no control', { tag: '@gpu' }, async ({ page, isMobile }) => {
  await open(page)
  await openProject(page)
  const toast = await postToast(page, 'Saved the plate.')
  await clearOfControls(page, toast)
  // Above the bar, not beside it.
  const bar = (await page.locator('.vp > .hud-bl').boundingBox())!
  expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y + 1)
  const vp = (await page.locator('.vp').boundingBox())!
  const slider = page.locator('.vp .lstrip').first()
  if (isMobile && (await slider.count())) {
    // Left of the layer slider, inside the viewport.
    const box = (await slider.boundingBox())!
    expect(toast.x).toBeGreaterThanOrEqual(vp.x)
    expect(toast.x + toast.width).toBeLessThanOrEqual(box.x)
  } else {
    // Centered over the viewport (within a pixel of rounding).
    expect(Math.abs(toast.x + toast.width / 2 - (vp.x + vp.width / 2))).toBeLessThanOrEqual(1)
    // Still centered after the side pane changes width: the viewport moved, the stack follows.
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ paneSizes: { 'slicerx:prepare-left': 300 } }))
    await expect.poll(async () => {
      const t = await postToast(page, 'Saved the plate again.')
      const v = (await page.locator('.vp').boundingBox())!
      return Math.round(Math.abs(t.x + t.width / 2 - (v.x + v.width / 2)))
    }).toBeLessThanOrEqual(1)
  }
})

test('with the toolpaths showing, a toast clears the playback panel, the layer slider and the view switch', { tag: '@gpu' }, async ({ page }) => {
  test.slow()
  await open(page)
  await openProject(page)
  await slice(page)
  await expect(page.locator('.vp > .dock')).toBeVisible()
  // On a phone, slicing scrolled the page down to the Slice button; the viewport is at the top.
  await page.evaluate(() => window.scrollTo(0, 0))
  await clearOfControls(page, await postToast(page, 'Saved the plate.'))
})

test('away from the plate tab, toasts keep their place at the window bottom', { tag: '@gpu' }, async ({ page }) => {
  await open(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ workspace: 'printers' }))
  await expect(page.locator('.vp')).toHaveCount(0)
  const toast = await postToast(page, 'Saved the plate.')
  const height = page.viewportSize()!.height
  expect(Math.round(height - (toast.y + toast.height))).toBe(28)
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: a toast over the plate bar and over the playback bar, light and dark', { tag: '@gpu' }, async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  const sx = (patch: unknown) => page.evaluate((p) => (window as unknown as { __sx: Sx }).__sx.setState(p), patch)
  // A toast shows for 2.6 s, less than a full-page shot of the toolpaths can take here; for the shots it stays 8 s.
  await page.addInitScript(() => {
    const later = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => later(fn, ms === 2600 ? 8000 : ms, ...rest)) as typeof window.setTimeout
  })
  await open(page)
  await openProject(page)
  await slice(page)
  const text = 'Opened as P1S 0.2 mm from the project.'
  const toast = page.getByTestId('toast').filter({ hasText: text })
  // One toast per shot, with the viewport in view (on a phone the page scrolls under it). The shot is kept only when
  // the toast was still showing after it was taken; a toast leaves after 2.6 s.
  const shoot = async (name: string) => {
    for (let i = 0; i < 3; i++) {
      await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 20_000 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.mouse.move(0, 0)
      await postToast(page, text)
      await page.screenshot({ path: `${dir}/${name}-${width}.png` })
      if ((await toast.count()) > 0) return
    }
    throw new Error(`the toast left before the ${name} shot`)
  }
  for (const scheme of ['light', 'dark'] as const) {
    await sx({ scheme, themeFollowsSystem: false })
    // The new theme loads and redraws the app; a toast posted before that is gone with it.
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await expect(page.locator('.vp > .dock')).toBeVisible()
    await page.waitForTimeout(1500)
    await shoot(`toast-toolpaths-${scheme}`)
    await sx({ sliceLook: 'solid' })
    await expect(page.locator('.vp > .dock')).toHaveCount(0)
    await page.waitForTimeout(300)
    await shoot(`toast-plate-bar-${scheme}`)
    await sx({ sliceLook: 'toolpaths' })
  }
})
