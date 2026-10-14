// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's two cards and the numbers at the cursor: a line drawn with a typed length and angle (Tab between
// the pills), the pills staying in the view and off the point with typed and live numbers reading apart, the solid card
// folded with its reason until a closed profile opens it, the tool's name in the Drawing header, Flip beside Direction,
// Grid and Snap on one row and independent, Other plane by the face label, the view's mode pill and Look at the sketch
// among the camera buttons, and nothing in the panel moving as tools are picked or the solid card opens.
import { type Page } from '@playwright/test'
import { command, facePick, freshBox, height, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

/** A fresh box with a sketch open on its top face; the face's frame is centered on the face, so its middle is 0, 0. */
async function sketchOnTop(page: Page): Promise<string> {
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  // the panel takes picks once it shows
  await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(toolPanel(page)).toContainText('A face of')
  return id
}

const top = async (page: Page, testid: string): Promise<number> => (await page.getByTestId(testid).boundingBox())!.y

/** A hover or click at plane point `at`, with the pointer at client `screen`. */
async function sketchAtScreen(page: Page, kind: 'hover' | 'click', at: [number, number], screen: [number, number]): Promise<void> {
  await page.evaluate(({ kind, at, screen }) => {
    const vp = (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp
    vp.emit('sketch', { kind, at, mmPerPx: 0.2, screen, shift: false, alt: false })
  }, { kind, at, screen })
}

/** The 3D view's box on the page. */
const viewBox = (page: Page) =>
  page.evaluate(() => {
    const r = (window as unknown as { __vp: { canvas: HTMLCanvasElement } }).__vp.canvas.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })

test('a line takes a typed length and angle, Tab moving between the pills', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const pills = page.getByTestId('sketch-pills')
  // the first point's pills are X and Y, following the cursor
  await sketchAt(page, 'hover', [2, 3])
  await expect(pills).toBeVisible()
  await expect(pills.locator('[data-label="X"]')).toContainText('2.00')
  await expect(pills.locator('[data-label="Y"]')).toContainText('3.00')
  await sketchAt(page, 'click', [0, 0])
  // then length and angle from it, length focused first
  await sketchAt(page, 'hover', [5, 0])
  await expect(pills.locator('[data-label="Length"]')).toContainText('5.00')
  await expect(pills.locator('[data-label="Angle"]')).toContainText('0.0')
  await expect(pills.locator('[data-label="Length"]')).toHaveAttribute('data-focus', '')
  // typing edits the focused pill; Tab goes on to the angle
  await page.locator('body').press('2')
  const length = pills.getByRole('textbox', { name: 'Length mm' })
  await expect(length).toBeFocused()
  await length.press('0')
  await expect(length).toHaveValue('20')
  await length.press('Tab')
  const angle = pills.getByRole('textbox', { name: 'Angle °' })
  await expect(angle).toBeFocused()
  await angle.fill('90')
  await angle.press('Enter')
  await expect(length).toHaveCount(0)
  // the line ends there: 20 mm straight up the face
  await page.locator('body').press('Escape')
  await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
  await sketchAt(page, 'click', [0, 10])
  await expect(page.getByTestId('sketch-picked')).toHaveText('Line, 20.00 mm')
})

test('the solid card opens on a closed profile, and nothing above it moves', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  const solid = page.getByTestId('sketch-solid')
  await expect(solid).toHaveAttribute('data-muted', '')
  await expect(solid.locator('.tp-card-reason')).toHaveText('Draw a closed outline to make a solid.')
  await expect(solid.getByRole('radiogroup', { name: 'Result' })).toHaveCount(0)
  await expect(panel.getByTestId('model-tool-apply')).toBeDisabled()

  // the view's pill names the mode and the tool, and so does the Drawing card's header; no box repeats it
  await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on a face · Line')
  await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
  await expect(page.getByTestId('sketch-variant-one')).toHaveCount(0)

  // picking each tool moves neither the solid card nor the tools themselves
  const families = panel.getByRole('radiogroup', { name: 'Drawing tool' })
  const solidY = await top(page, 'sketch-solid')
  const toolsBox = await families.boundingBox()
  for (const name of ['Rectangle', 'Circle', 'Arc', 'Polygon', 'Slot', 'Trim', 'Dimension', 'Line']) {
    const radio = families.getByRole('radio', { name })
    const before = await radio.boundingBox()
    await radio.click()
    await expect(radio).toHaveAttribute('aria-checked', 'true')
    expect(await radio.boundingBox()).toEqual(before)
    expect(await top(page, 'sketch-solid')).toBe(solidY)
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText(`Drawing · ${name}`)
  }
  expect(await families.boundingBox()).toEqual(toolsBox)
  await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on a face · Line')

  // an open line keeps it folded, with the open loop as its reason
  await sketchAt(page, 'click', [-6, -6])
  await sketchAt(page, 'click', [6, -6])
  await sketchAt(page, 'click', [6, 6])
  await page.locator('body').press('Escape')
  await expect(solid).toHaveAttribute('data-muted', '')
  await expect(solid.locator('.tp-card-reason')).not.toHaveText('Draw a closed outline to make a solid.')
  expect(await top(page, 'sketch-solid')).toBe(solidY)

  // a closed rectangle opens it below, the drawing card where it was
  const drawing = await page.getByTestId('sketch-drawing').boundingBox()
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(solid).not.toHaveAttribute('data-muted')
  await expect(solid.locator('.tp-card-reason')).toHaveCount(0)
  await expect(solid.getByRole('radiogroup', { name: 'Result' })).toBeVisible()
  expect(await page.getByTestId('sketch-drawing').boundingBox()).toEqual(drawing)
  expect(await top(page, 'sketch-solid')).toBe(solidY)
  // Extrude or Revolve heads the open card; Direction and Result are words, with no marks
  await expect(solid.getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Extrude' })).toHaveAttribute('aria-checked', 'true')
  for (const [group, names] of [['Direction', ['One side', 'Symmetric', 'Two sides']], ['Result', ['Join', 'Cut', 'New body']]] as const)
    for (const name of names) {
      const radio = solid.getByRole('radiogroup', { name: group }).getByRole('radio', { name })
      await expect(radio).toHaveText(name)
      await expect(radio.locator('svg')).toHaveCount(0)
    }
})

test('at 1440 by 900 Distance and Draft show above the footer with the solid card open', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await page.setViewportSize({ width: 1440, height: 900 })
  await sketchOnTop(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
  const panel = toolPanel(page)
  const footer = (await panel.locator('.cad-footer').boundingBox())!
  for (const id of ['#sk-dist', '#sk-taper']) {
    const b = (await panel.locator(id).boundingBox())!
    // clear of the footer and the fade above it
    expect(b.y + b.height).toBeLessThanOrEqual(footer.y - 24)
  }
  // Distance reads on one line, its unit inside the field
  const label = (await panel.locator('label[for="sk-dist"]').boundingBox())!
  expect(label.height).toBeLessThan(22)
  await expect(panel.locator('label[for="sk-dist"]')).toHaveText('Distance')
  await expect(panel.locator('.sx-inputwrap').filter({ has: page.locator('#sk-dist') }).locator('.sx-inputwrap-unit')).toHaveText('mm')
  await expect(panel.locator('.sx-inputwrap').filter({ has: page.locator('#sk-taper') }).locator('.sx-inputwrap-unit')).toHaveText('°')
})

test('Flip beside Direction sends a join into the face instead of out of it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  for (const flipped of [false, true]) {
    const id = await sketchOnTop(page)
    const panel = toolPanel(page)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-4, -4])
    await sketchAt(page, 'click', [4, 4])
    await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
    await expect(panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Join' })).toHaveAttribute('aria-checked', 'true')
    const flip = panel.getByTestId('sketch-flip')
    await expect(flip).toHaveAttribute('aria-pressed', 'false')
    // Flip sits on Direction's label line, at the right edge, above the choice and clear of it
    const direction = (await panel.getByRole('radiogroup', { name: 'Direction' }).boundingBox())!
    const label = (await panel.locator('#sk-direction-label').boundingBox())!
    const fb = (await flip.boundingBox())!
    expect(Math.abs(fb.y + fb.height / 2 - (label.y + label.height / 2))).toBeLessThan(3)
    expect(Math.abs(fb.x + fb.width - (direction.x + direction.width))).toBeLessThan(2)
    expect(fb.y + fb.height).toBeLessThanOrEqual(direction.y)
    if (flipped) {
      const fill = () => flip.evaluate((el) => getComputedStyle(el).backgroundColor)
      const off = await fill()
      await flip.click()
      await expect(flip).toHaveAttribute('aria-pressed', 'true')
      // pressed reads as on: a different fill, under the pointer and away from it, the same size
      await expect.poll(fill).not.toBe(off)
      await page.mouse.move(0, 0)
      await expect.poll(fill).not.toBe(off)
      expect(await flip.boundingBox()).toEqual(fb)
    }
    await panel.locator('#sk-dist').fill('5')
    await panel.getByTestId('model-tool-apply').click()
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    // out of the top face it grows 5 mm; flipped it goes into the box and the height stays
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(flipped ? 20 : 25)
  }
})

