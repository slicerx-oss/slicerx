// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Toasts never cover the plate bar or the playback bar: on the plate tab they center over the viewport and sit above
// what it stacks along its bottom edge, at desktop and phone width.
import { expect, type Locator, type Page } from '@playwright/test'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { closeSheet, openSheet, plateReady, sliceCount, sliced, test } from './fixtures'
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
  interceptFileDialogs(page)
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
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'keychain.3mf', mimeType: 'model/3mf', buffer: projectZip(P1S, {}, [118, 118]) })
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
    // The toasts up at once share one card, and the card is what sits on the page.
    const r = (el.closest<HTMLElement>('[data-testid="toasts"]') ?? el).getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, text)
}

/** The boxes of every visible control in the viewport a toast must not cover. */
async function controls(page: Page): Promise<{ name: string; box: Box }[]> {
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
async function clearOfControls(page: Page, toast: Box): Promise<void> {
  const hits = (await controls(page)).filter((c) => intersects(toast, c.box)).map((c) => c.name)
  expect(hits).toEqual([])
}

test('a toast sits above the plate bar, over the viewport, on no control', { tag: '@gpu' }, async ({ page }) => {
  await open(page)
  await openProject(page)
  const toast = await postToast(page, 'Saved the plate.')
  await clearOfControls(page, toast)
  // Above the bar, not beside it.
  const bar = (await page.locator('.vp > .hud-bl').boundingBox())!
  expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y + 1)
  const vp = (await page.locator('.vp').boundingBox())!
  // Centered over the viewport (within a pixel of rounding).
  expect(Math.abs(toast.x + toast.width / 2 - (vp.x + vp.width / 2))).toBeLessThanOrEqual(1)
  // Still centered after the side pane changes width: the viewport moved, the stack follows.
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ paneSizes: { 'slicerx:prepare-left': 300 } }))
  await expect.poll(async () => {
    const t = await postToast(page, 'Saved the plate again.')
    const v = (await page.locator('.vp').boundingBox())!
    return Math.round(Math.abs(t.x + t.width / 2 - (v.x + v.width / 2)))
  }).toBeLessThanOrEqual(1)
})

test('a toast is moved clear of a panel in the frame the panel opens', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The timeline is a desktop panel')
  await open(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await expect(page.getByTestId('edge-tab-bottom')).toBeVisible()
  await expect(page.locator('.bpanel-body')).toBeHidden()
  // All in the page, since a toast leaves after 2.6 s. A second observer on the panel, made after the stack's own, is
  // told of the panel's new size in the same frame and before it paints: where the toast lies then is where the first
  // frame of the open panel shows it.
  const covered = await page.evaluate(async () => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r))
    sx.setState({ toast: { id: Date.now(), text: 'Saved the plate.', tone: 'info' } })
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
    const tab = document.querySelector<HTMLElement>('[data-testid="edge-tab-bottom"]')!
    const apart = (a: DOMRect, b: DOMRect) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
    const firstFrame = new Promise<string[]>((resolve) => {
      const ro = new ResizeObserver(() => {
        if (body.hidden) return
        ro.disconnect()
        const toast = stack.getBoundingClientRect()
        resolve([['tab', tab], ['panel', body]].filter(([, el]) => !apart(toast, (el as HTMLElement).getBoundingClientRect())).map(([name]) => name as string))
      })
      ro.observe(body)
    })
    tab.click()
    return Promise.race([firstFrame, new Promise<string[]>((_, no) => setTimeout(() => no(new Error('the panel did not open')), 5000))])
  })
  expect(covered).toEqual([])
})

test('on a phone, a toast floats above an open sheet and leaves it where it is', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone width')
  await open(page)
  await openSheet(page)
  const sheet = page.locator('aside.pane.sheet-open')
  // measured once it has finished sliding up
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))))
  const before = (await sheet.boundingBox())!
  // A toast on the sheet would take the tap meant for the control under it.
  const toast = await postToast(page, 'Saved the plate.')
  expect(toast.y + toast.height).toBeLessThanOrEqual(before.y + 1)
  expect((await sheet.boundingBox())!.y).toBe(before.y)
  // Shut, the sheet frees the bottom again, and the stack goes back down over the plate bar.
  await closeSheet(page)
  const bar = (await page.locator('.vp > .hud-bl').boundingBox())!
  await expect.poll(async () => {
    const t = await postToast(page, 'Saved the plate again.')
    return Math.round(bar.y - (t.y + t.height))
  }).toBeGreaterThanOrEqual(0)
  expect((await postToast(page, 'Saved it once more.')).y).toBeGreaterThan(before.y)
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
  const { width, height } = page.viewportSize()!
  if (width > 900) {
    // It rests clear of the status bar along the window's bottom.
    const bar = (await page.locator('.sx-status').boundingBox())!
    expect(Math.round(bar.y - (toast.y + toast.height))).toBe(8)
  } else {
    // On a phone the toast keeps to the window bottom, above the tab bar when there is one.
    const tabs = page.getByTestId('phone-tabs')
    const tabH = (await tabs.isVisible()) ? (await tabs.boundingBox())!.height : 0
    expect(Math.round(height - (toast.y + toast.height))).toBe(tabH ? Math.round(tabH) + 12 : 28)
  }
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
