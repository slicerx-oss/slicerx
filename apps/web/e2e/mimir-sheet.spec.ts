// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet in the mimir tab, laid out as a drawing: while a sheet waits, the view is a drawing sheet in
// four views with numbered callouts, and the sizes panel docks on the right. A callout picks its row, an edit marks
// the row as yours, and nothing builds until Build; Cancel builds nothing. After the build, Edit sizes brings the
// panel back and a tied row edits its step. Nothing on the panel moves while it is used. Screenshots in both themes go
// to the test output for review.
import { type Page } from '@playwright/test'
import { expect, test, viewportReady } from './fixtures'

type Sx = { setState(p: unknown): void; getState(): { plate: { name: string; history?: { steps: { params: { spec?: { distanceMm?: number } } }[] } }[] } }

async function open(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ([scheme]) => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, scheme, themeFollowsSystem: false }))
    },
    [scheme] as const,
  )
  await page.goto('./')
  await viewportReady(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.getByTestId('tab-mimir').click()
  await expect(page.getByTestId('mimir-chat')).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('mimir-composer')
  await composer.getByRole('textbox').fill(text)
  await composer.getByRole('button', { name: 'Send' }).click()
}

const boxes = (page: Page, ids: string[]) => Promise.all(ids.map(async (id) => (await page.getByTestId(id).boundingBox())!))

function still(before: { x: number; y: number; width: number; height: number }[], after: typeof before): void {
  after.forEach((a, i) => {
    const b = before[i]!
    expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))).toBeLessThanOrEqual(0.5)
  })
}

const plate = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((e) => ({ name: e.name, width: e.history?.steps[0]?.params.spec?.distanceMm ?? null })))

