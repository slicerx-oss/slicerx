// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Display units: with inches picked in Settings, a typed 1" pulls a face 25.4 mm, the step reads in inches and its
// field shows 1.000. Switching back to mm changes what shows, never the data.
import { test, expect } from './fixtures'
import { command, freshBox, height, openStudio, pick, facePick, steps, toolPanel } from './cad-helpers'

type Sx = { __sx: { getState(): { plate: { history?: { steps: { params: { distanceMm?: number } }[] } }[]; units: { length: string } }; setState(p: unknown): void } }

const history = (page: import('@playwright/test').Page) => page.evaluate(() => JSON.stringify((window as unknown as Sx).__sx.getState().plate.map((e) => e.history ?? null)))

test('inches: a typed 1" pulls 25.4 mm and shows as 1.000 in; mm shows the same step as 25.4 mm', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: /Slicing and modeling|Modeling/ }).first().click()
  await dialog.getByTestId('set-units-in').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as Sx).__sx.getState().units.length)).toBe('in')
  await expect(dialog.getByTestId('set-precision-d3')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const id = await freshBox(page)
  await command(page, 'Push or pull a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No face yet')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face is picked')
  await expect(panel.locator('label[for="push-dist"] .cad-num-unit')).toHaveText('in')
  await panel.locator('#push-dist').fill('1"')
  await expect(panel).toContainText('Adds 1.000 in')
  // the folded Transform line keeps the precision's three decimals
  await expect(page.getByTestId('model-transform-summary')).toHaveText(/^X -?\d+\.\d{3} Y -?\d+\.\d{3} Z -?\d+\.\d{3} in$/)
  // and stays inside the panel
  const line = await page.getByTestId('model-transform-summary').boundingBox()
  const pane = await page.getByRole('complementary', { name: 'Tool and transform' }).boundingBox()
  expect(line!.x + line!.width).toBeLessThanOrEqual(pane!.x + pane!.width)
  await panel.getByRole('button', { name: 'Pull out' }).click()
  await expect(panel).toHaveCount(0, { timeout: 30_000 })

  await expect.poll(() => height(page, id)).toBeCloseTo(45.4, 3)
  const mm = await page.evaluate(() => (window as unknown as Sx).__sx.getState().plate[0]!.history!.steps[0]!.params.distanceMm)
  expect(mm).toBeCloseTo(25.4, 9)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 1.000 in', state: 'done' }])
  await expect(page.getByLabel('Model size')).toContainText('0.787 x 0.787 x 1.787 in')
  // Transform's position is in inches too
  await expect(page.getByRole('textbox', { name: 'Position X, in' })).toBeVisible()

  // the step opens with its distance in inches
  await page.getByRole('button', { name: 'Edit Pull 1.000 in' }).click()
  await expect(toolPanel(page).locator('#push-dist')).toHaveValue('1.000')
  await toolPanel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(toolPanel(page)).toHaveCount(0)

  // back to mm: the same data, shown in mm
  const before = await history(page)
  await page.evaluate(() => (window as unknown as Sx).__sx.setState({ units: { length: 'mm', mmDigits: 2, inchDigits: 3, inchFraction: 0 } }))
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 25.4 mm', state: 'done' }])
  expect(await history(page)).toBe(before)
})
