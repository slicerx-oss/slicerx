// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch says how defined it is, from the engine's solver: a free circle has its center and radius left.
import { command, facePick, freshBox, openStudio, pick, sketchAt, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

test('a circle drawn on a face has three degrees of freedom left', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'click', [4, 0])
  const dof = panel.getByTestId('sketch-dof')
  await expect(dof).toHaveText('3 degrees of freedom left')
  await expect(dof).toHaveAttribute('data-dof', '3')
})