test.describe('the dimension sheet', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only: phones have no modeling tabs')

  test('draws the part in four views with callouts, edits on the panel, builds on Build, then drives the step', async ({ page }) => {
    await open(page, 'dark')
    await send(page, 'Make me a stand for my phone')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'An iPhone 15' }).click()
    const drawing = page.getByTestId('mimir-sheet-drawing')
    const panel = page.getByTestId('mimir-sheet-panel')
    await expect(drawing).toBeVisible()
    await expect(panel).toHaveAttribute('data-mode', 'confirm')
    await expect(page.locator('.studio > .vp')).toHaveAttribute('data-mimir-sheet', 'drawing')
    await expect(page.getByTestId('mimir-caption')).toHaveText('Drawing, four views')
    // the units and state sit in the top bar beside the caption, off the views
    await expect(page.getByTestId('mimir-drawing-status')).toHaveText('Backplate sizesmmNot built yet')
    // the record in the chat numbers its rows as the callouts, and its button builds
    const rec = page.getByTestId('mimir-sheet-record')
    await expect(rec.locator('.sheet-rec-n')).toHaveText(['1', '2', '3', '4', '5', '6', '7'])
    await expect(rec.getByTestId('mimir-sheet-confirm')).toHaveText('Confirm sizes and build')
    await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(4)
    // six of the seven sizes sit on the stand (the phone's width is the phone's): each in one flat view and the iso
    await expect(page.getByTestId('mimir-sheet-callout')).toHaveCount(12)
    // every callout stays in its cell, clear of the others there
    const cells = await drawing.locator('.mimir-drawing-cell').evaluateAll((els) =>
      els.map((cell) => {
        const r = cell.getBoundingClientRect()
        return { r: r.toJSON() as DOMRect, dots: Array.from(cell.querySelectorAll('.mimir-callout circle'), (c) => (c as SVGCircleElement).getBoundingClientRect().toJSON() as DOMRect) }
      }),
    )
    for (const { r, dots } of cells) {
      for (const d of dots) {
        expect(d.left).toBeGreaterThanOrEqual(r.left - 0.5)
        expect(d.right).toBeLessThanOrEqual(r.right + 0.5)
        expect(d.top).toBeGreaterThanOrEqual(r.top - 0.5)
        expect(d.bottom).toBeLessThanOrEqual(r.bottom + 0.5)
      }
      for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) expect(Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y)).toBeGreaterThanOrEqual(19)
    }
    // the drawing and the panel split the view; the panel is 372 px on the right
    const vp = (await page.locator('.studio > .vp').boundingBox())!
    const pb = (await panel.boundingBox())!
    expect(Math.abs(pb.x + pb.width - (vp.x + vp.width))).toBeLessThanOrEqual(0.5)
    expect(Math.abs(pb.width - 372)).toBeLessThanOrEqual(0.5)
    expect((await drawing.boundingBox())!.width).toBeCloseTo(vp.width - 372, 0)
    const rows = page.getByTestId('mimir-sheet-row')
    await expect(rows).toHaveCount(7)
    await expect(panel.locator('[data-testid="mimir-sheet-row"][data-guess]')).toHaveCount(5)
    await expect(panel.locator('.mimir-sheet-msg')).toHaveText('5 guesses to check')
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-dark.png') })

    // a callout picks its row; an edit makes the row yours, and nothing on the panel moves
    const fixed = ['mimir-sheet-build', 'mimir-sheet-cancel', 'mimir-sheet-hint']
    const before = await boxes(page, fixed)
    await page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"]').first().click()
    const field = page.locator('[data-testid="mimir-sheet-row"][data-key="case_allowance"] input')
    await expect(field).toBeFocused()
    await expect(page.locator('[data-testid="mimir-sheet-row"][data-key="case_allowance"]')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-on]')).toHaveCount(2)
    await expect(page.getByTestId('mimir-sheet-hint')).toContainText('0 to 6 mm')
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-editing-dark.png') })
    await field.fill('2')
    await field.press('Enter')
    await expect(page.locator('[data-testid="mimir-sheet-row"][data-key="case_allowance"] .mimir-chip')).toHaveText('Yours')
    await expect(panel.locator('.mimir-sheet-msg')).toHaveText('4 guesses to check')
    // a value outside the row's range is refused in place
    await field.fill('40')
    await field.press('Enter')
    await expect(page.locator('[data-testid="mimir-sheet-row"][data-key="case_allowance"] .sx-scrub')).toHaveAttribute('data-refused', /.*/)
    await field.press('Escape')
    still(before, await boxes(page, fixed))

    // Build confirms the panel's values; the drawing goes and the part is built from them
    await page.getByTestId('mimir-sheet-build').click()
    await expect(drawing).toHaveCount(0)
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.studio > .vp')).not.toHaveAttribute('data-mimir-sheet')
    const record = page.getByTestId('mimir-sheet-record')
    await expect(record).toContainText('Confirmed with 1 change')
    await expect(page.getByTestId('mimir-transcript')).toContainText('The stand is on the plate', { timeout: 30_000 })
    await expect.poll(() => plate(page)).toEqual([{ name: 'Phone stand', width: 35 }])

    // Edit sizes brings the panel back; a tied row edits its step, a sketch row says it needs a rebuild
    await record.getByTestId('mimir-sheet-open').click()
    await expect(panel).toHaveAttribute('data-mode', 'drive')
    await expect(drawing).toHaveCount(0)
    await expect(page.locator('[data-testid="mimir-sheet-row"][data-key="lean"] input')).toBeDisabled()
    const width = page.locator('[data-testid="mimir-sheet-row"][data-key="stand_width"] input')
    await width.fill('90')
    await width.press('Enter')
    await expect.poll(() => plate(page)).toEqual([{ name: 'Phone stand', width: 45 }])
    await expect(page.getByTestId('mimir-sheet-hint')).toContainText('Edited step 1')
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-drive-dark.png') })
    await page.getByTestId('mimir-sheet-close').click()
    await expect(panel).toHaveCount(0)
  })

  test('Cancel builds nothing and the record says so', async ({ page }) => {
    await open(page, 'dark')
    await send(page, 'Can you make a box with a lid?')
    await expect(page.getByTestId('mimir-sheet-drawing')).toBeVisible()
    await page.getByTestId('mimir-sheet-cancel').click()
    await expect(page.getByTestId('mimir-sheet-drawing')).toHaveCount(0)
    await expect(page.getByTestId('mimir-sheet-record')).toContainText('Canceled, nothing built')
    await expect(page.getByTestId('mimir-transcript')).toContainText('Nothing is built')
    await expect(page.getByTestId('mimir-sheet-open')).toHaveCount(0)
    expect(await plate(page)).toEqual([])
  })

  test('a toast keeps to the left of the sizes panel, off Build and Cancel', async ({ page }) => {
    await open(page, 'light')
    await send(page, 'Can you make a box with a lid?')
    await expect(page.getByTestId('mimir-sheet-panel')).toBeVisible()
    // The long one the viewport posts when the browser draws 3D on the processor.
    const text = 'Hardware acceleration looks off in this browser, so the 3D view will be slow. Turn it on in the browser settings and reload.'
    await page.evaluate((t) => (window as unknown as { __sx: Sx }).__sx.setState({ toast: { id: Date.now(), text: t, tone: 'info' } }), text)
    const toast = page.getByTestId('toast').filter({ hasText: 'Turn it on in the browser settings' }).last()
    await expect(toast).toBeVisible()
    await expect.poll(async () => (await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => el.getBoundingClientRect().right)))).toBeLessThanOrEqual((await page.getByTestId('mimir-sheet-panel').boundingBox())!.x)
  })

  test('screenshot, the backplate drawing, light', async ({ page }) => {
    await open(page, 'light')
    await send(page, 'I need a wall mount for this thermostat')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'Yes, that one' }).click()
    await expect(page.getByTestId('mimir-sheet-drawing')).toBeVisible()
    await expect(page.getByTestId('mimir-sheet-callout')).toHaveCount(12)
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-backplate-light.png') })
  })
})
