// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The scope pill over Print settings: with objects selected the settings edit the plate (the default) or the
// selection, whose own values sit over the plate's. Mixed across a selection, reset to the plate, and settings that
// hold for the whole plate stay the plate's.
import { type Page } from '@playwright/test'
import { closeSheet, expect, openSheet, plateReady, test } from './fixtures'

type Sx = { getState(): { objectSettings: Record<string, Record<string, unknown>>; easy: { supports: string } } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

async function open(page: Page, mode: 'simple' | 'advanced'): Promise<void> {
  await page.addInitScript((m) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: m, printerId: 'bay-1', pilot: { mode: 'off' }, cadTools: true }))
  }, mode)
  await page.goto('./')
  await plateReady(page)
  await openSheet(page)
}

const rows = (page: Page) => page.getByTestId('object-row')
const select = (page: Page, i: number, modifiers: ('ControlOrMeta' | 'Shift')[] = []) => rows(page).nth(i).getByTestId('object-select').click({ modifiers })
const settings = (page: Page) => page.locator('[data-section="settings"]')
/** Simple's way out of the selection, in the bar's menu. */
const clear = async (page: Page) => {
  await page.getByTestId('slice-selection-more').click()
  await page.getByTestId('slice-ctx-clear').click()
}

/** Opens Expert settings on one setting through the command palette, which searches for it there. */
async function goTo(page: Page, name: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await page.locator('.sx-palette-input').fill(name)
  await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
  await expect(page.locator('#expert-panel')).toBeVisible()
}

test('Simple: the pill starts on the plate, the selection gets its own supports, the plate keeps its own, and the goal stays the plate\'s', async ({ page }) => {
  await open(page, 'simple')
  // The plate opens with its object selected; with nothing selected there is no pill.
  await select(page, 0)
  await clear(page)
  await expect(page.getByTestId('slice-scope-plate')).toHaveCount(0)
  await select(page, 0)
  await expect(page.getByTestId('slice-scope-plate')).toHaveAttribute('aria-checked', 'true')
  await expect(settings(page).getByText('Every object on the plate changes.')).toBeVisible()
  await page.getByTestId('slice-scope-object').click()
  await expect(settings(page)).toHaveAttribute('data-scope', 'objects')
  await expect(settings(page).getByText('Only Layered X changes.')).toBeVisible()
  // A goal is for the whole plate: its tiles stay, still.
  await expect(page.getByRole('radiogroup', { name: 'Goal' }).getByRole('radio').first()).toBeDisabled()
  await settings(page).getByRole('radiogroup', { name: 'Supports' }).getByRole('radio', { name: 'Auto' }).click()
  await expect(page.getByTestId('slice-scope-label')).toContainText(/\d/)
  expect(Object.keys((await state(page)).objectSettings)).toHaveLength(1)
  // Back on the plate: its supports are still off.
  await page.getByTestId('slice-scope-plate').click()
  await expect(settings(page).getByRole('radiogroup', { name: 'Supports' }).getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
  // A selection that ends puts the next one back on the plate.
  await page.getByTestId('slice-scope-object').click()
  await clear(page)
  await expect(page.getByTestId('slice-scope-plate')).toHaveCount(0)
  await select(page, 0)
  await expect(page.getByTestId('slice-scope-plate')).toHaveAttribute('aria-checked', 'true')
  await closeSheet(page)
})

test('Expert in the selection\'s scope: own values over the plate, Mixed across objects, reset, and plate-wide settings held', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modifier keys need a keyboard')
  await open(page, 'advanced')
  await select(page, 0)
  await page.keyboard.press('ControlOrMeta+d')
  await expect(rows(page)).toHaveCount(2)
  await select(page, 0)
  await select(page, 1, ['ControlOrMeta'])
  await page.getByTestId('slice-scope-object').click()
  await expect(page.getByTestId('slice-scope-label')).toHaveText('2 objects')
  await goTo(page, 'wall loops')
  const walls = page.locator('[data-testid="slice-setting-row"][data-key="wall_loops"]')
  await expect(walls).toHaveAttribute('data-source', 'plate')
  await expect(walls).toContainText('from plate')
  const plateWalls = await walls.getByRole('textbox').inputValue()
  await walls.getByRole('textbox').fill('4')
  await walls.getByRole('textbox').press('Enter')
  await expect(walls).toHaveAttribute('data-source', 'own')
  await expect(walls).toContainText(`plate ${plateWalls}`)
  // One of the two to 5: the pair is mixed.
  await select(page, 1)
  await page.getByTestId('slice-scope-object').click()
  await walls.getByRole('textbox').fill('5')
  await walls.getByRole('textbox').press('Enter')
  await select(page, 0)
  await select(page, 1, ['ControlOrMeta'])
  await page.getByTestId('slice-scope-object').click()
  await expect(walls).toHaveAttribute('data-source', 'mixed')
  await expect(walls.getByRole('textbox')).toHaveAttribute('placeholder', 'Mixed')
  // Reset puts both back on the plate's value.
  await page.locator('[data-testid="slice-setting-reset"][data-key="wall_loops"]').click()
  await expect(walls).toHaveAttribute('data-source', 'plate')
  expect((await state(page)).objectSettings).toEqual({})
  // The skirt goes round the whole plate: in the selection's scope it cannot change.
  await page.locator('#expert-search').fill('skirt loops')
  const skirt = page.locator('[data-testid="slice-setting-row"][data-key="skirt_loops"]')
  await expect(skirt.getByRole('textbox')).toBeDisabled()
  await expect(skirt).toHaveAttribute('data-tip-reason', 'Set for the whole plate')
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the pill on the plate and on the selection, in Simple and in Expert, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await open(page, 'simple')
  const set = (p: unknown) => page.evaluate((x) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState(x), p)
  const shoot = async (name: string) => {
    await settings(page).evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/scope-${name}-${width}.png` })
  }
  for (const scheme of ['light', 'dark'] as const) {
    await set({ scheme, themeFollowsSystem: false, settingsMode: 'simple' })
    await select(page, 0)
    await page.getByTestId('slice-scope-plate').click()
    await shoot(`plate-${scheme}`)
    await page.getByTestId('slice-scope-object').click()
    await settings(page).getByRole('radiogroup', { name: 'Supports' }).getByRole('radio', { name: 'Auto' }).click()
    await shoot(`object-simple-${scheme}`)
    await set({ settingsMode: 'expert', expertOpen: true })
    await page.locator('#expert-search').fill('wall')
    await page.locator('[data-testid="slice-setting-row"][data-key="wall_loops"]').getByRole('textbox').fill('4')
    await page.locator('[data-testid="slice-setting-row"][data-key="wall_loops"]').getByRole('textbox').press('Enter')
    await page.locator('#expert-panel').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/scope-object-expert-${scheme}-${width}.png` })
    await set({ objectSettings: {}, settingsMode: 'simple', expertOpen: false, settingsScope: 'plate' })
  }
})
