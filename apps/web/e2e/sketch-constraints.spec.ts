// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch says how defined it is, from the engine's solver: a free circle has its center and radius left.
import { type Page } from '@playwright/test'
import { command, facePick, freshBox, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

test('a circle drawn on a face has three degrees of freedom left', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await expect(panel).toContainText('Click the center, then a point on the rim.')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'click', [4, 0])
  const dof = panel.getByTestId('sketch-dof')
  await expect(dof).toHaveText('3 degrees of freedom left')
  await expect(dof).toHaveAttribute('data-dof', '3')
})

/** Gives the sketch of the object's extrude these constraints, as a saved project would carry them. */
async function constrain(page: Page, constraints: unknown[]): Promise<void> {
  await page.evaluate((constraints) => {
    type Step = { params: { op: string; shape?: Record<string, unknown> } }
    type E = { history?: { steps: Step[] } }
    const sx = (window as unknown as { __sx: { getState(): { plate: E[] }; setState(p: unknown): void } }).__sx
    const plate = sx.getState().plate.map((e) => (e.history ? { ...e, history: { ...e.history, steps: e.history.steps.map((st) => (st.params.op === 'shape.extrude' ? { ...st, params: { ...st.params, shape: { ...st.params.shape, constraints } } } : st)) } } : e))
    sx.setState({ plate })
  }, constraints)
}

test('a circle with its center fixed and a diameter is fully constrained', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await expect(panel).toContainText('Click the center, then a point on the rim.')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'click', [4, 0])
  await expect(panel.getByTestId('sketch-dof')).toHaveText('3 degrees of freedom left')
  await expect(panel.getByRole('button', { name: 'Extrude', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await constrain(page, [
    { type: 'fix', point: { e: 0, at: 'center' } },
    { type: 'diameter', circle: { e: 0, seg: 0 }, value: 8 },
  ])
  await page.getByRole('button', { name: /^Edit / }).first().click()
  const dof = toolPanel(page).getByTestId('sketch-dof')
  await expect(dof).toHaveText('Fully constrained')
  await expect(dof).toHaveAttribute('data-tone', 'done')
})
