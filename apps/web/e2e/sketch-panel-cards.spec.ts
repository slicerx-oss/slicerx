// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's two cards and the numbers on the view: a line drawn with a typed length and angle in the boxes on
// it (Tab between them), the first point's pills staying in the view and off the point, the boxes inside the view with
// typed and live numbers reading apart, the solid card
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

test('a line takes a typed length and angle in the boxes on it, Tab moving between them', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const pills = page.getByTestId('sketch-pills')
  const boxes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  // the first point's pills are X and Y, following the cursor
  await sketchAt(page, 'hover', [2, 3])
  await expect(pills).toBeVisible()
  await expect(pills.locator('[data-label="X"]')).toContainText('2.00')
  await expect(pills.locator('[data-label="Y"]')).toContainText('3.00')
  await sketchAt(page, 'click', [0, 0])
  // then length and angle on the line, the keyboard in Length first; the pills are gone
  await sketchAt(page, 'hover', [5, 0])
  const length = boxes.getByRole('textbox', { name: 'Length mm' })
  const angle = boxes.getByRole('textbox', { name: 'Angle °' })
  await expect(length).toHaveValue('5.00')
  await expect(angle).toHaveValue('0.0')
  await expect(boxes.locator('[data-box="length"]')).toHaveAttribute('data-focus', '')
  await expect(length).toBeFocused()
  await expect(pills).toBeHidden()
  // typing replaces the picked live value; Tab goes on to the angle
  await page.keyboard.press('2')
  await page.keyboard.press('0')
  await expect(length).toHaveValue('20')
  await length.press('Tab')
  await expect(angle).toBeFocused()
  await angle.fill('90')
  await angle.press('Enter')
  await expect(boxes.locator('[data-typed]')).toHaveCount(0)
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
  // Line has one way to draw: no variant row, no empty space for one
  await expect(panel.locator('.sketch-variants')).toHaveCount(0)

  // picking a tool never moves the tools themselves; a family with ways shows them below, one row's height, and the
  // solid card moves only by that row
  const families = panel.getByRole('radiogroup', { name: 'Drawing tool' })
  const solidY = await top(page, 'sketch-solid')
  const toolsBox = await families.boundingBox()
  const shifts = new Set<number>()
  for (const name of ['Rectangle', 'Circle', 'Arc', 'Polygon', 'Slot', 'Trim', 'Dimension', 'Line']) {
    const radio = families.getByRole('radio', { name })
    const before = await radio.boundingBox()
    await radio.click()
    await expect(radio).toHaveAttribute('aria-checked', 'true')
    expect(await radio.boundingBox()).toEqual(before)
    await expect(radio).toBeFocused()
    const row = await panel.locator('.sketch-variants').count()
    const shift = (await top(page, 'sketch-solid')) - solidY
    if (row) shifts.add(shift)
    else expect(shift).toBe(0)
    await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText(`Drawing · ${name}`)
  }
  // every family with ways moves the card by the same row height
  expect(shifts.size).toBe(1)
  expect([...shifts][0]).toBeGreaterThan(0)
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

  // a closed rectangle opens it below, the drawing card where it was (Rectangle's ways row is already there)
  await page.locator('body').press('r')
  await expect(panel.locator('.sketch-variants')).toHaveCount(1)
  const drawing = await page.getByTestId('sketch-drawing').boundingBox()
  const solidAt = await top(page, 'sketch-solid')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(solid).not.toHaveAttribute('data-muted')
  await expect(solid.locator('.tp-card-reason')).toHaveCount(0)
  await expect(solid.getByRole('radiogroup', { name: 'Result' })).toBeVisible()
  expect(await page.getByTestId('sketch-drawing').boundingBox()).toEqual(drawing)
  expect(await top(page, 'sketch-solid')).toBe(solidAt)
  // Extrude or Revolve heads the open card; Direction and Result are words, with no marks
  await expect(solid.getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Extrude' })).toHaveAttribute('aria-checked', 'true')
  for (const [group, names] of [['Direction', ['One side', 'Symmetric', 'Two sides']], ['Result', ['Join', 'Cut', 'New body']]] as const)
    for (const name of names) {
      const radio = solid.getByRole('radiogroup', { name: group }).getByRole('radio', { name })
      await expect(radio).toHaveText(name)
      await expect(radio.locator('svg')).toHaveCount(0)
    }
})

