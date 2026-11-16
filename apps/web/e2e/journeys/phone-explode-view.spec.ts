// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exploded view on a phone: the Spread control fits the view's top left column at 390 px, two rows with 44 px
// targets, in Prepare and in Model, and its options never move it.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { exploded, openAssembly } from '../explode-project'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { setState, settledView, useFileDialogs } from './lib/model'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSliceBySize: false } })
test.skip(({ isMobile }) => !isMobile, 'Runs at phone width')
useFileDialogs(true)

async function shots(page: Page, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath()
  mkdirSync(dir, { recursive: true })
  for (const scheme of ['dark', 'light'] as const) {
    await setState(page, { scheme, themeFollowsSystem: false })
    for (const spread of [0, 60]) {
      await page.locator('#explode-spread').fill(String(spread))
      // no tooltip from the last press, and in Model the view framed on the spread parts
      await page.mouse.move(2, 2)
      if (name.startsWith('model')) await page.evaluate(() => (window as unknown as { __vp: { frameSelection(o: unknown): void } }).__vp.frameSelection({ animate: false }))
      await settledView(page)
      await page.screenshot({ path: join(dir, `${name}-${spread}-${scheme}.png`) })
    }
  }
  await setState(page, { scheme: 'dark' })
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!

test.describe('exploded view on a phone', () => {
  for (const mode of ['slice', 'design'] as const) {
    test(`fits the view and spreads the assembly (${mode === 'slice' ? 'Prepare' : 'Model'})`, async ({ page }) => {
      const { assembly } = await openAssembly(page)
      await setState(page, { modelMode: mode })
      await setState(page, { selection: assembly, selectedIds: [assembly] })
      const bar = page.getByTestId('explode-bar')
      await expect(bar).toBeVisible()
      const b = await box(page, '[data-testid="explode-bar"]')
      expect(b.x).toBeGreaterThanOrEqual(8)
      expect(b.x + b.width).toBeLessThanOrEqual(390 - 8)
      for (const sel of ['#explode-spread', '[data-testid="explode-axis-radial"]', '[data-testid="explode-axis-z"]']) expect((await box(page, sel)).height, sel).toBeGreaterThanOrEqual(40)
      await page.locator('#explode-spread').fill('60')
      await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
      const at = await box(page, '[data-testid="explode-axis-radial"]')
      await page.getByTestId('explode-axis-x').click()
      expect(await box(page, '[data-testid="explode-axis-radial"]')).toEqual(at)
      await page.getByTestId('explode-axis-radial').click()
      await shots(page, `${mode === 'slice' ? 'prepare' : 'model'}-390`)
      await setState(page, { modelMode: 'slice' })
    })
  }
})