test('Other plane by the face label picks another plane; Look at the sketch is among the camera buttons', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  // the bottom row is only Cancel and the primary
  const footer = panel.locator('.cad-footer')
  await expect(footer.getByRole('button')).toHaveText(['Cancel', 'Extrude'])
  // Other plane sits in the header, right after the face label
  const other = panel.getByTestId('sketch-other-plane')
  await expect(other).toHaveText('Other plane')
  await expect(page.getByTestId('model-tool-state').locator('xpath=..').getByTestId('sketch-other-plane')).toHaveCount(1)
  // Cancel and the primary sit at opposite edges of the footer
  const [cancel, primary, row] = [await footer.getByTestId('model-tool-cancel').boundingBox(), await footer.getByTestId('model-tool-apply').boundingBox(), await footer.boundingBox()]
  expect(cancel!.x - row!.x).toBeLessThan(40)
  expect(row!.x + row!.width - (primary!.x + primary!.width)).toBeLessThan(40)
  // Look at the sketch shows in the view while sketching
  await expect(page.getByTestId('sketch-look')).toBeVisible()
  await page.getByTestId('sketch-look').click()
  await other.click()
  await expect(panel).toContainText('Click an origin plane')
  await expect(page.getByTestId('sketch-look')).toHaveCount(0)
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on the bed · Line')
  await expect(page.getByTestId('sketch-look')).toBeVisible()
  // closing the tool puts the pill back to the selection
  await panel.getByTestId('model-tool-cancel').click()
  await expect(page.getByTestId('model-select-readout')).not.toContainText('Sketching')
  await expect(page.getByTestId('sketch-look')).toHaveCount(0)
})

