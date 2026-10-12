// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab: first in the bar, the chat on the left at 420 px and the design's view filling the rest, on the ground
// grid seen from the top while nothing is on the plate. The chat's edge resizes it between 340 px and half the window,
// and the width is kept. Screenshots in both themes go to the test output for review.
import { type Page } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type Sx = { setState(p: unknown): void; getState(): { modelMode: string; plate: unknown[]; paneSizes: Record<string, number> } }
type Vp = { camera: { position: { x: number; y: number; z: number } } }

async function open(page: Page, scheme: 'light' | 'dark' = 'dark', prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(
    ([scheme, prefs]) => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, scheme, themeFollowsSystem: false, ...prefs }))
    },
    [scheme, prefs] as const,
  )
  await page.goto('./')
  await viewportReady(page)
}

/** Clears the plate, then opens the mimir tab: the empty state. */
async function openEmpty(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  // the view lets go of the old plate first, so its refit can't land after the tab turns the camera
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { objects: Map<string, unknown> } }).__vp.objects.size)).toBe(0)
  await page.getByTestId('tab-mimir').click()
  await expect(page.getByTestId('mimir-chat')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const p = (window as unknown as { __vp: Vp }).__vp.camera.position
    return Math.abs(p.y) / Math.hypot(p.x, p.y, p.z)
  })).toBeGreaterThan(0.95)
}

