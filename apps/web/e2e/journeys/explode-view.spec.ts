// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exploded view: with an object of several parts selected, the Spread control over the view draws its parts moved
// apart, in Prepare and in Model. It is display only (the object's transform and the plate stay as they were), the
// axis options never move the control, it hides for a single part and goes back to 0 when the selection changes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { appState, exploded, openAssembly, setApp } from '../explode-project'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { settledView, useFileDialogs } from './lib/model'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, autoSliceBySize: false } })
test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
useFileDialogs()

/** Where the control and its parts sit, rounded to whole pixels. */
async function layout(page: Page): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {}
  for (const [k, sel] of Object.entries({ bar: '[data-testid="explode-bar"]', slider: '#explode-spread', radial: '[data-testid="explode-axis-radial"]', z: '[data-testid="explode-axis-z"]', look: '.hud-top .hud-row .sx-btn' })) {
    const b = await page.locator(sel).first().boundingBox()
    out[k] = b ? [b.x, b.y, b.width, b.height].map(Math.round) : []
  }
  return out
}

/** With SX_SHOTS (and SX_SHOTS_DIR for where), the view at 0 and 60 percent in dark and light. */
async function shots(page: Page, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath()
  mkdirSync(dir, { recursive: true })
  for (const scheme of ['dark', 'light'] as const) {
    await setApp(page, { scheme, themeFollowsSystem: false })
    for (const spread of [0, 60]) {
      await page.locator('#explode-spread').fill(String(spread))
      // no tooltip from the last press, and in Model the view framed on the spread parts
      await page.mouse.move(2, 2)
      if (name.startsWith('model')) await page.evaluate(() => (window as unknown as { __vp: { frameSelection(o: unknown): void } }).__vp.frameSelection({ animate: false }))
      await settledView(page)
      await page.screenshot({ path: join(dir, `${name}-${spread}-${scheme}.png`) })
    }
  }
  await setApp(page, { scheme: 'dark' })
}

test.describe('exploded view', () => {
  test('spreads the selected assembly in Prepare, display only, and the options never move', async ({ page }) => {
    const { assembly, single } = await openAssembly(page)
    const bar = page.getByTestId('explode-bar')
    await expect(bar).toBeVisible()
    const before = (await appState(page)).plate.find((p) => p.id === assembly)!.transform

    await page.locator('#explode-spread').fill('60')
    await expect(bar.locator('output')).toHaveText('60%')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    const radial = (await exploded(page))[assembly]!
    // the parts moved apart; the object and the plate did not
    expect(new Set(radial.map((o) => o.join(','))).size).toBe(3)
    expect((await appState(page)).plate.find((p) => p.id === assembly)!.transform).toEqual(before)

    // Static controls: picking an axis keeps the bar, the slider, every option and the look button where they were.
    const at = await layout(page)
    await page.getByTestId('explode-axis-z').click()
    await expect(page.getByTestId('explode-axis-z')).toHaveAttribute('aria-checked', 'true')
    expect(await layout(page)).toEqual(at)
    await expect.poll(async () => (await exploded(page))[assembly]!.map((o) => o[2]! > 0).filter(Boolean).length).toBe(2)
    const z = (await exploded(page))[assembly]!
    for (const o of z) expect([o[0], o[1]]).toEqual([0, 0])
    await page.getByTestId('explode-axis-radial').click()
    expect(await layout(page)).toEqual(at)

    await shots(page, 'prepare-1440')

    // a single part has nothing to spread; a new selection puts the parts back
    await setApp(page, { selection: single, selectedIds: [single] })
    await expect(bar).toBeHidden()
    expect((await appState(page)).explode.spread).toBe(0)
    expect(await exploded(page)).toEqual({})
    await setApp(page, { selection: assembly, selectedIds: [assembly] })
    await expect(page.locator('#explode-spread')).toHaveValue('0')
  })

  test('spreads the selected assembly in Model too', async ({ page }) => {
    const { assembly } = await openAssembly(page)
    await setApp(page, { modelMode: 'design' })
    await setApp(page, { selection: assembly, selectedIds: [assembly] })
    const bar = page.getByTestId('explode-bar')
    await expect(bar).toBeVisible()
    await page.locator('#explode-spread').fill('60')
    await expect.poll(async () => (await exploded(page))[assembly]?.length ?? 0).toBe(3)
    await shots(page, 'model-1440')
    await setApp(page, { modelMode: 'slice' })
  })
})
