// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's two cards and the numbers at the cursor: a line drawn with a typed length and angle (Tab between
// the pills), the solid card folded with its reason until a closed profile opens it, Flip beside Distance, Other plane
// by the face label, the view's mode pill and Look at the sketch among the camera buttons, and nothing in the panel moving
// as tools are picked or the solid card opens.
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
  // Tab from the view moves the focus to the angle and back
  await page.locator('body').press('Tab')
  await expect(pills.locator('[data-label="Angle"]')).toHaveAttribute('data-focus', '')
  await page.locator('body').press('Tab')
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

  // the view's pill names the mode and the tool
  await expect(page.getByTestId('model-select-readout')).toHaveText('Sketching on a face · Line')

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
  // Extrude or Revolve heads the open card; Direction keeps its names on its marks
  await expect(solid.getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Extrude' })).toHaveAttribute('aria-checked', 'true')
  for (const name of ['One side', 'Symmetric', 'Two sides']) await expect(solid.getByRole('radiogroup', { name: 'Direction' }).getByRole('radio', { name })).toBeVisible()
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
})

test('Flip beside Distance sends a join into the face instead of out of it', async ({ page, isMobile }) => {
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
    // Flip sits on the Distance field's row, just before the field
    const dist = (await panel.locator('#sk-dist').boundingBox())!
    const fb = (await flip.boundingBox())!
    expect(Math.abs(fb.y + fb.height / 2 - (dist.y + dist.height / 2))).toBeLessThan(2)
    expect(fb.x + fb.width).toBeLessThanOrEqual(dist.x)
    if (flipped) {
      await flip.click()
      await expect(flip).toHaveAttribute('aria-pressed', 'true')
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
