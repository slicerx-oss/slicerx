// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the Color tab's feature filament table. Layered X is on the plate for its two filaments; the table lists the
// eight features with the object's filament by default, a pick writes the plate's setting, and after a slice each row
// shows what the feature printed with.
import { type Page } from '@playwright/test'
import { sliceCount, sliced, tab } from '../fixtures'
import { expect, journey as test } from '../journey'
import { calm, debugHooks, layeredX, patch, plain, state } from './lib/slice'

test.skip(({ isMobile }) => isMobile, 'Desktop layout and a pointer')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

type Sx = { getState(): { overrides: Record<string, unknown>; slice: { status: string; stale?: boolean; result?: { id: string } } } }

async function colorTab(page: Page): Promise<void> {
  await calm(page)
  await plain(page)
  await layeredX(page)
  await patch(page, { expertOpen: true, settingsScope: 'plate', selection: null, selectedIds: [] })
  await page.getByTestId('slice-settings-tab-multicolor').click()
  await expect(page.getByTestId('slice-feature-filaments')).toBeVisible()
}

async function sliceNow(page: Page): Promise<void> {
  const slice = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return { status: s.status, stale: s.stale ?? false, id: s.result?.id ?? null } })
  const before = (await slice()).id
  const slices1 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect.poll(async () => { const s = await slice(); return s.status === 'done' && !s.stale && s.id !== before }, { timeout: 120_000 }).toBe(true)
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 120_000 })
  await tab(page, 'prepare').click()
}

const row = (page: Page, key: string) => page.locator(`[data-testid="slice-feature-filament-row"][data-key="${key}"]`)

test('the Color tab assigns a filament to each feature, and shows what each printed with after a slice', async ({ page }) => {
  test.slow()
  await colorTab(page)
  const table = page.getByTestId('slice-feature-filaments')
  await expect(table.getByTestId('slice-feature-filament-row')).toHaveCount(8)
  await expect(row(page, 'sparse_infill_filament_id').getByTestId('slice-feature-filament-pick')).toHaveText("Object's filament")
  // one home: no separate settings row for these
  await expect(page.locator('[data-testid="slice-setting-row"][data-key="support_filament"]')).toHaveCount(0)

  await row(page, 'sparse_infill_filament_id').getByTestId('slice-feature-filament-pick').click()
  await page.locator('[data-testid="slice-feature-filament-option"][data-value="2"]').click()
  expect((await state(page)).overrides).toMatchObject({ sparse_infill_filament_id: 2 })
  await expect(row(page, 'sparse_infill_filament_id')).toHaveAttribute('data-value', '2')

  await sliceNow(page)
  await page.getByTestId('slice-settings-tab-multicolor').click()
  await expect(row(page, 'sparse_infill_filament_id').getByTestId('slice-feature-filament-printed')).toHaveAttribute('data-slots', /(^|,)2(,|$)/)

  await row(page, 'sparse_infill_filament_id').getByTestId('slice-feature-filament-row-reset').click()
  expect((await state(page)).overrides).not.toHaveProperty('sparse_infill_filament_id')
  // A jump to one of them from the command bar lands on its filament menu, as it does for any setting.
  await patch(page, { settingFocus: { key: 'support_interface_filament', label: 'Support interface filament' } })
  await expect(page.locator('#set-support_interface_filament')).toBeFocused()
  await expect(page.locator('#set-support_interface_filament')).toBeInViewport()
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
for (const size of [{ width: 1440, height: 900 }]) {
  test(`shots: the feature filament table at ${size.width}, light and dark`, async ({ page }, info) => {
    test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
    test.slow()
    const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
    await page.setViewportSize({ width: 1440, height: 900 })
    await colorTab(page)
    // The plate prints outer walls and support with 2; Layered X keeps its own outer wall on 1, a chip under that row.
    const id = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate[0]!.id)
    await patch(page, { overrides: { support_filament: 2, outer_wall_filament_id: 2 }, objectSettings: { [id]: { outer_wall_filament_id: 1 } } })
    await sliceNow(page)
    await page.setViewportSize(size)
    for (const scheme of ['light', 'dark'] as const) {
      await patch(page, { scheme, themeFollowsSystem: false, toast: null, expertOpen: true })
      const tabButton = page.getByTestId('slice-settings-tab-multicolor')
      if (await tabButton.isVisible()) await tabButton.click({ timeout: 5_000 }).catch(() => undefined)
      const table = page.getByTestId('slice-feature-filaments')
      if (await table.isVisible()) await table.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${dir}/table-${scheme}-${size.width}.png` })
      const pick = row(page, 'inner_wall_filament_id').getByTestId('slice-feature-filament-pick')
      if (await pick.isVisible()) {
        await pick.click({ timeout: 5_000 }).catch(() => undefined)
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${dir}/menu-${scheme}-${size.width}.png` })
        await page.keyboard.press('Escape')
      }
    }
    // A copy of Layered X without its own outer wall: the two selected read Mixed, and the closed section says so.
    const before = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate)
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { id: string; name: string; transform: number[] }[] }; setState(p: unknown): void } }).__sx
      const [first] = sx.getState().plate
      const t = [...first!.transform]
      t[12] = (t[12] ?? 0) + 70
      const copy = { ...first!, id: `${first!.id}-copy`, name: 'Layered X copy', transform: t }
      delete (copy as { instanceOf?: string }).instanceOf
      // A new object makes the last slice stale, as adding one in the app does.
      const slice = (sx.getState() as unknown as { slice: Record<string, unknown> }).slice
      sx.setState({ slice: { ...slice, stale: true }, plate: [first, copy], selection: first!.id, selectedIds: [first!.id, copy.id], settingsScope: 'objects', settingsSections: { 'multicolor/features': false } })
    })
    for (const scheme of ['light', 'dark'] as const) {
      await patch(page, { scheme, themeFollowsSystem: false, toast: null, expertOpen: true })
      const head = page.locator('[data-testid="slice-settings-section"][data-section="multicolor/features"]')
      if (await head.isVisible()) await head.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined)
      await page.mouse.move(0, 0)
      // Adding an object reflows both panes; software graphics can leave old tiles on screen until the next paint.
      await page.waitForTimeout(2000)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await page.screenshot({ path: `${dir}/mixed-closed-${scheme}-${size.width}.png` })
    }
    await patch(page, { plate: before, selection: null, selectedIds: [], settingsScope: 'plate', settingsSections: {}, objectSettings: {} })
  })
}
