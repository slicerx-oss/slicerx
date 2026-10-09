// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Design to Slice and back loses nothing and never slices the wrong part: an open tool waits in Slice as a chip and
// opens again as it was left, and a history step being edited puts the whole part back before the slice.
import { type Page } from '@playwright/test'
import { clickStepButton, command, freshBox, height, openStudio, pick, placeAt, pushTop, sketchAt, steps, toolPanel } from './cad-helpers'
import { expect, sliceCount, sliced, tab, test } from './fixtures'

type Sx = { getState(): { plate: { id: string }[]; modelMode: string; historyEdit: unknown; preview: { layerZ: Float32Array } | null }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
const topZ = (page: Page) => page.evaluate(() => {
  const z = (window as unknown as { __sx: Sx }).__sx.getState().preview?.layerZ
  return z && z.length ? z[z.length - 1]! : 0
})

test.describe.configure({ mode: 'parallel' })
test.skip(({ isMobile }) => isMobile, 'The modeling tools run at desktop width')

test('a sketch left open waits in Slice through a slice and is finished back in Design', async ({ page }) => {
  test.slow()
  await openStudio(page)
  await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [20, 20] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  const field = page.getByRole('group', { name: 'Exact size' })
  await sketchAt(page, 'hover', [20, 20])
  await page.locator('body').press('5')
  await field.getByLabel('X mm').fill('20')
  await field.getByLabel('Y mm').fill('20')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [20, 20])
  await page.locator('body').press('3')
  await field.getByLabel('Width mm').fill('30')
  await field.getByLabel('Height mm').fill('20')
  await field.getByLabel('Height mm').press('Enter')
  await panel.locator('#sk-dist').fill('10')
  await expect(panel.getByRole('button', { name: 'Extrude' })).toBeEnabled({ timeout: 15_000 })

  // Slice: the tool waits as a chip, with a dot on the Design half.
  await tab(page, 'prepare').click()
  const chip = page.getByTestId('parked-chip')
  await expect(chip).toContainText('Sketch in progress')
  await expect(tab(page, 'model')).toHaveAttribute('data-parked', '')
  await expect(panel).toHaveCount(0)
  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
  expect((await state(page)).plate.length).toBe(1)

  // Back to Model: the sketch and its distance are as they were.
  await chip.getByRole('button', { name: 'Back to Model' }).click()
  await expect(chip).toHaveCount(0)
  await expect(panel).toContainText('The bed')
  await expect(panel.locator('#sk-dist')).toHaveValue('10')
  const extrude = panel.getByRole('button', { name: 'Extrude' })
  await expect(extrude).toBeEnabled({ timeout: 15_000 })
  await extrude.click()
  await expect.poll(async () => (await state(page)).plate.length, { timeout: 30_000 }).toBe(2)
  const body = (await state(page)).plate[1]!.id
  expect(await height(page, body)).toBe(10)
})

test('a history step being edited is put back whole before Mod+Enter slices, and opens again after', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  await placeAt(page, 100, 100)
  await pushTop(page, id, 5)
  await expect.poll(() => height(page, id)).toBe(25)

  // Editing step 1 rolls the part back to before it.
  await clickStepButton(page, 'Pull 5 mm', 'Edit Pull 5 mm')
  const panel = toolPanel(page)
  await expect(panel.getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
  await expect.poll(() => height(page, id)).toBe(20)
  await panel.locator('#push-dist').fill('10')
  await panel.locator('#push-dist').blur()

  // Mod+Enter in Design: Slice opens with the whole part, and the slice reaches its top.
  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect.poll(async () => (await state(page)).modelMode).toBe('slice')
  expect((await state(page)).historyEdit).toBeNull()
  expect(await height(page, id)).toBe(25)
  await expect(page.getByTestId('parked-chip')).toContainText('Push and pull in progress')
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
  expect(await topZ(page)).toBeGreaterThan(24.5)

  // Back in Design the step opens again with the typed distance, and finishing it replays.
  await tab(page, 'model').click()
  await expect(panel.getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
  await expect(panel.locator('#push-dist')).toHaveValue('10')
  await expect.poll(() => height(page, id)).toBe(20)
  await panel.getByRole('button', { name: 'Pull out' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }])
  await expect.poll(() => height(page, id)).toBe(30)
})

test('Mod+Enter slices while the first step of the only body is being edited', async ({ page }) => {
  test.slow()
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  const field = page.getByRole('group', { name: 'Exact size' })
  await sketchAt(page, 'hover', [100, 100])
  await page.locator('body').press('5')
  await field.getByLabel('X mm').fill('100')
  await field.getByLabel('Y mm').fill('100')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [100, 100])
  await page.locator('body').press('3')
  await field.getByLabel('Width mm').fill('20')
  await field.getByLabel('Height mm').fill('20')
  await field.getByLabel('Height mm').press('Enter')
  await panel.locator('#sk-dist').fill('10')
  await expect(panel.getByRole('button', { name: 'Extrude' })).toBeEnabled({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(async () => (await state(page)).plate.length, { timeout: 30_000 }).toBe(1)
  const id = (await state(page)).plate[0]!.id
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ objectTool: null }))

  // Editing the step that made the body takes the body off the plate while the sketch is open.
  const row = page.locator('.cad-step').first()
  await row.hover()
  await row.getByRole('button', { name: /^Edit / }).click()
  await expect(panel.getByTestId('model-tool-crumb')).toHaveText('Sketch body › Sketch extrude 10 mm')
  await expect.poll(async () => (await state(page)).plate.length).toBe(0)
  await page.locator('#sk-dist').blur()

  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect.poll(async () => (await state(page)).modelMode).toBe('slice')
  expect((await state(page)).plate.map((p) => p.id)).toEqual([id])
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
  expect(await topZ(page)).toBeGreaterThan(9.5)
})

test('Measure closes on the way to Slice, so the toolpaths show', async ({ page }) => {
  test.slow()
  await openStudio(page)
  await freshBox(page)
  await tab(page, 'model').click()
  await command(page, 'Measure distance, angle and radius')
  await expect(toolPanel(page)).toContainText('Nothing picked')
  await tab(page, 'prepare').click()
  await expect(toolPanel(page)).toHaveCount(0)
  await expect(page.getByTestId('parked-chip')).toHaveCount(0)
  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
})
