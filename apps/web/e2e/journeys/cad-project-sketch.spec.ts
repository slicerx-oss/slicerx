// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Project into a sketch: with a sketch open on a box's top, the Project card's Face takes a click on a face and puts
// its outline in the sketch as real curves, which extrude like drawn ones. The sketch keeps the projection, the
// extrude names the sketch, and switching the projection to reference leaves no profile. Picked edges join one
// projection until Done. The phone leg is in phone-project-sketch.spec.ts.
import { journey as test, expect } from '../journey'
import { bounds, facePick, height, pick, toolPanel } from '../cad-helpers'
import { shotBoth, sketchOnTop, studio } from './lib/cad'
import { projectCardLaidOut } from './lib/project-card'

test.skip(({ isMobile }) => isMobile, 'The modeling tools run at desktop width; the phone legs are in phone-cad.spec.ts')

type Item = { kind: string; id: string; sketch?: string; projections?: { id: string; mode: string; source: { kind: string; body: string } }[]; loops?: { projected?: string; construction?: boolean }[] }
const timeline = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: Item[] } } } }).__sx.getState().timeline.items)

test.describe('project-sketch', () => {
  test('a face outline projected as real curves extrudes, and the sketch keeps where it came from', async ({ page }, info) => {
    await studio(page)
    const id = await sketchOnTop(page)
    const before = await height(page, id)
    const panel = toolPanel(page)
    const card = panel.getByTestId('sketch-project')
    // new projections are real curves unless switched
    await expect(card.getByRole('radiogroup', { name: 'Use new projections as' }).getByRole('radio', { name: 'Real' })).toHaveAttribute('aria-checked', 'true')
    await card.getByTestId('sketch-project-face').click()
    await expect(card.getByTestId('sketch-project-hint')).toContainText('Click a face')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    const row = card.getByTestId('sketch-projection-p1')
    await expect(row).toContainText('Face of')
    await expect(row.getByRole('radio', { name: 'Real' })).toHaveAttribute('aria-checked', 'true')
    // the desktop panel is narrow: the name takes its own line over its choice
    await projectCardLaidOut(card, row, true)
    await shotBoth(page, info, 'project-face-1440')
    // the projected outline is a profile: Extrude joins it to the box
    const extrude = panel.getByRole('button', { name: 'Extrude', exact: true })
    await expect(extrude).toBeEnabled()
    await extrude.click()
    await expect(panel).toHaveCount(0)
    await expect.poll(() => height(page, id)).toBe(before + 5)
    await shotBoth(page, info, 'project-extruded-1440')
    const items = await timeline(page)
    const sketch = items.find((i) => i.kind === 'sketch')!
    expect(sketch.projections).toEqual([expect.objectContaining({ id: 'p1', mode: 'real', source: expect.objectContaining({ kind: 'face', body: id }) })])
    expect(sketch.loops!.filter((l) => l.projected === 'p1').length).toBeGreaterThan(0)
    expect(items.find((i) => i.kind === 'feature' && i.sketch === sketch.id)).toBeTruthy()
  })

  test('a projection switched to reference makes no profile, and one removed takes its curves', async ({ page }, info) => {
    await studio(page)
    const id = await sketchOnTop(page)
    const panel = toolPanel(page)
    const card = panel.getByTestId('sketch-project')
    await card.getByTestId('sketch-project-body').click()
    await pick(page, await facePick(page, id, [0, 0, 1]))
    const row = card.getByTestId('sketch-projection-p1')
    await expect(row).toContainText('Outline of')
    // real by default, so it extrudes at once; as reference it is dashed construction and makes no profile
    await expect(row.getByRole('radio', { name: 'Real' })).toHaveAttribute('aria-checked', 'true')
    await expect(panel.getByRole('button', { name: 'Extrude', exact: true })).toBeEnabled()
    await row.getByRole('radio', { name: 'Reference' }).click()
    await expect(panel.getByRole('button', { name: 'Extrude', exact: true })).toBeDisabled()
    await shotBoth(page, info, 'project-reference-1440')
    await card.getByTestId('sketch-projection-p1-remove').click()
    await expect(row).toHaveCount(0)
    // its curves went with it: nothing is left to extrude
    await expect(panel.getByRole('button', { name: 'Extrude', exact: true })).toBeDisabled()
    // the next projection gets a new id, never the removed one's
    await card.getByTestId('sketch-project-body').click()
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(card.getByTestId('sketch-projection-p2')).toContainText('Outline of')
    await expect(card.getByTestId('sketch-projection-p1')).toHaveCount(0)
  })

  test('picked edges join one projection until Done', async ({ page }, info) => {
    await studio(page)
    const id = await sketchOnTop(page)
    const panel = toolPanel(page)
    const card = panel.getByTestId('sketch-project')
    const b = await bounds(page, id)
    const top = b.max[2]
    const mid = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
    await card.getByTestId('sketch-project-edges').click()
    await expect(card.getByTestId('sketch-project-hint')).toContainText('Click edges')
    // two edges of the top, the front one and the left one
    await pick(page, await facePick(page, id, [0, 0, 1], [mid[0]!, b.min[1], top]))
    const row = card.getByTestId('sketch-projection-p1')
    await expect(row).toContainText('Edge of')
    await pick(page, await facePick(page, id, [0, 0, 1], [b.min[0], mid[1]!, top]))
    await expect(row).toContainText('2 edges of')
    await card.getByTestId('sketch-project-done').click()
    await expect(card.getByTestId('sketch-project-hint')).toHaveCount(0)
    await expect(card.getByTestId('sketch-projection-p2')).toHaveCount(0)
    await shotBoth(page, info, 'project-edges-1440')
  })
})