test('Grid and Snap share a row and stay apart: snapping works with the grid hidden, and Off stops it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  const row = panel.getByTestId('sketch-grid-snap')
  await expect(row.locator('#sk-grid')).toBeVisible()
  await expect(row.locator('#sk-step')).toBeVisible()
  const [g, sn] = [(await row.locator('#sk-grid').boundingBox())!, (await row.locator('#sk-step').boundingBox())!]
  expect(Math.abs(g.y + g.height / 2 - (sn.y + sn.height / 2))).toBeLessThan(3)
  // Section has its own row
  await expect(row.locator('#sk-section')).toHaveCount(0)
  await expect(panel.locator('#sk-section')).toBeVisible()
  await expect(row.locator('#sk-step option').first()).toHaveText('Off')
  // the grid hidden, a 5 mm snap still holds the first point to its step
  await row.locator('#sk-grid').click()
  await expect(row.locator('#sk-grid')).not.toBeChecked()
  await row.locator('#sk-step').selectOption({ label: '5 mm' })
  const pills = page.getByTestId('sketch-pills')
  await sketchAt(page, 'hover', [2.2, 3.1])
  await expect(pills.locator('[data-label="X"]')).toContainText('0.00')
  await expect(pills.locator('[data-label="Y"]')).toContainText('5.00')
  // Off places it where the cursor is
  await row.locator('#sk-step').selectOption('off')
  await sketchAt(page, 'hover', [2.2, 3.1])
  await expect(pills.locator('[data-label="X"]')).toContainText('2.20')
  await expect(pills.locator('[data-label="Y"]')).toContainText('3.10')
  await expect(row.locator('#sk-grid')).not.toBeChecked()
})

