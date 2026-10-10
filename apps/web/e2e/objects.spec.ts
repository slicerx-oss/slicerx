// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Objects card in the Slice sidebar: compact rows that open into a tree of parts and volumes, one Add button with
// its menu, renaming in place, and a tool that takes the card's place until Done.
import { type Page } from '@playwright/test'
import { addMenu, expect, openSheet, openTransform, plateReady, renameRow, setPartFilament, test } from './fixtures'

type Sx = { getState(): { selectedIds: string[]; objectTool: string | null }; setState(p: unknown): void }
const sx = (page: Page, p: unknown) => page.evaluate((x) => (window as unknown as { __sx: Sx }).__sx.setState(x), p)

async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' }, cadTools: true, ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
  // On a phone the sidebar is a sheet.
  await openSheet(page)
}

const rows = (page: Page) => page.getByTestId('object-row')

test('a row is one compact line with the name, the parts and their colors, and the count in the header', async ({ page, isMobile }) => {
  await open(page)
  const row = rows(page).first()
  const line = row.locator('.obj-row')
  expect(Math.round((await line.boundingBox())!.height)).toBe(isMobile ? 44 : 36)
  await expect(row.getByTestId('object-name')).toHaveText('Layered X')
  await expect(row.locator('.obj-meta')).toHaveText('2 parts')
  await expect(row.locator('.obj-swatches i')).toHaveCount(2)
  await expect(page.locator('[data-section="objects"] .objs-count')).toHaveText('1 on plate')
  // On a fine pointer, lock and print show only on hover; on touch they always show.
  const lock = row.getByTestId('object-lock')
  if (isMobile) await expect(lock).toBeVisible()
  else {
    await page.mouse.move(0, 0)
    await expect(lock).toBeHidden()
    await line.hover()
    await expect(lock).toBeVisible()
  }
})

test('the chevron opens the tree: parts with their filament, volumes with their role', async ({ page }) => {
  await open(page)
  const row = rows(page).first()
  await expect(row.getByTestId('object-part-slot')).toHaveCount(0)
  await row.getByTestId('slice-object-expand').click()
  await expect(row.getByTestId('object-part-slot')).toHaveCount(2)
  await setPartFilament(page, row, 3)
  await expect(row.getByTestId('object-part-slot').first()).toHaveAttribute('data-slot', '3')
})

test('a volume shows in the tree with its role', async ({ page }) => {
  await open(page, { settingsMode: 'advanced' })
  await page.locator('[data-section="volumes"]').getByRole('button', { name: 'Add' }).click()
  const row = rows(page).first()
  await row.getByTestId('slice-object-expand').click()
  await expect(row.getByTestId('slice-object-volume')).toHaveAttribute('data-role', 'negative')
})

test('a click selects, Cmd or Ctrl adds, a double-click or F2 renames in place', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modifier keys need a keyboard')
  await open(page)
  await page.keyboard.press('ControlOrMeta+d')
  await expect(rows(page)).toHaveCount(2)
  await rows(page).nth(0).getByTestId('object-select').click()
  await rows(page).nth(1).getByTestId('object-select').click({ modifiers: ['ControlOrMeta'] })
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().selectedIds)).toHaveLength(2)
  await renameRow(rows(page).nth(0), 'Bracket')
  await expect(rows(page).nth(0).getByTestId('object-name')).toHaveText('Bracket')
  await rows(page).nth(1).getByTestId('object-select').focus()
  await page.keyboard.press('F2')
  const field = rows(page).nth(1).getByTestId('object-rename')
  await expect(field).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
})

test('one Add button: the file dialog, and the Vault, shapes, Export, Tools and Object in its menu', async ({ page }) => {
  await open(page)
  const card = page.locator('[data-section="objects"]')
  await expect(card.getByTestId('objects-add-model')).toHaveText('Add')
  await expect(card.getByRole('button', { name: 'Add shape' })).toHaveCount(0)
  await page.getByTestId('slice-objects-add-menu').click()
  const menu = page.getByRole('menu', { name: 'Add' })
  await expect(menu.getByRole('menuitem')).toHaveText(['From the Vault', 'Add shape', 'Export', 'Tools', 'Object'])
  await page.keyboard.press('Escape')
  await addMenu(page, 'Add shape')
  await page.getByRole('menu', { name: 'Add shape' }).getByRole('menuitem', { name: 'Box' }).first().click()
  await expect(rows(page)).toHaveCount(2)
  await expect(page.locator('[data-section="objects"] .objs-count')).toHaveText('2 on plate')
  await addMenu(page, 'Export')
  await expect(page.getByTestId('export-save-project')).toBeVisible()
})

