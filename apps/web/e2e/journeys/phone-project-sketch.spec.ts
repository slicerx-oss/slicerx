// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Project into a sketch on a phone: the Project card fits the sketch sheet, and a tapped face's outline lands in the
// sketch as real curves. The desktop journey is cad-project-sketch.spec.ts.
import { journey as test, expect } from '../journey'
import { facePick, pick } from '../cad-helpers'
import { phoneBox, phoneStudio, shotBoth, still } from './lib/cad'

test.skip(({ isMobile }) => !isMobile, 'Phone only')

test('Project on a phone: the card fits the sheet and a face outline lands in the sketch', async ({ page }, info) => {
  await phoneStudio(page)
  const id = await phoneBox(page)
  await page.getByTestId('phone-sketch').tap()
  const sheet = page.getByRole('complementary', { name: 'Tool and transform' })
  await expect(sheet).toContainText('Tap an origin plane')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(page.getByTestId('phone-sketch-bar')).toBeVisible()
  await still(page)
  const card = sheet.getByTestId('sketch-project')
  const face = card.getByTestId('sketch-project-face')
  await face.scrollIntoViewIfNeeded()
  await face.tap()
  await pick(page, await facePick(page, id, [0, 0, 1]))
  const row = card.getByTestId('sketch-projection-p1')
  await expect(row).toContainText('Face of')
  await expect(row.getByRole('radio', { name: 'Real' })).toHaveAttribute('aria-checked', 'true')
  const vw = page.viewportSize()!.width
  for (const el of [card, row]) {
    const b = (await el.boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(vw)
  }
  await row.scrollIntoViewIfNeeded()
  await shotBoth(page, info, 'project-face-390')
})