test('the pills stay in the view and off the point; typed numbers read apart; Tab, Enter and Esc', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await page.setViewportSize({ width: 1440, height: 900 })
  await sketchOnTop(page)
  const pills = page.getByTestId('sketch-pills')
  const view = await viewBox(page)
  const frame = async (name: string) => page.screenshot({ path: test.info().outputPath(`pills-${name}.png`), clip: { x: view.left, y: view.top, width: view.right - view.left, height: view.bottom - view.top } })
  const clear = async (cursor: [number, number]) => {
    const b = (await pills.boundingBox())!
    // inside the view
    expect(b.x).toBeGreaterThanOrEqual(view.left)
    expect(b.y).toBeGreaterThanOrEqual(view.top)
    expect(b.x + b.width).toBeLessThanOrEqual(view.right)
    expect(b.y + b.height).toBeLessThanOrEqual(view.bottom)
    // and not over the point under the cursor, with room for the point's mark
    const off = cursor[0] < b.x - 4 || cursor[0] > b.x + b.width + 4 || cursor[1] < b.y - 4 || cursor[1] > b.y + b.height + 4
    expect(off).toBe(true)
  }
  await sketchAt(page, 'click', [0, 0])
  // in the middle: below and right of the cursor
  const mid: [number, number] = [Math.round((view.left + view.right) / 2), Math.round((view.top + view.bottom) / 2)]
  await sketchAtScreen(page, 'hover', [5, 0], mid)
  await expect(pills.locator('[data-label="Length"]')).toContainText('5.00')
  await clear(mid)
  await frame('1-live')
  // at the right edge, the bottom edge and the corner: flipped to the other side, still inside
  const edges: [string, [number, number]][] = [
    ['2-right', [view.right - 6, mid[1]]],
    ['3-bottom', [mid[0], view.bottom - 6]],
    ['4-corner', [view.right - 6, view.bottom - 6]],
  ]
  for (const [name, at] of edges) {
    await sketchAtScreen(page, 'hover', [5, 0], at)
    await clear(at)
    await frame(name)
  }
  await sketchAtScreen(page, 'hover', [5, 0], mid)
  // live: plain numbers. Typing turns the pills to fields, the typed one marked, so typed and live read apart
  await expect(pills).not.toHaveAttribute('data-typing')
  const liveBg = await pills.locator('[data-label="Length"]').evaluate((el) => getComputedStyle(el).backgroundColor)
  await page.locator('body').press('1')
  await expect(pills).toHaveAttribute('data-typing', '')
  const length = pills.getByRole('textbox', { name: 'Length mm' })
  await expect(length).toBeFocused()
  await length.press('2')
  await expect(pills.locator('[data-label="Length"]')).toHaveAttribute('data-typed', '')
  await expect(pills.locator('[data-label="Angle"]')).not.toHaveAttribute('data-typed')
  expect(await pills.locator('[data-label="Length"]').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(liveBg)
  // the angle still shows the live value as its hint
  await expect(pills.getByRole('textbox', { name: 'Angle °' })).toHaveAttribute('placeholder', '0.0')
  await frame('5-typed')
  // Tab goes to the angle, Shift+Tab back
  await length.press('Tab')
  const angle = pills.getByRole('textbox', { name: 'Angle °' })
  await expect(angle).toBeFocused()
  await angle.press('Shift+Tab')
  await expect(length).toBeFocused()
  await length.press('Tab')
  await angle.fill('30')
  // the pills hold still while typing, wherever the cursor goes
  const held = await pills.boundingBox()
  await sketchAtScreen(page, 'hover', [5, 0], [mid[0] - 200, mid[1] - 120])
  // the snap's name may come and go beside them; the pills' own corner stays put
  const now = (await pills.boundingBox())!
  expect([now.x, now.y]).toEqual([held!.x, held!.y])
  await frame('6-tab-angle')
  // Esc clears the typed angle first (it follows the cursor again), then in the empty pill ends typing: back to the
  // live numbers, the line still waiting, and typing starts over at Length
  await angle.press('Escape')
  await expect(angle).toHaveValue('')
  await expect(pills).toHaveAttribute('data-typing', '')
  await angle.press('Escape')
  await expect(pills).not.toHaveAttribute('data-typing')
  await expect(pills.locator('[data-label="Length"]')).toContainText('5.00')
  await expect(pills.locator('[data-label="Length"]')).toHaveAttribute('data-focus', '')
  await frame('7-escape')
  // Enter places the typed point: 12 mm at 90 degrees from the start
  await page.locator('body').press('1')
  await length.press('2')
  await length.press('Tab')
  await angle.fill('90')
  await angle.press('Enter')
  await expect(pills).not.toHaveAttribute('data-typing')
  await frame('8-enter')
  await page.locator('body').press('Escape')
  await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
  await sketchAt(page, 'click', [0, 6])
  await expect(page.getByTestId('sketch-picked')).toHaveText('Line, 12.00 mm')
})
