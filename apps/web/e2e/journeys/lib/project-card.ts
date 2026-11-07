// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's Project card, as the project-sketch journeys check its layout.
import type { Locator } from '@playwright/test'
import { expect } from '../../fixtures'

/**
 * The Project card's layout: Edges, Face and Body share the row evenly, the Real and Reference choice for new
 * projections lines up with each projection's, and a projection's Remove sits inside the card. With `stacked`, a
 * projection's name sits on its own line over its choice, as in a narrow panel.
 */
export async function projectCardLaidOut(card: Locator, row: Locator, stacked: boolean): Promise<void> {
  const box = async (l: Locator) => (await l.boundingBox())!
  const kinds = await Promise.all(['edges', 'face', 'body'].map((k) => box(card.getByTestId(`sketch-project-${k}`))))
  for (const k of kinds) expect(Math.abs(k.width - kinds[0]!.width)).toBeLessThanOrEqual(1)
  const useAs = await box(card.getByRole('radiogroup', { name: 'Use new projections as' }))
  const own = await box(row.getByRole('radiogroup'))
  expect(Math.abs(own.x - useAs.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(own.width - useAs.width)).toBeLessThanOrEqual(1)
  const c = await box(card)
  const remove = await box(row.getByRole('button', { name: /^Remove / }))
  expect(remove.x + remove.width).toBeLessThanOrEqual(c.x + c.width + 0.5)
  const name = await box(row.locator('.sketch-projection-name'))
  if (stacked) expect(name.y + name.height).toBeLessThanOrEqual(own.y + 0.5)
  else expect(Math.abs(name.y + name.height / 2 - (own.y + own.height / 2))).toBeLessThanOrEqual(2)
}