test('a tool takes the card\'s place, nothing above moves, and one way out brings the list back', async ({ page, isMobile }) => {
  await open(page)
  const filament = page.locator('[data-section="filament"]')
  // Measured from the top of the pane's content: a phone's sheet scrolls to the tool and grows with it, which moves
  // nothing in it.
  const topInPane = () =>
    filament.evaluate((el) => {
      const pane = el.closest('.pane')!
      const body = el.closest('.sx-rail-body')
      return el.getBoundingClientRect().top - pane.getBoundingClientRect().top + (body?.scrollTop ?? 0)
    })
  const top = await topInPane()
  await addMenu(page, 'Tools')
  await page.getByRole('menu', { name: 'Object tools' }).getByRole('menuitem', { name: 'Cut' }).click()
  await expect(page.locator('.tool-slot [data-section="cut-tool"]')).toBeVisible()
  await expect(page.getByTestId('objects-list')).toHaveCount(0)
  expect(await topInPane()).toBe(top)
  // Cut has its own Cancel and Cut, so it has no Done: one way out.
  await expect(page.getByTestId('slice-tool-done')).toHaveCount(0)
  await page.locator('[data-section="cut-tool"]').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('objects-list')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().objectTool)).toBeNull()
  // Paint has nothing to apply, so Done closes it.
  if (isMobile) return
  await rows(page).first().locator('.obj-row').click()
  await page.getByRole('button', { name: 'Paint', exact: true }).click()
  await expect(page.locator('.tool-slot[data-tool="Paint"]')).toBeVisible()
  await page.getByTestId('slice-tool-done').click()
  await expect(page.getByTestId('objects-list')).toBeVisible()
})

test('an empty plate says so and points at Add', async ({ page }) => {
  await open(page)
  await sx(page, { plate: [], selection: null, selectedIds: [] })
  const card = page.locator('[data-section="objects"]')
  await expect(card).toContainText('Nothing on the plate yet.')
  await expect(card).toContainText('Drop STL, 3MF or STEP files anywhere.')
  await expect(card.getByTestId('objects-add-model')).toBeVisible()
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: rows, the tree, the Add menu, a tool in the card, the number rows and an empty plate, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await open(page)
  await page.keyboard.press('ControlOrMeta+d')
  const card = page.locator('[data-section="objects"]')
  const shoot = async (name: string) => {
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/objects-${name}-${width}.png` })
  }
  for (const scheme of ['light', 'dark'] as const) {
    await sx(page, { scheme, themeFollowsSystem: false })
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await page.mouse.move(0, 0)
    await shoot(`rows-${scheme}`)
    await rows(page).first().getByTestId('slice-object-expand').click()
    await shoot(`tree-${scheme}`)
    await rows(page).first().getByTestId('slice-object-expand').click()
    await page.getByTestId('slice-objects-add-menu').click()
    await shoot(`add-menu-${scheme}`)
    await page.keyboard.press('Escape')
    await addMenu(page, 'Tools')
    await page.getByRole('menu', { name: 'Object tools' }).getByRole('menuitem', { name: 'Cut' }).click()
    await expect(page.locator('.tool-slot [data-section="cut-tool"]')).toBeVisible()
    await shoot(`tool-${scheme}`)
    await page.locator('[data-section="cut-tool"]').getByRole('button', { name: 'Cancel' }).click()
    // The selection bar under the list, and its Transform popover with the number rows.
    await rows(page).first().locator('.obj-row').click()
    await expect(page.getByTestId('slice-selection-bar')).toBeVisible()
    await page.mouse.move(0, 0)
    await shoot(`selection-${scheme}`)
    await openTransform(page)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/objects-transform-${scheme}-${width}.png` })
    await page.keyboard.press('Escape')
  }
  await sx(page, { plate: [], selection: null, selectedIds: [] })
  await shoot('empty-dark')
})
