// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps the desktop and phone layer height journeys share (layer-profile.spec.ts, phone-layer-profile.spec.ts): the
// layer height picker opens the editor on sleipnir's plan, its close points drawn as one handle, a flat start, a typed
// point, a dragged point and an added one, Apply makes them the plate's own, the plate slices with them, the editor
// opens on them again, and picking a fixed height puts the plate back.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { closeSheet, openSheet } from '../../fixtures'
import { exampleX, expect, setState, sidebarAs, sidebarDone, sliceNow } from './shell'

type Sx = { __sx: { getState(): { activePlate: string; plates: { id: string; settings: { layerProfile?: [number, number][] } }[]; slice: { status: string } } } }
const profile = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as Sx).__sx.getState()
  return s.plates.find((p) => p.id === s.activePlate)?.settings.layerProfile ?? null
})
const sliceStatus = (page: Page) => page.evaluate(() => (window as unknown as Sx).__sx.getState().slice.status)

/** Light and dark shots of the window as it is, when SX_SHOTS_DIR names a folder. */
async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env['SX_SHOTS_DIR']
  if (!dir) return
  const width = page.viewportSize()?.width ?? 0
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, `${name}-${width}-${scheme}.png`) })
  }
  await setState(page, { scheme: 'dark' })
}

/** Runs `body` and leaves the example plate as a fresh start has it, without layer heights of its own. */
export async function leavesNothing(page: Page, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } finally {
    await sidebarDone(page)
    await exampleX(page)
  }
}

async function openEditor(page: Page) {
  await page.locator('#easy-layer').click()
  await page.getByTestId('easy-layer-edit').click()
  const dialog = page.getByTestId('layer-profile-editor')
  await expect(dialog.getByTestId('lp-graph')).toBeVisible({ timeout: 60_000 })
  return dialog
}

export async function editLayerHeights(page: Page): Promise<void> {
  await sidebarAs(page, { mode: 'simple' })
  await setState(page, { easy: { ...(await page.evaluate(() => (window as unknown as { __sx: { getState(): { easy: Record<string, unknown> } } }).__sx.getState().easy)), varyLayerHeight: true } })
  expect(await profile(page)).toBeNull()

  // It opens on sleipnir's plan, with nothing to apply until something changes.
  let dialog = await openEditor(page)
  const points = dialog.getByTestId('lp-point')
  expect(await points.count()).toBeGreaterThan(1)
  // The plan's points that sit closer than a dot draw as one handle.
  await expect(dialog.locator('[data-testid="lp-point"][data-points]').first()).toBeVisible()
  await expect(dialog.getByTestId('lp-from-sleipnir')).toBeVisible()
  await expect(dialog.getByTestId('lp-apply')).toBeDisabled()
  await expect(dialog.getByTestId('lp-summary')).toContainText(/\d+ layers/)
  await shots(page, 'layer-editor-sleipnir')

  // A flat start, the lower point typed thin, the upper one dragged thicker, and a point added in the middle.
  await dialog.getByTestId('lp-flat').click()
  await expect(points).toHaveCount(2)
  await points.nth(0).focus()
  await dialog.getByTestId('lp-h').fill('0.12')
  await dialog.getByTestId('lp-h').press('Enter')
  await expect(dialog.getByTestId('lp-h')).toHaveValue('0.12')
  const upper = (await points.nth(1).boundingBox())!
  await page.mouse.move(upper.x + upper.width / 2, upper.y + upper.height / 2)
  await page.mouse.down()
  await page.mouse.move(upper.x + upper.width / 2 + 40, upper.y + upper.height / 2, { steps: 5 })
  await page.mouse.up()
  const area = (await dialog.getByTestId('lp-area').boundingBox())!
  await page.mouse.click(area.x + area.width * 0.2, area.y + area.height * 0.5)
  await expect(points).toHaveCount(3)
  await expect(dialog.getByTestId('lp-apply')).toBeEnabled()
  await shots(page, 'layer-editor-edited')

  // Apply: the plate's own layer heights, named Custom in the picker, and the plate slices with them.
  await dialog.getByTestId('lp-apply').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('easy-layer-custom')).toHaveText('Custom')
  const own = await profile(page)
  expect(own).toHaveLength(3)
  expect(own![0]![1]).toBeCloseTo(0.12, 3)
  expect(own![2]![1]).toBeGreaterThan(0.2)
  await closeSheet(page)
  await sliceNow(page)
  expect(await sliceStatus(page)).toBe('done')
  await openSheet(page)
  await shots(page, 'layer-custom')

  // The editor opens on them again, and Cancel keeps them.
  dialog = await openEditor(page)
  await expect(dialog.getByTestId('lp-point')).toHaveCount(3)
  await expect(dialog.getByTestId('lp-from-sleipnir')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await profile(page)).toEqual(own)

  // A fixed height puts the plate back on it.
  await page.locator('#easy-layer').click()
  await page.getByRole('menuitemcheckbox', { name: '0.20 mm' }).click()
  await expect.poll(() => profile(page)).toBeNull()
  await expect(page.getByTestId('easy-layer-custom')).toHaveCount(0)
}