test.describe('the mimir tab', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only: phones have no modeling tabs')

  test('comes first, holds the chat at 420 px beside the view, and opens on the top view of the grid', async ({ page }) => {
    await open(page)
    const tabs = page.locator('.sx-tab[data-mode]')
    await expect(tabs).toHaveText(['mimir', 'Model', 'Slice'])
    await openEmpty(page)
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.studio[data-model-mode="mimir"]')).toBeVisible()
    const chat = (await page.getByTestId('mimir-chat').boundingBox())!
    const view = (await page.locator('.studio > .vp').boundingBox())!
    const studio = (await page.locator('.studio').boundingBox())!
    expect(chat.width).toBeCloseTo(420, 0)
    expect(chat.x).toBeCloseTo(studio.x, 0)
    // the view takes the rest of the width
    expect(view.x).toBeCloseTo(chat.x + chat.width, 0)
    expect(view.x + view.width).toBeCloseTo(studio.x + studio.width, 0)
    // composer pinned at the chat's bottom
    const composer = (await page.getByTestId('mimir-composer').boundingBox())!
    expect(chat.y + chat.height - (composer.y + composer.height)).toBeLessThan(24)
    // the top view: the camera looks straight down at the ground grid
    await expect(page.getByTestId('mimir-caption')).toHaveText('Top, XY')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const p = (window as unknown as { __vp: Vp }).__vp.camera.position
          return Math.abs(p.y) / Math.hypot(p.x, p.y, p.z)
        }),
      )
      .toBeGreaterThan(0.95)
    // no Slice or Model panes here; Model's timeline is
    await expect(page.locator('.studio > .pane')).toHaveCount(0)
    await expect(page.locator('.plate-tools')).toHaveCount(0)
  })

  test('shares the design with Model: the same plate either side of a switch', async ({ page }) => {
    await open(page)
    const before = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)
    await page.getByTestId('tab-mimir').click()
    await page.getByTestId('tab-model').click()
    await expect(page.getByTestId('model-tree')).toBeVisible()
    await page.getByTestId('tab-mimir').click()
    await expect(page.locator('.studio[data-model-mode="mimir"]')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)).toBe(before)
  })

  test('the chat edge resizes between 340 px and half the window, and the width is kept', async ({ page }) => {
    await open(page)
    await openEmpty(page)
    const edge = page.getByTestId('mimir-split').getByRole('separator')
    const chat = page.getByTestId('mimir-chat')
    const drag = async (dx: number) => {
      const b = (await edge.boundingBox())!
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 })
      await page.mouse.up()
    }
    await drag(80)
    expect((await chat.boundingBox())!.width).toBeCloseTo(500, -1)
    await drag(2000)
    expect((await chat.boundingBox())!.width).toBeCloseTo(720, 0)
    await drag(-2000)
    expect((await chat.boundingBox())!.width).toBeCloseTo(340, 0)
    await drag(100)
    const kept = Math.round((await chat.boundingBox())!.width)
    await page.reload()
    await viewportReady(page)
    await page.getByTestId('tab-mimir').click()
    await expect.poll(async () => Math.round((await chat.boundingBox())!.width)).toBe(kept)
  })

  test('an image dropped or attached rides on the message; the attach button and the composer stay put', async ({ page }) => {
    await open(page)
    await openEmpty(page)
    const attach = page.getByTestId('mimir-attach')
    const before = (await attach.boundingBox())!
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    await page.getByTestId('mimir-composer').locator('input[type="file"]').setInputFiles({ name: 'thermostat.png', mimeType: 'image/png', buffer: png })
    await expect(page.getByTestId('mimir-attachment')).toHaveText('thermostat.png')
    const after = (await attach.boundingBox())!
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5)
    // a file dropped on the chat joins it
    const drop = await page.evaluateHandle((b64) => {
      const dt = new DataTransfer()
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], 'wall.png', { type: 'image/png' }))
      return dt
    }, png.toString('base64'))
    await page.getByTestId('mimir-transcript').dispatchEvent('dragover', { dataTransfer: drop })
    await page.getByTestId('mimir-transcript').dispatchEvent('drop', { dataTransfer: drop })
    await expect(page.getByTestId('mimir-attachment')).toHaveCount(2)
    await page.getByRole('button', { name: 'Remove thermostat.png' }).click()
    await expect(page.getByTestId('mimir-attachment')).toHaveText('wall.png')
    await page.screenshot({ path: test.info().outputPath('mimir-attach-dark.png') })
  })

  test('the battle ravens stand still behind the chat, centered and out of the way, until a model answers', async ({ page }) => {
    await open(page)
    await openEmpty(page)
    const ravens = page.getByTestId('mimir-ravens')
    await expect(ravens).toHaveAttribute('data-shown', 'true')
    await expect(ravens).toHaveAttribute('aria-hidden', 'true')
    expect(await ravens.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none')
    // still: nothing in it animates
    expect(await ravens.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0)
    const chat = (await page.getByTestId('mimir-chat').boundingBox())!
    const r = (await ravens.boundingBox())!
    expect(r.width / chat.width).toBeGreaterThan(0.55)
    expect(r.width / chat.width).toBeLessThan(0.75)
    expect(Math.abs(r.x + r.width / 2 - (chat.x + chat.width / 2))).toBeLessThan(1)
    // the composer is still the top thing at its own spot
    const c = (await page.getByTestId('mimir-composer').boundingBox())!
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid]')?.getAttribute('data-testid'), [c.x + c.width / 2, c.y + c.height / 2])
    expect(hit).toBe('mimir-composer')
  })

  test('the docked chat stands aside on the mimir tab; its button keeps its place', async ({ page }) => {
    await open(page)
    const btn = page.locator('.mimir-btn')
    test.skip((await btn.count()) === 0, 'This build has no mimir dock')
    await btn.click()
    await expect(page.locator('.mimir-dock')).toBeVisible()
    const box = (await btn.boundingBox())!
    await page.getByTestId('tab-mimir').click()
    await expect(page.locator('.mimir-dock')).toHaveCount(0)
    await expect(btn).toBeHidden()
    expect((await btn.boundingBox()) ?? box).toEqual(box)
    await page.getByTestId('tab-model').click()
    await expect(page.locator('.mimir-dock')).toBeVisible()
  })

  test('scripted mimir asks, shows what it found as a card in the view, and the card closes but stays in the record', async ({ page }) => {
    await open(page)
    await openEmpty(page)
    const composer = page.getByTestId('mimir-composer')
    await composer.getByRole('textbox').fill('Hey mimir, I need a wall mount for this thermostat. Can we print it?')
    await composer.getByRole('button', { name: 'Send' }).click()
    const choice = page.getByTestId('mimir-choice')
    await expect(choice).toBeVisible()
    // picking moves nothing: both chips keep their boxes
    const chips = choice.getByRole('button')
    const before = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    await choice.getByRole('button', { name: 'Yes, that one' }).click()
    await expect(choice).toHaveAttribute('data-picked', 'same')
    const after = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    after.forEach((a, i) => {
      const b = before[i]!
      expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))).toBeLessThanOrEqual(0.5)
    })
    const card = page.getByTestId('mimir-lookup-card')
    await expect(card).toContainText('150.4 x 110.4 mm')
    await expect(card.getByRole('link')).toHaveAttribute('href', /^https:\/\/example\.com\//)
    // the card sits at the view's bottom, left aligned with the caption, at most 96 px tall
    const c = (await card.boundingBox())!
    const cap = (await page.getByTestId('mimir-caption').boundingBox())!
    const vp = (await page.locator('.studio > .vp').boundingBox())!
    expect(Math.abs(c.x - cap.x)).toBeLessThanOrEqual(0.5)
    expect(c.height).toBeLessThanOrEqual(96.5)
    expect(vp.y + vp.height - (c.y + c.height)).toBeLessThan(48)
    await page.screenshot({ path: test.info().outputPath('mimir-lookup-dark.png') })
    await page.getByTestId('mimir-lookup-close').click()
    await expect(card).toHaveCount(0)
    await expect(page.getByTestId('mimir-transcript').locator('[data-lookup-id]')).toHaveCount(1)
    // a second lookup: Escape on the focused card closes it
    await composer.getByRole('textbox').fill('another backplate for the thermostat')
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByTestId('mimir-choice')).toHaveCount(2)
    await page.getByTestId('mimir-choice').last().getByRole('button', { name: 'Yes, that one' }).click()
    await expect(card).toHaveCount(1)
    await card.focus()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
  })

  for (const scheme of ['dark', 'light'] as const) {
    test(`screenshot, empty, ${scheme}`, async ({ page }, info) => {
      await open(page, scheme)
      await openEmpty(page)
      await page.waitForTimeout(800)
      await page.screenshot({ path: info.outputPath(`mimir-empty-${scheme}.png`) })
    })
  }
})
