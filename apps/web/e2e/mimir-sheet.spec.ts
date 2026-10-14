// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension sheet in the mimir tab: while a sheet waits, the view is a drawing in four views with numbered
// callouts, and the sheet's record in the chat is where the sizes are typed. A callout focuses its row and a focused
// row lights its measurement. A guess stays assumed until a valid value is committed or it is kept with Enter; an
// empty, partial or out of range entry keeps nothing. A Sizes pill brings the record back once it scrolls away. Nothing
// builds until Confirm sizes and build, and Cancel builds nothing. After the build, Edit sizes brings the panel back
// and a tied row edits its step. Screenshots go to the test output for review.
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

  test('draws the part in four views with callouts, edits on the record, builds on Confirm, then drives the step', async ({ page }) => {
    await open(page, 'dark')
    await send(page, 'Make me a stand for my phone')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'An iPhone 15' }).click()
    const drawing = page.getByTestId('mimir-sheet-drawing')
    const rec = page.getByTestId('mimir-sheet-record')
    await expect(drawing).toBeVisible()
    // while it waits the drawing has the whole view; the record in the chat is the editor
    await expect(page.getByTestId('mimir-sheet-panel')).toHaveCount(0)
    await expect(page.locator('.studio > .vp')).toHaveAttribute('data-mimir-sheet', 'drawing')
    await expect(page.getByTestId('mimir-caption')).toHaveText('Drawing, four views')
    await expect(page.getByTestId('mimir-drawing-status')).toContainText('Not built yet')
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
    const status = rec.getByTestId('mimir-sheet-status')
    await expect(rec.locator('.sheet-rec-row[data-guess]')).toHaveCount(5)
    await expect(status).toHaveText('5 assumed values: room for a case 1.5 mm, lean angle 70 ° and 3 more')
    await expect(status).toHaveAttribute('data-assumed', '')
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-dark.png') })

    // a callout focuses its row on the record, and the focused row lights its measurement in the drawing
    const row = rec.locator('.sheet-rec-row[data-dim="case_allowance"]')
    const field = row.locator('input')
    await page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"]').first().click()
    await expect(field).toBeFocused()
    // from here on the record's buttons hold still while its rows and status change
    const fixed = ['mimir-sheet-confirm', 'mimir-sheet-cancel']
    const before = await boxes(page, fixed)
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-on]')).toHaveCount(2)
    await expect(page.locator('.mimir-dim[data-key="case_allowance"][data-on]')).toHaveCount(2)
    // the case room is measured over the part, so its callout sits on a leader
    await expect(page.locator('.mimir-dim[data-key="case_allowance"] > g:not(.mimir-dim-halo) .mimir-dim-leader').first()).toBeAttached()

    // an empty, partial, non-numeric or out of range entry keeps nothing: the guess stays assumed
    for (const typed of ['', '-', '.', '2x', '40']) {
      await field.fill(typed)
      await field.press('Enter')
      await expect(row).toHaveAttribute('data-guess', '')
      await expect(status).toHaveText(/^5 assumed values/)
    }
    await field.fill('-')
    await field.press('Tab')
    await expect(row).toHaveAttribute('data-guess', '')
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-source="guess"]')).toHaveCount(2)
    // a valid value committed clears it, and the row becomes yours
    await field.fill('2')
    await field.press('Enter')
    await expect(row).not.toHaveAttribute('data-guess')
    await expect(row.locator('.sheet-rec-tag')).toHaveText('yours')
    await expect(status).toHaveText(/^4 assumed values/)
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-source="guess"]')).toHaveCount(0)
    // Enter on a guess left as it is keeps it
    const lip = rec.locator('.sheet-rec-row[data-dim="lip_height"]')
    await lip.locator('input').click()
    await lip.locator('input').press('Enter')
    await expect(lip).not.toHaveAttribute('data-guess')
    await expect(lip.locator('.sheet-rec-tag')).toHaveText('kept')
    await expect(status).toHaveText(/^3 assumed values/)
    still(before, await boxes(page, fixed))

    // scrolled away, the Sizes pill brings the record back and puts the cursor in the first assumed size
    const transcript = page.getByTestId('mimir-transcript')
    await transcript.evaluate((el) => (el.scrollTop = 0))
    const pill = page.getByTestId('mimir-sizes-pill')
    await expect(pill).toBeVisible()
    await pill.click()
    await expect(pill).toHaveCount(0)
    await expect(rec.locator('.sheet-rec-row[data-dim="lean"] input')).toBeFocused()
    await expect(rec).toBeInViewport({ ratio: 0.6 })

    // Confirm sends the record's values; the drawing goes and the part is built from them
    await rec.getByTestId('mimir-sheet-confirm').click()
    await expect(drawing).toHaveCount(0)
    await expect(page.locator('.studio > .vp')).not.toHaveAttribute('data-mimir-sheet')
    await expect(rec).toContainText('Confirmed with 1 change')
    await expect(page.getByTestId('mimir-sizes-pill')).toHaveCount(0)
    await expect(page.getByTestId('mimir-transcript')).toContainText('The stand is on the plate', { timeout: 30_000 })
    await expect.poll(() => plate(page)).toEqual([{ name: 'Phone stand', width: 35 }])

    // Edit sizes brings the panel back; a tied row edits its step, a sketch row says it needs a rebuild
    const panel = page.getByTestId('mimir-sheet-panel')
    await rec.getByTestId('mimir-sheet-open').click()
    await expect(panel).toHaveAttribute('data-mode', 'drive')
    await expect(drawing).toHaveCount(0)
    await expect(page.locator('[data-testid="mimir-sheet-row"][data-key="lean"] input')).toBeDisabled()
    const width = page.locator('[data-testid="mimir-sheet-row"][data-key="stand_width"] input')
    await width.fill('90')
    await width.press('Enter')
    await expect.poll(() => plate(page)).toEqual([{ name: 'Phone stand', width: 45 }])
    await expect(page.getByTestId('mimir-sheet-hint')).toContainText('Edited step 1')
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-drive-dark.png') })

    // a toast keeps to the left of the panel, off its rows and Done
    const text = 'Hardware acceleration looks off in this browser, so the 3D view will be slow. Turn it on in the browser settings and reload.'
    await page.evaluate((t) => (window as unknown as { __sx: Sx }).__sx.setState({ toast: { id: Date.now(), text: t, tone: 'info' } }), text)
    const toast = page.getByTestId('toast').filter({ hasText: 'Turn it on in the browser settings' }).last()
    await expect(toast).toBeVisible()
    await expect.poll(async () => (await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => el.getBoundingClientRect().right)))).toBeLessThanOrEqual((await panel.boundingBox())!.x)
    await page.getByTestId('mimir-sheet-close').click()
    await expect(panel).toHaveCount(0)
  })

  test('Cancel on the record builds nothing and the record says so', async ({ page }) => {
    await open(page, 'dark')
    await send(page, 'Can you make a box with a lid?')
    await expect(page.getByTestId('mimir-sheet-drawing')).toBeVisible()
    const rec = page.getByTestId('mimir-sheet-record')
    await rec.getByTestId('mimir-sheet-cancel').click()
    await expect(page.getByTestId('mimir-sheet-drawing')).toHaveCount(0)
    await expect(rec).toContainText('Canceled, nothing built')
    await expect(page.getByTestId('mimir-transcript')).toContainText('Nothing is built')
    await expect(page.getByTestId('mimir-sheet-open')).toHaveCount(0)
    expect(await plate(page)).toEqual([])
  })

  test('screenshot, the backplate drawing, light', async ({ page }) => {
    await open(page, 'light')
    await send(page, 'I need a wall mount for this thermostat')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'Yes, that one' }).click()
    await expect(page.getByTestId('mimir-sheet-drawing')).toBeVisible()
    await expect(page.getByTestId('mimir-sheet-callout')).toHaveCount(12)
    await expect(page.getByTestId('mimir-sheet-status')).toHaveText('1 assumed value: thickness 3 mm')
    await page.screenshot({ path: test.info().outputPath('mimir-sheet-backplate-light.png') })
  })
})