// 960 px tall, not 900: the Model ribbon with its default large icons is 112 px tall, so at 900 the Solid card's fields
// start under the footer's fade and scroll into reach (sketch-panel-behavior's footer test covers 900 px and shorter)
test('at 1440 by 960 Distance and Draft show above the footer with the solid card open', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await page.setViewportSize({ width: 1440, height: 960 })
  await sketchOnTop(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
  const panel = toolPanel(page)
  await expect(panel.getByTestId('model-tool-apply')).toBeEnabled()
  const footer = (await panel.locator('.cad-footer').boundingBox())!
  for (const id of ['#sk-dist', '#sk-taper']) {
    const b = (await panel.locator(id).boundingBox())!
    // clear of the footer and the fade above it
    expect(b.y + b.height).toBeLessThanOrEqual(footer.y - 24)
  }
  // the units sit beside the labels, each on one line, and the fields hold only the numbers
  for (const [id, text] of [['sk-dist', 'Distance mm'], ['sk-taper', 'Draft °']] as const) {
    const label = panel.locator(`label[for="${id}"]`)
    await expect(label).toHaveText(text)
    expect((await label.boundingBox())!.height).toBeLessThan(22)
    await expect(panel.locator(`#${id}`)).toHaveValue(/^-?[0-9.]+$/)
    await expect(panel.locator('.sx-inputwrap').filter({ has: page.locator(`#${id}`) }).locator('.sx-inputwrap-unit')).toHaveCount(0)
  }
  // Symmetric's longer label still fits on one line
  await panel.getByRole('radiogroup', { name: 'Direction' }).getByRole('radio', { name: 'Symmetric' }).click()
  await expect(panel.locator('label[for="sk-dist"]')).toHaveText('Total distance mm')
  expect((await panel.locator('label[for="sk-dist"]').boundingBox())!.height).toBeLessThan(22)
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

test('the pills stay in the view and off the point; the boxes stay in the view; typed numbers read apart; Tab, Enter and Esc', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await page.setViewportSize({ width: 1440, height: 900 })
  await sketchOnTop(page)
  const pills = page.getByTestId('sketch-pills')
  const boxes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  const view = await viewBox(page)
  const frame = async (name: string) => page.screenshot({ path: test.info().outputPath(`pills-${name}.png`), clip: { x: view.left, y: view.top, width: view.right - view.left, height: view.bottom - view.top } })
  const inside = (b: { x: number; y: number; width: number; height: number }) => {
    expect(b.x).toBeGreaterThanOrEqual(view.left)
    expect(b.y).toBeGreaterThanOrEqual(view.top)
    expect(b.x + b.width).toBeLessThanOrEqual(view.right)
    expect(b.y + b.height).toBeLessThanOrEqual(view.bottom)
  }
  const clear = async (cursor: [number, number]) => {
    const b = (await pills.boundingBox())!
    inside(b)
    // and not over the point under the cursor, with room for the point's mark
    const off = cursor[0] < b.x - 4 || cursor[0] > b.x + b.width + 4 || cursor[1] < b.y - 4 || cursor[1] > b.y + b.height + 4
    expect(off).toBe(true)
  }
  // the first point's pills follow the cursor: in the middle, below and right of it
  const mid: [number, number] = [Math.round((view.left + view.right) / 2), Math.round((view.top + view.bottom) / 2)]
  await sketchAtScreen(page, 'hover', [0, 0], mid)
  await expect(pills.locator('[data-label="X"]')).toContainText('0.00')
  await clear(mid)
  await frame('1-live')
  // at the right edge, the bottom edge and the corner: flipped to the other side, still inside
  const edges: [string, [number, number]][] = [
    ['2-right', [view.right - 6, mid[1]]],
    ['3-bottom', [mid[0], view.bottom - 6]],
    ['4-corner', [view.right - 6, view.bottom - 6]],
  ]
  for (const [name, at] of edges) {
    await sketchAtScreen(page, 'hover', [0, 0], at)
    await clear(at)
    await frame(name)
  }
  await sketchAt(page, 'click', [0, 0])
  // from the first click the sizes are boxes on the line, inside the view
  await sketchAtScreen(page, 'hover', [5, 0], mid)
  const length = boxes.getByRole('textbox', { name: 'Length mm' })
  const angle = boxes.getByRole('textbox', { name: 'Angle °' })
  const lengthBox = boxes.locator('[data-box="length"]')
  const angleBox = boxes.locator('[data-box="angle"]')
  await expect(length).toHaveValue('5.00')
  await expect(pills).toBeHidden()
  for (const b of [lengthBox, angleBox]) inside((await b.boundingBox())!)
  // live: the keyboard is in Length with its value picked. Typing replaces it and marks the box, so typed and live
  // read apart
  await expect(length).toBeFocused()
  await expect(lengthBox).not.toHaveAttribute('data-typed')
  const liveBg = await lengthBox.evaluate((el) => getComputedStyle(el).backgroundColor)
  await page.keyboard.press('1')
  await page.keyboard.press('2')
  await expect(length).toHaveValue('12')
  await expect(lengthBox).toHaveAttribute('data-typed', '')
  await expect(angleBox).not.toHaveAttribute('data-typed')
  expect(await lengthBox.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(liveBg)
  // the angle still shows the live value
  await expect(angle).toHaveValue('0.0')
  await frame('5-typed')
  // Tab goes to the angle, Shift+Tab back
  await length.press('Tab')
  await expect(angle).toBeFocused()
  await angle.press('Shift+Tab')
  await expect(length).toBeFocused()
  await length.press('Tab')
  await angle.fill('30')
  // with both typed the line is set: its boxes hold still wherever the cursor goes
  const held = (await lengthBox.boundingBox())!
  await sketchAtScreen(page, 'hover', [-5, 4], [mid[0] - 200, mid[1] - 120])
  const now = (await lengthBox.boundingBox())!
  expect([now.x, now.y]).toEqual([held.x, held.y])
  await frame('6-tab-angle')
  // Esc clears the typed angle first (it shows the live angle again, Length still typed), then in a box with nothing
  // typed it drops the line being drawn; the tool stays
  await angle.press('Escape')
  await expect(angleBox).not.toHaveAttribute('data-typed')
  await expect(lengthBox).toHaveAttribute('data-typed', '')
  await expect(angle).toBeFocused()
  await angle.press('Escape')
  await expect(boxes).toHaveCount(0)
  await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
  await frame('7-escape')
  // Enter places the typed point: 12 mm at 90 degrees from the start
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'hover', [5, 0])
  await expect(length).toBeFocused()
  await page.keyboard.type('12')
  await length.press('Tab')
  await angle.fill('90')
  await angle.press('Enter')
  await expect(boxes.locator('[data-typed]')).toHaveCount(0)
  await frame('8-enter')
  await page.locator('body').press('Escape')
  await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Select' }).click()
  await sketchAt(page, 'click', [0, 6])
  await expect(page.getByTestId('sketch-picked')).toHaveText('Line, 12.00 mm')
})

test('Show chips: one row when the four fit the real width, two by two when not, never clipped or shrunk', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const m = await page.evaluate(() => {
    const show = document.querySelector('.sketch-show') as HTMLElement
    const chips = [...show.querySelectorAll<HTMLElement>('.tp-chip')]
    const label = show.querySelector('.tp-label') as HTMLElement
    const gap = parseFloat(getComputedStyle(show.querySelector('.tp-chips')!).columnGap)
    // what each chip needs, measured in place
    const need = chips.map((b) => {
      const was = b.style.width
      b.style.width = 'max-content'
      const w = b.getBoundingClientRect().width
      b.style.width = was
      return w
    })
    // the columns are equal: one row takes four of the widest chip and three gaps, beside the label
    const oneRow = label.getBoundingClientRect().width + parseFloat(getComputedStyle(show).columnGap) + Math.max(...need) * 4 + gap * 3
    const tops = new Set(chips.map((b) => Math.round(b.getBoundingClientRect().top)))
    return {
      width: show.getBoundingClientRect().width,
      oneRow,
      rows: tops.size,
      clipped: chips.filter((b) => b.scrollWidth > b.clientWidth + 0.5).map((b) => b.textContent),
      heights: chips.map((b) => b.getBoundingClientRect().height),
      font: parseFloat(getComputedStyle(chips[0]!).fontSize),
      pressed: chips.map((b) => b.getAttribute('aria-pressed')),
      // the compact control height token, as the look and feel sets it (28 px at the default density)
      token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h-sm')),
    }
  })
  expect(m.rows).toBe(m.oneRow <= m.width ? 1 : 2)
  expect(m.clipped).toEqual([])
  for (const h of m.heights) expect(h).toBe(m.token)
  expect(m.font).toBeGreaterThanOrEqual(12)
  expect(m.pressed).toEqual(['true', 'true', 'true', 'true'])
  test.info().annotations.push({ type: 'chips', description: `row ${m.width}px, one row needs ${m.oneRow.toFixed(1)}px: ${m.rows} rows` })
})
