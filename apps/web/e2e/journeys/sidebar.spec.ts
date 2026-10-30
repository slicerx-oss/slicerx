// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Slice sidebar and the object list on a desktop window: the printer row and its machine card, the Filament
// rail, the print settings' tabs and folds, the Objects card, the scope pill, and the selection bar. One page per
// worker; each test sets up its own mode, printer and plate. The phone legs are in phone-shell.spec.ts.
import { type Page } from '@playwright/test'
import { pressable, reducedMotion, screenOf, steady } from '../canvas-press'
import { expectFileDialog, interceptFileDialogs } from '../file-dialog'
import { addMenu, expect, openTransform, plateReady, renameRow, setPartFilament, tabName } from '../fixtures'
import { addPlateFromPicker, pickPlate } from '../plate-project'
import {
  BAY_1, H2D, HAND_PRINTERS, UNCONNECTED, addFilamentMovesNothing, dismiss, emptyPlateSaysSo, exportOnly, fullSectionWraps, layoutReset, machineBoxesChange, mode, objectRowIsCompact, optionsMenuOnTop, plateTypePerPlate,
  setState, settingsReset, sidebarAs, sidebarDone, slot, slotHighlights, spoolsShow, test, type FilamentSx,
} from './lib/shell'
import { layeredMid } from './lib/slice'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'simple', printerId: BAY_1, pilot: { mode: 'off' }, cadTools: true, handPrinters: HAND_PRINTERS } })
test.skip(({ isMobile }) => isMobile, 'Desktop window; the phone legs are in phone-shell.spec.ts')

type Sx = {
  getState(): ReturnType<FilamentSx['getState']> & {
    plate: { id: string; printable?: boolean; locked?: boolean }[]
    selection: string | null
    objectSettings: Record<string, Record<string, unknown>>
    objectTool: string | null
    calibrationOpen: boolean
  }
}
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

// ---- the sidebar's panels ------------------------------------------------------------------------------------

test.describe('the sidebar panels', () => {
  test('the printer row is three boxes, each other section is its own panel with an icon, and Simple keeps them open with no fold', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const row = page.locator('.sx-block[data-section="printer"] .mc-row')
    await expect(row).toBeVisible()
    for (const id of ['slice-machine-printer', 'slice-machine-nozzle', 'slice-machine-plate']) await expect(row.getByTestId(id)).toBeVisible()
    for (const id of ['filament', 'settings']) {
      const sec = page.locator(`.pane-body > .sx-block[data-section="${id}"]`)
      await expect(sec).toBeVisible()
      await expect(sec.locator('.sx-block-h .sx-block-icon')).toHaveCount(1)
      const look = await sec.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { radius: parseFloat(cs.borderTopLeftRadius), border: cs.borderTopStyle }
      })
      expect(look.radius).toBeGreaterThan(0)
      expect(look.border).toBe('solid')
    }
    // The panels sit apart on the darker ground.
    const gap = await page.locator('.pane-body').first().evaluate((el) => parseFloat(getComputedStyle(el).rowGap))
    expect(gap).toBeGreaterThan(0)
    // Simple mode keeps the sections open with no fold.
    await mode(page, 'simple')
    await expect(page.locator('#printer-fold, #filament-fold')).toHaveCount(0)
    await sidebarDone(page)
  })

  test('filament folds to a summary line and stays folded after a reload; the printer row has no fold', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    try {
      await expect(page.locator('#printer-fold')).toHaveCount(0)
      const filament = page.locator('.sx-block[data-section="filament"]')
      await filament.getByRole('button', { name: 'Filament', exact: true }).click()
      await expect(filament).toHaveAttribute('data-collapsed', 'true')
      await expect(filament.locator('.sec-sum')).toContainText('used')
      await page.reload()
      await expect(page.locator('.sx-block[data-section="filament"]')).toHaveAttribute('data-collapsed', 'true')
      await page.locator('.sx-block[data-section="filament"]').getByRole('button', { name: 'Filament', exact: true }).click()
      await expect(page.locator('.sx-block[data-section="filament"]')).not.toHaveAttribute('data-collapsed', 'true')
      await expect(page.locator('.sx-block[data-section="printer"] .mc-row')).toBeVisible()
    } finally {
      await sidebarDone(page)
    }
  })

  test('the mode chip in the pane title changes the mode across the app and keeps it after a reload', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    try {
      const chip = page.getByTestId('slice-mode-chip')
      await expect(chip).toHaveText('Advanced')
      // In the pane title, on one line with it.
      const head = page.locator('.pane .sx-rail-head').filter({ has: chip })
      await expect(head).toBeVisible()
      await expect(head.locator('.sx-rail-title')).toHaveText('Printer and settings')
      // Print settings no longer carries its own mode control.
      await expect(page.locator('.sx-block[data-section="settings"]').getByRole('radiogroup', { name: 'Settings mode' })).toHaveCount(0)
      await chip.click()
      const menu = page.getByRole('menu', { name: 'Settings mode' })
      await expect(menu.getByTestId('slice-mode-chip-simple')).toContainText('The few settings most prints need.')
      await expect(menu.getByTestId('slice-mode-chip-advanced')).toHaveAttribute('aria-checked', 'true')
      await menu.getByTestId('slice-mode-chip-simple').click()
      await expect(menu).toHaveCount(0)
      await expect(chip).toHaveText('Simple')
      // Simple keeps the sections open with no fold, and Expert settings go away.
      await expect(page.locator('#printer-fold, #filament-fold')).toHaveCount(0)
      await expect(page.locator('[data-section="expert"]')).toHaveCount(0)
      // By keyboard: open, move down to Expert, choose it.
      await chip.focus()
      await page.keyboard.press('Enter')
      await expect(menu.getByTestId('slice-mode-chip-simple')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expect(chip).toHaveText('Expert')
      await expect(page.locator('[data-section="expert"]')).toHaveCount(1)
      await page.reload()
      await expect(page.getByTestId('slice-mode-chip')).toHaveText('Expert')
      const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as { settingsMode?: string }
      expect(prefs.settingsMode).toBe('expert')
    } finally {
      await mode(page, 'simple')
      await sidebarDone(page)
    }
  })

  test('the Print settings header stays one line at the narrowest sidebar width', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    try {
      await setState(page, { paneSizes: { 'slicerx:prepare-left': 288 } })
      await expect(page.getByTestId('slice-mode-chip')).toBeVisible()
      await expect.poll(async () => Math.round((await page.locator('.pane[data-side="left"]').boundingBox())!.width)).toBeLessThanOrEqual(290)
      const header = page.locator('.sx-block[data-section="settings"] .sx-block-h')
      const h = await header.evaluate((el) => el.getBoundingClientRect().height)
      expect(h).toBeLessThan(48)
      const head = await page.locator('.pane .sx-rail-head').first().evaluate((el) => el.getBoundingClientRect().height)
      expect(head).toBe(44)
    } finally {
      await layoutReset(page)
      await sidebarDone(page)
    }
  })
})

// The Settings tabs' ARIA and state are covered by RTL tests; these two stay because they measure layout.
test.describe('the settings tabs layout', () => {
  const header = (page: Page, key: string) => page.locator(`[data-testid="slice-settings-section"][data-section="${key}"]`)

  test('sections fold to a summary line around the pointer, and changed rows stay listed', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    try {
      await setState(page, { expertOpen: true })
      await setState(page, { overrides: { seam_position: 'back' } })
      // The first section with rows starts open; the others show a summary of their values.
      await expect(header(page, 'quality/layers')).toHaveAttribute('aria-expanded', 'true')
      const seam = header(page, 'quality/seam')
      await expect(seam).toHaveAttribute('aria-expanded', 'false')
      await expect(seam).toContainText('1 changed')
      await expect(page.locator('#set-seam_position')).toBeVisible()
      // Opening and closing never moves the header under the pointer.
      const walls = header(page, 'quality/walls')
      // The click's own scroll (into view) is not the app moving anything: measure after it.
      await walls.scrollIntoViewIfNeeded()
      const y = (await walls.boundingBox())!.y
      await walls.click()
      await expect(walls).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('#set-wall_generator, [data-key="wall_generator"]').first()).toBeVisible()
      expect((await walls.boundingBox())!.y).toBe(y)
      await walls.click()
      await expect(walls).toHaveAttribute('aria-expanded', 'false')
      expect((await walls.boundingBox())!.y).toBe(y)
      // The tab counts its changes.
      await expect(page.getByTestId('slice-settings-tab-quality').getByTestId('slice-settings-tab-count')).toHaveText('1')
      await expect(page.getByTestId('slice-settings-tab-strength').getByTestId('slice-settings-tab-count')).toHaveCount(0)
    } finally {
      await setState(page, { overrides: {} })
      await settingsReset(page)
      await sidebarDone(page)
    }
  })

  test('the tab row sticks while its tab scrolls, a tab click never moves it, and a closing section near the end keeps its place', async ({ page }) => {
    await sidebarAs(page, { mode: 'expert' })
    try {
      await setState(page, { expertOpen: true })
      // Open every Quality section, then scroll the pane far down so the tab row sticks.
      for (const key of ['layers', 'walls', 'seam', 'surfaces', 'overhangs', 'precision', 'flow']) {
        const h = header(page, `quality/${key}`)
        if ((await h.getAttribute('aria-expanded')) === 'false') await h.click()
      }
      const bar = page.locator('.set-tabs-bar')
      const last = header(page, 'quality/flow')
      await last.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await page.mouse.wheel(0, 4000)
      await expect(bar).toHaveAttribute('data-stuck', 'true')
      const barY = (await bar.boundingBox())!.y
      // A closing section at the bottom of the pane keeps its header where it was.
      const flow = header(page, 'quality/flow')
      await flow.scrollIntoViewIfNeeded()
      const fy = (await flow.boundingBox())!.y
      await flow.click()
      await expect(flow).toHaveAttribute('aria-expanded', 'false')
      expect(Math.abs((await flow.boundingBox())!.y - fy)).toBeLessThanOrEqual(1)
      // A short tab under a stuck row: the row stays put and the tab shows from its start.
      await page.mouse.wheel(0, 4000)
      const stuckY = (await bar.boundingBox())!.y
      await page.getByTestId('slice-settings-tab-speed').click()
      await expect(page.getByTestId('slice-settings-tab-speed')).toHaveAttribute('aria-selected', 'true')
      expect(Math.abs((await bar.boundingBox())!.y - stuckY)).toBeLessThanOrEqual(1)
      const heading = page.locator('#set-tab-panel section[aria-label="Speed"] > h4')
      const hb = (await heading.boundingBox())!
      const bb = (await bar.boundingBox())!
      expect(hb.y).toBeGreaterThanOrEqual(bb.y + bb.height - 1)
      expect(hb.y).toBeLessThan(bb.y + bb.height + 40)
      expect(barY).toBeGreaterThanOrEqual(0)
    } finally {
      await settingsReset(page)
      await mode(page, 'simple')
      await sidebarDone(page)
    }
  })
})

// ---- add it by hand ------------------------------------------------------------------------------------------

test('add it by hand starts with no brand chosen', async ({ page }) => {
  // "Add it by hand" opens the brand grid with no brand chosen, even when the link was double clicked: the grid opens
  // under the pointer, and the second click must not pick the tile that lands there. A tile's own click still picks it.
  await sidebarAs(page, { mode: 'advanced' })
  await page.getByTestId('slice-machine-printer').click()
  await page.locator('.choose-add').click()
  const link = page.getByRole('button', { name: /Add it by hand/ }).first()
  await expect(link).toBeVisible()
  await link.dblclick()
  const brands = page.getByRole('radiogroup', { name: 'Brand' })
  await expect(brands.getByRole('radio').first()).toBeVisible()
  await expect(brands.getByRole('radio', { checked: true })).toHaveCount(0)
  await brands.getByRole('radio', { name: /Bambu Lab/ }).click()
  await expect(brands.getByRole('radio', { checked: true })).toHaveText(/Bambu Lab/)
  // "Add it by hand" opens the setup dialog; a reload would open it again, so it is closed in the app's state.
  await setState(page, { setup: null })
  await dismiss(page)
  await sidebarDone(page)
})

// ---- the machine card ----------------------------------------------------------------------------------------

// The no-printer state is covered by the machine card unit test, since the web build always has its demo printers.
test.describe('the machine card', () => {
  test('the printer, nozzle and plate boxes change them in place, with the printer\'s name in full', async ({ page }) => {
    await machineBoxesChange(page)
  })

  test('the plate type is per plate', async ({ page }) => {
    await plateTypePerPlate(page, { add: () => addPlateFromPicker(page), show: (n) => pickPlate(page, n) })
  })

  test('a printer with no connection reads Export only', async ({ page }) => {
    await exportOnly(page)
  })

  test('Advanced lists Printer settings, and the card keeps the printer on top with the nozzle and plate side by side under it', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced', printer: BAY_1 })
    const card = page.getByTestId('slice-machine-card')
    await page.getByTestId('slice-machine-printer').click()
    await page.getByTestId('slice-machine-printer-settings').click()
    const dialog = page.getByRole('dialog', { name: /Printer settings/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(card.locator('.mc-row')).toHaveAttribute('data-summary', /^Bay 1, \d\.\d+ mm, .+, [A-Z][a-z ]+$/)
    // The printer box spans the card; the nozzle and the plate share the row under it, the same size, each in words.
    const [printer, nozzle, plate] = await Promise.all(['slice-machine-printer', 'slice-machine-nozzle', 'slice-machine-plate'].map(async (id) => (await page.getByTestId(id).boundingBox())!))
    expect(Math.abs(nozzle!.y - plate!.y)).toBeLessThan(1)
    expect(nozzle!.y).toBeGreaterThanOrEqual(printer!.y + printer!.height)
    expect(Math.abs(nozzle!.width - plate!.width)).toBeLessThan(1)
    expect(Math.abs(nozzle!.x - printer!.x)).toBeLessThan(1)
    expect(Math.abs(plate!.x + plate!.width - (printer!.x + printer!.width))).toBeLessThan(1)
    await expect(page.getByTestId('slice-machine-nozzle')).toContainText('Nozzle')
    await expect(page.getByTestId('slice-machine-plate-label')).not.toBeEmpty()
    await sidebarDone(page)
  })

  test('the card works by keyboard: Enter opens a box, arrows move, Escape closes', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple', printer: BAY_1 })
    const plate = page.getByTestId('slice-machine-plate')
    const nozzle = page.getByTestId('slice-machine-nozzle')
    // Tab is the look's Model and Slice switch here, so the box gets focus directly.
    await expect(nozzle).toBeVisible()
    await plate.focus()
    await expect(plate).toBeFocused()
    await page.keyboard.press('Enter')
    const types = page.getByTestId('slice-machine-plate-option')
    await expect(types.first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(types.nth(1)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Plate type' })).toHaveCount(0)
    await expect(plate).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await expect(types.last()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(plate).toHaveAttribute('aria-label', 'Plate: High temp plate')
    await sidebarDone(page)
  })

  test('Simple at 1440 by 900 with nothing selected has Supports on screen', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple', printer: BAY_1 })
    await page.keyboard.press('Escape')
    await page.locator('.vp').click({ position: { x: 5, y: 300 } })
    const supports = page.getByRole('radiogroup', { name: 'Supports' })
    await expect(supports).toBeVisible()
    const box = (await supports.boundingBox())!
    const foot = (await page.locator('.sx-rail-foot').first().boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(foot.y)
    await sidebarDone(page)
  })
})

// ---- the Objects card ----------------------------------------------------------------------------------------

const rows = (page: Page) => page.getByTestId('object-row')

test.describe('the Objects card', () => {
  test('a row is one compact line with the name, the parts and their colors, and the count in the header', async ({ page }) => {
    await objectRowIsCompact(page, false)
  })

  test('the chevron opens the tree: parts with their filament', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    const row = rows(page).first()
    await expect(row.getByTestId('object-part-slot')).toHaveCount(0)
    await row.getByTestId('slice-object-expand').click()
    await expect(row.getByTestId('object-part-slot')).toHaveCount(2)
    await setPartFilament(page, row, 3)
    await expect(row.getByTestId('object-part-slot').first()).toHaveAttribute('data-slot', '3')
    await sidebarDone(page)
  })

  test('a volume shows in the tree with its role', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await page.locator('[data-section="volumes"]').getByRole('button', { name: 'Add' }).click()
    const row = rows(page).first()
    await row.getByTestId('slice-object-expand').click()
    await expect(row.getByTestId('slice-object-volume')).toHaveAttribute('data-role', 'negative')
    await sidebarDone(page)
  })

  test('a click selects, Cmd or Ctrl adds, a double-click or F2 renames in place', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await page.keyboard.press('ControlOrMeta+d')
    await expect(rows(page)).toHaveCount(2)
    await rows(page).nth(0).getByTestId('object-select').click()
    await rows(page).nth(1).getByTestId('object-select').click({ modifiers: ['ControlOrMeta'] })
    expect((await state(page)).selectedIds).toHaveLength(2)
    await renameRow(rows(page).nth(0), 'Bracket')
    await expect(rows(page).nth(0).getByTestId('object-name')).toHaveText('Bracket')
    await rows(page).nth(1).getByTestId('object-select').focus()
    await page.keyboard.press('F2')
    const field = rows(page).nth(1).getByTestId('object-rename')
    await expect(field).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(field).toHaveCount(0)
    await sidebarDone(page)
  })

  test('one Add button: the file dialog, and the Vault, shapes, Export, Tools and Object in its menu', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
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
    await sidebarDone(page)
  })

  test('a tool takes the card\'s place, nothing above moves, and one way out brings the list back', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    const filament = page.locator('[data-section="filament"]')
    // Measured from the top of the pane's content.
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
    // to half a pixel, as in layout-stability: on a phone the pane once read 119.99998 for 120
    expect(Math.abs((await topInPane()) - top)).toBeLessThanOrEqual(0.5)
    // Cut has its own Cancel and Cut, so it has no Done: one way out.
    await expect(page.getByTestId('slice-tool-done')).toHaveCount(0)
    await page.locator('[data-section="cut-tool"]').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('objects-list')).toBeVisible()
    expect((await state(page)).objectTool).toBeNull()
    // Paint has nothing to apply, so Done closes it.
    await rows(page).first().locator('.obj-row').click()
    await page.getByRole('button', { name: 'Paint', exact: true }).click()
    await expect(page.locator('.tool-slot[data-tool="Paint"]')).toBeVisible()
    await page.getByTestId('slice-tool-done').click()
    await expect(page.getByTestId('objects-list')).toBeVisible()
    await sidebarDone(page)
  })

  test('an empty plate says so and points at Add', async ({ page }) => {
    await emptyPlateSaysSo(page)
  })
})

// ---- the scope pill ------------------------------------------------------------------------------------------

test.describe('the scope pill', () => {
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
    await sidebarAs(page, { mode: 'simple' })
    // The plate opens with its object selected; with nothing selected there is no pill.
    await select(page, 0)
    await clear(page)
    // With nothing selected the pill stays, its second option unavailable, so nothing under it moves as a selection
    // starts or ends.
    await expect(page.getByTestId('slice-scope-object')).toBeDisabled()
    const goal = page.getByRole('radiogroup', { name: 'Goal' })
    const before = (await goal.boundingBox())!.y
    await select(page, 0)
    expect((await goal.boundingBox())!.y).toBe(before)
    await expect(page.getByTestId('slice-scope-plate')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('slice-scope-object').click()
    await expect(settings(page)).toHaveAttribute('data-scope', 'objects')
    expect((await goal.boundingBox())!.y).toBe(before)
    await expect(settings(page).getByText('Set on the plate')).toBeVisible()
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
    await expect(page.getByTestId('slice-scope-object')).toBeDisabled()
    await select(page, 0)
    await expect(page.getByTestId('slice-scope-plate')).toHaveAttribute('aria-checked', 'true')
    await sidebarDone(page)
  })

  test('in the selection\'s scope the layer height says sleipnir until the selection has its own, and the goal reads as unavailable', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    const layer = page.locator('#easy-layer')
    await expect(layer).toContainText('sleipnir')
    await select(page, 0)
    await page.getByTestId('slice-scope-object').click()
    // The object prints on the plate's layers until it has a height of its own.
    await expect(layer).toContainText('sleipnir')
    const draft = page.getByTestId('slice-goal-draft')
    await expect(draft).toBeDisabled()
    expect(Number(await draft.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.6)
    await layer.click()
    await page.getByRole('menu', { name: 'Layer height' }).getByText('0.16 mm').click()
    await expect(layer).toHaveText('0.16 mm')
    // The plate keeps sleipnir.
    await page.getByTestId('slice-scope-plate').click()
    await expect(layer).toContainText('sleipnir')
    await sidebarDone(page)
  })

  test('Expert in the selection\'s scope: own values over the plate, Mixed across objects, reset, and plate-wide settings held', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    try {
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
    } finally {
      await settingsReset(page)
      await sidebarDone(page)
    }
  })
})

// ---- the Filament rail ---------------------------------------------------------------------------------------

test.describe('the Filament rail', () => {
  /** Room from the bottom of the Filament card to the top of Print settings, in px. */
  const gapToSettings = (page: Page) =>
    page.evaluate(() => {
      const f = document.querySelector('[data-section="filament"]')!.getBoundingClientRect()
      const p = document.querySelector('[data-section="settings"]')!.getBoundingClientRect()
      return Math.round(p.top - f.bottom)
    })
  const foot = (page: Page) => page.getByTestId('slice-filament-foot')
  /** The line under the rail reads its hint, or a setup note in the hint's place once the settings plan has one. */
  async function lineReads(page: Page, hint: RegExp): Promise<void> {
    await expect(async () => {
      const note = await foot(page).getByRole('status', { name: 'Setup notes' }).count()
      expect(note > 0 || hint.test(await foot(page).locator('.rail-foot-text').innerText())).toBe(true)
    }).toPass()
  }
  const sx = (page: Page, p: unknown) => setState(page, p as Record<string, unknown>)

  test('printer, filament and settings share one vertical scroll area', async ({ page }, info) => {
    await sidebarAs(page, { mode: 'advanced', printer: H2D.id })
    try {
      await expect(page.getByTestId('slice-filament-rail')).toBeVisible()
      const pane = page.locator('.pane[data-side="left"]')
      const scrollAreas = () => pane.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('*')).filter((node) => {
        const overflow = getComputedStyle(node).overflowY
        return (overflow === 'auto' || overflow === 'scroll') && node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 2
      }).map((node) => node.className))
      if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath('sidebar-overflow.png') })
      await expect.poll(scrollAreas).toEqual(['sx-rail-body'])
      const footer = pane.locator('.sx-rail-foot')
      const before = await footer.boundingBox()
      const scroller = pane.locator('.sx-rail-body')
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      await expect(footer).toBeVisible()
      expect(await footer.boundingBox()).toEqual(before)
      await page.locator('#expert-toggle').scrollIntoViewIfNeeded()
      await expect(page.locator('#expert-toggle')).toBeVisible()
    } finally {
      await sidebarDone(page)
    }
  })

  test('Print settings sits the same gap under Filament with Filament open or shut, even after scrolling; and the gap is the same when the slots fit', async ({ page }) => {
    // Two nozzles and their slots make the sidebar overflow.
    await sidebarAs(page, { mode: 'advanced', printer: H2D.id })
    try {
      const toggle = page.locator('[data-section="filament"] .sx-block-toggle')
      const body = page.locator('.pane[data-side="left"] .sx-rail-body')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const shut = await gapToSettings(page)
      expect(shut).toBeLessThanOrEqual(24)
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      // Closing the slots after scrolling preserves the gap to Print settings.
      await body.evaluate((e) => (e.scrollTop = 40))
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect.poll(() => gapToSettings(page)).toBe(shut)
      await expect(body.locator('[data-sx-room]')).toHaveCount(0)
    } finally {
      await sidebarDone(page)
    }
    // With the slots fitting (the reference printer), the gap is the same open and shut.
    await sidebarAs(page, { mode: 'advanced' })
    try {
      const toggle = page.locator('[data-section="filament"] .sx-block-toggle')
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
      const opened = await gapToSettings(page)
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect.poll(() => gapToSettings(page)).toBe(opened)
    } finally {
      await sidebarDone(page)
    }
  })

  test('hovering or focusing a slot picks its filament out in the viewport, and leaving clears it', async ({ page }) => {
    await slotHighlights(page, false)
  })

  test('Alt-click selects every object on that filament and says so', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await sx(page, { selection: null, selectedIds: [] })
    await slot(page, 1).click({ modifiers: ['Alt'] })
    await expect(page.getByTestId('toast').filter({ hasText: /^Selected 1 object on PLA / })).toBeVisible()
    expect((await state(page)).selectedIds).toHaveLength(1)
    // A plain click moves the selection to that spool; the slot's menu edits what it holds.
    await slot(page, 1).click({ button: 'right' })
    await page.getByTestId('slice-filament-edit').click()
    await expect(page.getByRole('dialog', { name: /Filament 1/ })).toBeVisible()
    await sidebarDone(page)
  })

  test('every loaded spool shows; the ones in use carry an edge and a part count; a click moves nothing', async ({ page }) => {
    // Which parts a click moves is covered by packages/app/test/filament-pick.test.ts:80-121.
    await spoolsShow(page)
  })

  test('the context menu offers the printer filament, by mouse and by keyboard, and a changed slot goes back', async ({ page }) => {
    // The words of a slot that differs from the printer are covered by packages/app/test/slot-rail.test.ts:25.
    await sidebarAs(page, { mode: 'simple' })
    await sx(page, { slotSetup: { 2: { type: 'PETG', brand: '', color: '#ffffff' } } })
    await expect(slot(page, 2)).toHaveAttribute('data-mismatch', 'true')
    await slot(page, 2).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Filament slot' })
    await expect(menu.getByTestId('slice-filament-use-printer')).toBeVisible()
    await page.keyboard.press('Escape')
    await slot(page, 2).focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    await menu.getByTestId('slice-filament-use-printer').click()
    await expect(slot(page, 2)).not.toHaveAttribute('data-mismatch', 'true')
    await sidebarDone(page)
  })

  test('the menu holds Calibrate, Flush volumes and Swap colors, and Swap colors swaps the two filaments on the plate', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await page.getByTestId('slice-filament-menu').click()
    await expect(page.getByTestId('slice-filament-calibrate')).toBeVisible()
    await expect(page.getByTestId('slice-filament-flush')).toBeVisible()
    await expect(page.getByTestId('slice-filament-swap')).toBeVisible()
    // Nothing edited: no reset. Every spool shows already, so there is no switch for unused ones.
    await expect(page.getByTestId('slice-filament-reset')).toHaveCount(0)
    await expect(page.getByRole('menuitemcheckbox', { name: 'Show unused slots' })).toHaveCount(0)
    await expect(page.locator('[data-testid="slice-filament-slot"][data-used="false"]').first()).toBeVisible()
    await page.getByTestId('slice-filament-swap').click()
    const swap = page.getByRole('group', { name: 'Swap colors on this plate' })
    await expect(swap).toBeVisible()
    await swap.getByRole('button', { name: 'Swap', exact: true }).click()
    await expect(swap).toContainText('prints as')
    await swap.getByRole('button', { name: 'Undo swaps' }).click()
    await expect(swap).not.toContainText('prints as')
    await sidebarDone(page)
  })

  test('the Filament options menu sits on top of the nozzle rows under it', async ({ page }) => {
    await optionsMenuOnTop(page, false)
  })

  test('a full section wraps inside the card, never the page, at any width', async ({ page }) => {
    await fullSectionWraps(page)
  })

  for (const settingsMode of ['simple', 'expert'] as const) {
    test(`Add filament shows in ${settingsMode === 'simple' ? 'Simple' : 'Expert'}, opens the new filament, and moves nothing`, async ({ page }) => {
      // Adding the next slot with the defaults is covered by packages/app/test/slot-rail.test.ts:31.
      await addFilamentMovesNothing(page, settingsMode)
    })
  }

  test("with the printer's slots, the rail says where they come from, has no add, and resets to the printer", async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await expect(foot(page)).toHaveAttribute('data-from', 'printer')
    await lineReads(page, /^From the printer('s \w+)?\. Right-click a spool to change it\.$/)
    await expect(page.getByTestId('slice-filament-add')).toHaveCount(0)
    await expect(page.getByTestId('slice-filament-foot-reset')).toHaveCount(0)
    // A slot changed here offers the way back, in place.
    await sx(page, { slotSetup: { 1: { type: 'PETG', brand: '', color: '#ffffff' } } })
    const reset = page.getByTestId('slice-filament-foot-reset')
    await expect(reset).toHaveText('Reset to printer')
    await reset.click()
    await expect(slot(page, 1)).not.toHaveAttribute('data-mismatch', 'true')
    await expect(reset).toHaveCount(0)
    await sidebarDone(page)
  })

  test('a filament color close to the panel gets a contrast edge, in both themes', async ({ page }) => {
    // Dark gray on the dark theme, white on the light one: colors close to the panel get a contrast edge, others do not.
    const NEAR = { 1: { type: 'PLA', brand: '', color: '#282a36' }, 2: { type: 'PLA', brand: '', color: '#f8f8f2' }, 3: { type: 'PLA', brand: '', color: '#ff5555' }, 4: { type: 'PLA', brand: '', color: '#1a1a1a' } }
    const edged = (n: number) => slot(page, n).locator('.sx-swatch-ring')
    await sidebarAs(page, { mode: 'simple', printer: UNCONNECTED.id })
    const was = await page.evaluate(() => (window as unknown as { __sx: { getState(): { scheme: string; themeFollowsSystem: boolean } } }).__sx.getState())
    try {
      await sx(page, { slotSetup: NEAR, scheme: 'dark', themeFollowsSystem: false })
      await expect(page.locator('html')).toHaveAttribute('data-sx-theme', /dark/)
      await expect(edged(1)).toHaveAttribute('data-edge', 'true')
      await expect(edged(4)).toHaveAttribute('data-edge', 'true')
      await expect(edged(2)).not.toHaveAttribute('data-edge', /./)
      await expect(edged(3)).not.toHaveAttribute('data-edge', /./)
      await sx(page, { scheme: 'light' })
      await expect(page.locator('html')).toHaveAttribute('data-sx-theme', /light/)
      await expect(edged(2)).toHaveAttribute('data-edge', 'true')
      await expect(edged(1)).not.toHaveAttribute('data-edge', /./)
      await expect(edged(3)).not.toHaveAttribute('data-edge', /./)
    } finally {
      await sx(page, { slotSetup: {}, scheme: was.scheme, themeFollowsSystem: was.themeFollowsSystem })
      await sidebarDone(page)
    }
  })
})

// ---- the selection -------------------------------------------------------------------------------------------

test.describe('the selection', () => {
  const bar = (page: Page) => page.getByTestId('slice-selection-bar')
  const select = (page: Page, i: number, modifiers: ('Shift' | 'ControlOrMeta')[] = []) => rows(page).nth(i).getByTestId('object-select').click({ modifiers })

  /** Three objects on the plate, the first one selected. */
  async function three(page: Page): Promise<void> {
    await select(page, 0)
    await page.keyboard.press('ControlOrMeta+d')
    await expect(rows(page)).toHaveCount(2)
    await select(page, 0)
    await page.keyboard.press('ControlOrMeta+d')
    await expect(rows(page)).toHaveCount(3)
  }

  test('copies of one object draw its one geometry, and removing a copy keeps the others drawn', async ({ page }) => {
    // The plate's own geometry, read from the objects the view draws. The renderer's geometry count also takes in the
    // bed, the toolhead and the render passes, which a busy machine draws for the first time at any point of the test.
    type Geo = { uuid: string; addEventListener(type: 'dispose', cb: () => void): void }
    type Node = { geometry?: Geo; userData: { objectId?: string }; traverse(cb: (o: Node) => void): void }
    type Vp = { drawnObjects(): string[]; stats(): { refiningParts: number }; stage: { objectsRoot: Node } }
    type Win = { __vp: Vp; __gone?: string[] }
    const plate = () =>
      page.evaluate(() => {
        const vp = (window as unknown as Win).__vp
        const byObject = new Map<string, Set<string>>()
        vp.stage.objectsRoot.traverse((o) => {
          const id = o.userData.objectId
          if (!o.geometry || !id) return
          if (!byObject.has(id)) byObject.set(id, new Set())
          byObject.get(id)!.add(o.geometry.uuid)
        })
        const all = new Set([...byObject.values()].flatMap((g) => [...g]))
        return { ids: vp.drawnObjects().length, refining: vp.stats().refiningParts, objects: byObject.size, geometries: all.size, perObject: [...byObject.values()].map((g) => [...g].sort().join()) }
      })
    await sidebarAs(page, { mode: 'simple' })
    await expect.poll(async () => (await plate()).refining).toBe(0)
    const one = await plate()
    expect(one.objects).toBe(1)
    await three(page)
    await expect.poll(async () => { const p = await plate(); return [p.objects, p.refining] }).toEqual([3, 0])
    const copies = await plate()
    // two copies add no geometry: all three draw the source's mesh and edges in their own places
    expect(copies.geometries).toBe(one.geometries)
    expect(new Set(copies.perObject).size).toBe(1)
    // Removing a copy frees nothing the others draw.
    await page.evaluate(() => {
      const w = window as unknown as Win
      w.__gone = []
      w.__vp.stage.objectsRoot.traverse((o) => {
        const g = o.geometry
        if (g) g.addEventListener('dispose', () => w.__gone!.push(g.uuid))
      })
    })
    await select(page, 1)
    await page.keyboard.press('Delete')
    await expect(rows(page)).toHaveCount(2)
    await expect.poll(async () => (await plate()).objects).toBe(2)
    const after = await plate()
    expect(after.ids).toBe(one.ids + 1)
    expect(after.perObject).toEqual(copies.perObject.slice(0, 2))
    expect(await page.evaluate(() => (window as unknown as Win).__gone)).toEqual([])
  })

  test('Shift selects a range, Mod toggles, and Esc clears the selection and hides the bar', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await three(page)
    await select(page, 0)
    await expect(page.getByTestId('slice-selection-count')).toHaveText('1 selected')
    await select(page, 2, ['Shift'])
    await expect(page.getByTestId('slice-selection-count')).toHaveText('3 selected')
    await select(page, 1, ['ControlOrMeta'])
    await expect(page.getByTestId('slice-selection-count')).toHaveText('2 selected')
    // A range starts from the last plain or Mod click.
    await select(page, 0, ['Shift'])
    await expect(page.getByTestId('slice-selection-count')).toHaveText('2 selected')
    expect((await state(page)).selectedIds).toHaveLength(2)
    await page.mouse.move(5, 5)
    await page.keyboard.press('Escape')
    await expect(bar(page)).toHaveCount(0)
    expect((await state(page)).selection).toBeNull()
    // Simple's Actions menu does the same.
    await select(page, 1)
    await page.getByTestId('slice-selection-more').click()
    await page.getByTestId('slice-ctx-clear').click()
    await expect(bar(page)).toHaveCount(0)
    await sidebarDone(page)
  })

  test('Simple keeps the bar to its count and its menu, with every verb and Clear selection in the menu', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await select(page, 0)
    await expect(bar(page).getByRole('button')).toHaveCount(1)
    await page.getByTestId('slice-selection-more').click()
    const menu = page.getByTestId('slice-selection-menu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Skip', 'Lock', 'Arrange', 'Transform', 'Center', 'Drop to bed', /^Duplicate/, 'Volumes', /^Clear selection/, /^Delete/])
    await menu.getByTestId('slice-ctx-skip').click()
    expect((await state(page)).plate[0]!.printable).toBe(false)
    // The object's volumes, Simple's More for it.
    await page.getByTestId('slice-selection-more').click()
    await menu.getByTestId('slice-ctx-more').click()
    await page.getByTestId('slice-selection-more').click()
    await expect(menu.getByTestId('slice-ctx-more')).toHaveText('Hide volumes')
    await sidebarDone(page)
  })

  test('the bar skips, locks and deletes the selection, and Undo in the toast brings it back', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await select(page, 0)
    await expect(bar(page)).toBeVisible()
    // One plate: no Move to plate.
    await expect(page.getByTestId('slice-selection-move-plate')).toHaveCount(0)
    const skip = page.getByTestId('slice-selection-skip')
    await expect(skip).toHaveAttribute('aria-label', 'Skip')
    await skip.click()
    await expect(skip).toHaveAttribute('aria-label', 'Print')
    expect((await state(page)).plate[0]!.printable).toBe(false)
    await skip.click()
    await expect(skip).toHaveAttribute('aria-label', 'Skip')
    const lock = page.getByTestId('slice-selection-lock')
    await lock.click()
    await expect(lock).toHaveAttribute('aria-label', 'Unlock')
    expect((await state(page)).plate[0]!.locked).toBe(true)
    await lock.click()
    await expect(lock).toHaveAttribute('aria-label', 'Lock')
    // Advanced has Arrange and Transform on the bar; the menu holds the rest, with Delete last.
    await page.getByTestId('slice-selection-more').click()
    const menu = page.getByTestId('slice-selection-menu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Center', 'Drop to bed', /^Duplicate/, /^Delete/])
    await menu.getByTestId('danger-slice-ctx-delete').click()
    await expect(rows(page)).toHaveCount(0)
    const toast = page.locator('.sx-toast', { hasText: 'Deleted Layered X.' })
    await expect(toast).toBeVisible()
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(rows(page)).toHaveCount(1)
    await sidebarDone(page)
  })

  test('Advanced shows Arrange and Transform on the bar, and Transform opens the number rows in a popover', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const right = page.locator('aside.pane[data-side="right"]')
    try {
      await select(page, 0)
      await expect(page.getByTestId('slice-selection-arrange')).toBeVisible()
      // With two plates, Move to plate joins the bar too: the count and the buttons share the row without overlapping.
      await addPlateFromPicker(page)
      await pickPlate(page, 1)
      await select(page, 0)
      await expect(page.getByTestId('slice-selection-move-plate')).toBeVisible()
      const count = (await page.getByTestId('slice-selection-count').locator('xpath=..').boundingBox())!
      const actions = (await bar(page).locator('.sx-selbar-actions').boundingBox())!
      expect(count.x + count.width).toBeLessThanOrEqual(actions.x + 0.5)
      // a narrow pane keeps the number and every button, the buttons under it when they don't fit beside it
      await right.evaluate((el) => Object.assign((el as HTMLElement).style, { width: '230px', flexBasis: '230px' }))
      const c2 = (await page.getByTestId('slice-selection-count').boundingBox())!
      const a2 = (await bar(page).locator('.sx-selbar-actions').boundingBox())!
      expect(c2.x + c2.width).toBeLessThanOrEqual(a2.x + 0.5)
      // and every button, Clear included, stays inside the bar
      const b2 = (await bar(page).boundingBox())!
      expect(a2.x + a2.width).toBeLessThanOrEqual(b2.x + b2.width + 0.5)
      await expect(page.getByTestId('slice-selection-clear')).toBeVisible()
      expect((await page.getByTestId('slice-selection-count').boundingBox())!.width).toBeLessThan(24)
      await right.evaluate((el) => Object.assign((el as HTMLElement).style, { width: '', flexBasis: '' }))
      // The number rows live in the popover now, not under the list.
      await expect(page.locator('[data-section="objects"] [data-section="transform"]')).toHaveCount(0)
      // Opening it moves nothing in the pane: its first field takes focus without scrolling the pane.
      const card = page.locator('[data-section="objects"]')
      const before = (await card.boundingBox())!.y
      await openTransform(page)
      const pop = page.locator('.selbar-transform')
      await expect(pop.locator(':focus')).toHaveCount(1)
      expect(Math.abs((await card.boundingBox())!.y - before)).toBeLessThanOrEqual(0.5)
      await expect(pop.getByRole('group', { name: 'Position' })).toBeVisible()
      await expect(pop.getByRole('group', { name: 'Size' })).toBeVisible()
      // A size below the least says why it was turned down, then the field goes back.
      const sizeX = pop.getByRole('group', { name: 'Size' }).getByRole('textbox').first()
      const was = await sizeX.inputValue()
      await sizeX.fill('-5')
      await sizeX.press('Enter')
      await expect(pop.locator('.sx-scrub-refused')).toHaveText('0.01 mm or more')
      await expect(sizeX).toHaveValue(was)
      await page.keyboard.press('Escape')
      await expect(pop).toHaveCount(0)
      // Esc closed the popover, not the selection.
      await expect(bar(page)).toBeVisible()
    } finally {
      await right.evaluate((el) => Object.assign((el as HTMLElement).style, { width: '', flexBasis: '' }))
      await sidebarDone(page)
    }
  })

  test('a row\'s context menu opens by keyboard, selects the row first, and has the bar\'s items', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await three(page)
    await select(page, 0)
    await rows(page).nth(2).getByTestId('object-select').focus()
    await page.keyboard.press('Shift+F10')
    const ctx = page.getByTestId('slice-ctx')
    await expect(ctx).toBeVisible()
    expect((await state(page)).selection).toBe(await rows(page).nth(2).getAttribute('data-object-id'))
    // The object's own verbs follow Duplicate, and Delete stays last; Merge waits for a second object, and Split for a second piece (the example model has two).
    await expect(ctx.getByRole('menuitem')).toHaveText(['Arrange', 'Transform', 'Skip', 'Lock', 'Center', 'Drop to bed', /^Duplicate/, /^Rename/, 'Object settings', 'Split to objects', 'Along X', 'Along Y', 'Along Z', /^Delete/])
    await ctx.getByTestId('slice-ctx-duplicate').click()
    await expect(rows(page)).toHaveCount(4)
    await sidebarDone(page)
  })

  test('a right click on an object in the view opens the same menu there', async ({ page }) => {
    await sidebarAs(page, { mode: 'simple' })
    await select(page, 0)
    // Frame the object so the middle of the view is on it.
    await page.mouse.move(700, 450)
    await page.keyboard.press('z')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { stats(): { cameraMoving: boolean } } }).__vp.stats().cameraMoving)).toBe(false)
    const box = (await page.locator('.vp-canvas').first().boundingBox())!
    await pressable(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    const ctx = page.getByTestId('slice-ctx')
    await expect(ctx).toBeVisible()
    await ctx.getByTestId('slice-ctx-skip').click()
    expect((await state(page)).plate[0]!.printable).toBe(false)
    await sidebarDone(page)
  })
})

// ---- the plate tools and object edits (moved from plate.spec.ts) ---------------------------------------------

// The sync-file test below takes the file dialogs it opens; a page listens for them from before its first load.
test.beforeAll(({ app }) => {
  interceptFileDialogs(app)
})

const posX = (page: Page) => page.getByRole('group', { name: 'Position' }).getByRole('textbox', { name: /X/ })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Plate tools' })

test.describe('the plate tools', () => {
  test('numeric fields move and scale the object, and undo puts it back', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await openTransform(page)
    await expect(posX(page)).toBeVisible()
    const before = await posX(page).inputValue()
    await posX(page).fill('100')
    await posX(page).press('Enter')
    await expect(posX(page)).toHaveValue('100')

    const sizeX = page.getByRole('group', { name: 'Size' }).getByRole('textbox', { name: /X/ })
    const sizeY = page.getByRole('group', { name: 'Size' }).getByRole('textbox', { name: /Y/ })
    const y0 = Number(await sizeY.inputValue())
    const x0 = Number(await sizeX.inputValue())
    await sizeX.fill(String(Math.round(x0 * 2)))
    await sizeX.press('Enter')
    // Uniform scale doubles every axis.
    await expect.poll(async () => Math.round(Number(await sizeY.inputValue()) / y0)).toBe(2)
    await expect(page.getByRole('group', { name: 'Scale' }).getByRole('textbox', { name: /X/ })).toHaveValue('200')

    await page.locator('.vp').click({ position: { x: 5, y: 200 } })
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.getByRole('button', { name: 'Undo' }).click()
    await openTransform(page)
    await expect(posX(page)).toHaveValue(before)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Redo' }).click()
    await openTransform(page)
    await expect(posX(page)).toHaveValue('100')
    await sidebarDone(page)
  })

  test('tool keys follow the look and feel keymap', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await expect(toolbar(page)).toBeVisible()
    await page.locator('body').press('r')
    await expect(toolbar(page).getByRole('button', { name: 'Rotate' })).toHaveAttribute('aria-pressed', 'true')
    await page.locator('body').press('f')
    await expect(toolbar(page).getByRole('button', { name: 'Lay on face' })).toHaveAttribute('aria-pressed', 'true')
    await page.locator('body').press('m')
    await expect(toolbar(page).getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true')
    // Keyboard undo works from the canvas too.
    await openTransform(page)
    const before = await posX(page).inputValue()
    await posX(page).fill('90')
    await posX(page).press('Enter')
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('ControlOrMeta+z')
    await openTransform(page)
    await expect(posX(page)).toHaveValue(before)
    await sidebarDone(page)
  })

  test('instances, fill bed and arrange, each one undo step', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const objs = page.locator('.objs > li')
    await expect(objs).toHaveCount(1)
    await openTransform(page)
    await page.getByRole('button', { name: 'Add an instance' }).click()
    await expect(objs).toHaveCount(2)
    await expect(page.locator('.obj-meta', { hasText: 'Instance of Layered X' })).toHaveCount(1)
    await expect(page.getByRole('textbox', { name: 'Number of instances' })).toHaveValue('2')
    await page.getByRole('button', { name: 'Fill bed' }).click()
    await expect.poll(() => objs.count()).toBeGreaterThan(2)
    const filled = await objs.count()
    await toolbar(page).getByRole('button', { name: 'Arrange all' }).click()
    // Arrange runs in the background; an undo before it lands would undo the fill instead.
    await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
    await expect(objs).toHaveCount(filled)
    const undo = toolbar(page).getByRole('button', { name: 'Undo' })
    await undo.click()
    await undo.click()
    await expect(objs).toHaveCount(2)
    await undo.click()
    await expect(objs).toHaveCount(1)
    await sidebarDone(page)
  })

  test('copy and paste with the keys adds a copy beside the object, and undo takes it away', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const names = page.locator('.obj-name', { hasText: 'Layered X' })
    await expect(names).toHaveCount(1)
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    await page.keyboard.press('ControlOrMeta+c')
    await page.keyboard.press('ControlOrMeta+v')
    await expect(names).toHaveCount(2)
    await page.keyboard.press('ControlOrMeta+v')
    await expect(names).toHaveCount(3)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(names).toHaveCount(2)
    // Duplicate is on Mod+D in the SlicerX look.
    await page.keyboard.press('ControlOrMeta+d')
    await expect(names).toHaveCount(3)
    await sidebarDone(page)
  })

  test('add shapes, merge them, and split them back', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const objs = page.locator('.objs > li')
    const addShape = async (name: string) => {
      await addMenu(page, 'Add shape')
      await page.getByRole('menu', { name: 'Add shape' }).getByRole('menuitem', { name }).first().click()
    }
    await addShape('Box')
    await expect(objs).toHaveCount(2)
    await addShape('Cylinder')
    await expect(objs).toHaveCount(3)
    // Select the box too, then merge the two shapes.
    await page.locator('.obj-name', { hasText: 'Box' }).click({ modifiers: ['ControlOrMeta'] })
    await addMenu(page, 'Object')
    await page.getByRole('menuitem', { name: 'Merge selected objects' }).click()
    await expect(objs).toHaveCount(2)
    await addMenu(page, 'Object')
    await page.getByRole('menuitem', { name: 'Split to objects' }).click()
    await expect(objs).toHaveCount(3)
    await sidebarDone(page)
  })

  test('geometry tools run in the browser: cut in two, then repair', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const objs = page.locator('.objs > li')
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    await addMenu(page, 'Tools')
    await page.getByRole('menuitem', { name: 'Cut' }).click()
    // The cut panel sits in the sidebar next to the plane in the view; its fields and the gizmo share the plane.
    const panel = page.locator('[data-section="cut-tool"]')
    await expect(panel).toBeVisible()
    const offset = panel.getByLabel('Distance from the center, millimeters')
    await offset.fill('1')
    await offset.blur()
    await expect(offset).toHaveValue('1')
    await panel.getByRole('button', { name: 'Cut', exact: true }).click()
    await expect(panel).toBeHidden({ timeout: 30_000 })
    await expect(objs).toHaveCount(2)
    await expect(page.locator('.obj-name', { hasText: 'lower' })).toBeVisible()
    await addMenu(page, 'Tools')
    await page.getByRole('menuitem', { name: 'Repair mesh' }).click()
    await expect(page.locator('.sx-toast, [role=status]').filter({ hasText: /Repaired|already clean/ }).first()).toBeVisible({ timeout: 30_000 })
    await sidebarDone(page)
  })

  test('a cut plane on the top face keeping the lower side says it does not cross, and keeps the object', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const objs = page.locator('.objs > li')
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    await addMenu(page, 'Tools')
    await page.getByRole('menuitem', { name: 'Cut' }).click()
    const panel = page.locator('[data-section="cut-tool"]')
    await expect(panel).toBeVisible()
    // the offset stops at the object's top face
    const offset = panel.getByLabel('Distance from the center, millimeters')
    await offset.fill('1000')
    await offset.blur()
    await panel.getByRole('radiogroup', { name: 'Keep' }).getByRole('radio', { name: 'Lower' }).click()
    await panel.getByRole('button', { name: 'Cut', exact: true }).click()
    await expect(page.locator('.sx-toast, [role=status]').filter({ hasText: 'The plane does not cross the object' }).first()).toBeVisible({ timeout: 30_000 })
    await expect(panel).toBeVisible()
    // the objects card comes back once the tool closes: the one object, not a lower piece
    await panel.getByRole('button', { name: 'Cancel' }).click()
    await expect(panel).toBeHidden()
    await expect(objs).toHaveCount(1)
    await expect(page.locator('.obj-name', { hasText: 'lower' })).toHaveCount(0)
    await sidebarDone(page)
  })

  test('the paint tool paints the object with a filament color, and undo takes it back', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    // Select the model first: the Paint panel takes the Objects card's place.
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    await page.getByRole('button', { name: 'Paint', exact: true }).click()
    const panel = page.locator('[data-section="paint"]')
    await expect(panel).toBeVisible()
    await panel.getByRole('radio', { name: /Filament 2/ }).click()
    // The panel shows the brush's state, not a stale one.
    await expect(panel.getByRole('radio', { name: /Filament 2/ })).toHaveAttribute('aria-checked', 'true')
    // The view opens on the whole plate: the iso view (7) brings the model to the middle before painting it. With motion
    // reduced that is a jump, and the stroke waits until the camera is still. The wait watches a point above the model's
    // middle, since a zoom toward the middle keeps the middle itself still on screen. The stroke starts on the model (a
    // press beside it turns the view), at the middle where the X's arms cross, and runs up the crossing.
    await reducedMotion(page, async () => {
      await page.keyboard.press('7')
      const [mx, my, mz] = await layeredMid(page)
      const end = await steady(page, mx, my, mz + 4)
      const start = await pressable(page, await screenOf(page, mx, my, mz))
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 12 })
      await page.mouse.up()
      // The drag was the brush's: the view did not turn.
      const after = await screenOf(page, mx, my, mz + 4)
      expect(Math.hypot(after.x - end.x, after.y - end.y)).toBeLessThan(0.5)
    })
    const clear = panel.getByRole('button', { name: /Clear color/ })
    await expect(clear).toBeEnabled()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(clear).toBeDisabled()
    await page.getByRole('button', { name: 'Redo' }).click()
    await expect(clear).toBeEnabled()
    // The tool holds the Objects card's place until it is left; the next test finds the list.
    await page.getByTestId('slice-tool-done').click()
    await expect(panel).toHaveCount(0)
    await sidebarDone(page)
  })

  test('a paint click that misses the model keeps the object it paints', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    await page.getByRole('button', { name: 'Paint', exact: true }).click()
    const panel = page.locator('[data-section="paint"]')
    await expect(panel).toContainText('Layered X')
    const selection = async () => (await state(page)).selection
    const before = await selection()
    expect(before).not.toBeNull()
    // The event the view sends for a click that hits no object: beside the model, between its arms, or on the bed.
    const miss = () => page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('pick', { objectId: null, partIndex: null, point: null, triangle: null, bed: [5, 5] }))
    await miss()
    expect(await selection()).toBe(before)
    await expect(panel).toContainText('Layered X')
    await expect(panel).not.toContainText('Select an object')
    // Out of the paint tool, the same click clears the selection as before.
    await page.getByTestId('slice-tool-done').click()
    await expect(panel).toHaveCount(0)
    await miss()
    await expect.poll(selection).toBeNull()
    await sidebarDone(page)
  })
})

test.describe('the object list and what an object holds', () => {
  test('object settings: in the scope of the selection the object gets a value of its own, and undo takes it back', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await page.locator('.obj-name', { hasText: 'Layered X' }).click()
    await page.getByTestId('slice-scope-object').click()
    await expect(page.locator('[data-section="settings"]')).toHaveAttribute('data-scope', 'objects')
    // Supports on for this object only: its row gets the badge for a setting of its own.
    await page.getByRole('radiogroup', { name: 'Supports' }).getByRole('radio', { name: 'Auto' }).click()
    const badge = page.getByTestId('slice-object-override-badge')
    await expect(badge).toBeVisible()
    await toolbar(page).getByRole('button', { name: 'Undo' }).click()
    await expect(badge).toHaveCount(0)
    await sidebarDone(page)
  })

  test('a negative volume is added under the object and removed', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const volumes = page.locator('[data-section="volumes"]')
    await volumes.getByRole('button', { name: 'Add' }).click()
    await expect(volumes.getByRole('button', { name: 'Negative volume 1', exact: true })).toBeVisible()
    // A new volume opens its fields.
    await expect(volumes.getByRole('group', { name: 'Volume size' })).toBeVisible()
    await volumes.getByRole('button', { name: 'Remove Negative volume 1' }).click()
    await expect(volumes.getByRole('button', { name: 'Negative volume 1', exact: true })).toHaveCount(0)
    await sidebarDone(page)
  })

  test('a modifier volume takes its own settings', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const volumes = page.locator('[data-section="volumes"]')
    await volumes.getByLabel('Volume type').selectOption('modifier')
    await volumes.getByRole('button', { name: 'Add' }).click()
    await expect(volumes.getByRole('button', { name: 'Modifier 1', exact: true })).toBeVisible()
    const mod = volumes.locator('[data-section="modifier-settings"]')
    await mod.getByRole('button', { name: 'Add setting' }).click()
    await mod.getByLabel('Find a setting for the modifier').fill('infill density')
    await mod.getByRole('list', { name: 'Settings you can add' }).getByRole('button').first().click()
    await expect(mod.locator('li.field')).toHaveCount(1)
    await sidebarDone(page)
  })

  test('the object list renames an object, sets a part filament, and leaves an object out of the print', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    const row = page.locator('li.obj').first()
    await renameRow(row, 'Layered bracket')
    await expect(page.locator('.obj-name', { hasText: 'Layered bracket' })).toBeVisible()
    await setPartFilament(page, row, 3)
    await expect(page.locator('[data-testid="slice-filament-slot"][data-slot="3"]')).toHaveAttribute('data-used', 'true')
    // Lock and print show on the row's hover.
    await row.locator('.obj-row').first().hover()
    await row.getByRole('button', { name: /^Do not print Layered bracket/ }).click()
    await expect(row).toHaveClass(/off/)
    // The Slice action and Undo are on the view.
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(page.getByText(/set not to print/)).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(row).not.toHaveClass(/off/)
    await sidebarDone(page)
  })

  test('the object list reorders by drag and by buttons, and a locked object stays put', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await page.locator('li.obj').first().locator('.obj-h').click()
    await page.keyboard.press('ControlOrMeta+d')
    const list = page.locator('li.obj')
    await expect(list).toHaveCount(2)
    await renameRow(list.nth(0), 'First')
    await renameRow(list.nth(1), 'Second')
    await expect(list.nth(0).locator('.obj-name')).toHaveText('First')
    // Buttons, in the row's tree.
    await list.nth(1).getByTestId('slice-object-expand').click()
    await list.nth(1).getByRole('button', { name: 'Move Second up' }).click()
    await expect(list.nth(0).locator('.obj-name')).toHaveText('Second')
    // Drag: the row at the bottom onto the top one.
    await list.nth(1).dragTo(list.nth(0))
    await expect(list.nth(0).locator('.obj-name')).toHaveText('First')
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(list.nth(0).locator('.obj-name')).toHaveText('Second')
    // Lock: the numeric position will not change. The row's buttons show on hover.
    await list.nth(0).locator('.obj-row').first().hover()
    await list.nth(0).getByRole('button', { name: 'Lock Second' }).click()
    // off the lock button, so its Locked tip closes before the name is pressed
    await page.mouse.move(0, 0)
    await expect(page.locator('#sx-tip')).toBeHidden()
    await list.nth(0).locator('.obj-h').click()
    await openTransform(page)
    const before = await posX(page).inputValue()
    await posX(page).fill('30')
    await posX(page).press('Enter')
    await expect(page.getByText(/Second is locked/)).toBeVisible()
    await expect(posX(page)).toHaveValue(before)
    await page.keyboard.press('Escape')
    await list.nth(0).getByRole('button', { name: 'Unlock Second' }).click()
    await openTransform(page)
    await posX(page).fill('30')
    await posX(page).press('Enter')
    await expect(posX(page)).toHaveValue('30')
    await sidebarDone(page)
  })

  test('the filament slot editor sets a slot and the panel shows it', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    try {
      // A click moves the plate to a spool; what a slot holds is edited from its menu.
      await page.locator('[data-testid="slice-filament-slot"][data-slot="1"]').focus()
      await page.keyboard.press('Shift+F10')
      await page.getByTestId('slice-filament-edit').click()
      const dialog = page.getByRole('dialog', { name: /Filament 1/ })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel('Material').selectOption('PETG')
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByTestId('slice-filament-slot-line')).toContainText('PETG')
    } finally {
      await setState(page, { slotSetup: {} })
      await sidebarDone(page)
    }
  })
})

test.describe('settings dialogs', () => {
  const settings = async (page: Page, section: string) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section }).click()
  }
  // The Settings dialog is a native dialog that dismiss() does not see, and it covers the page for the next test.
  const shut = async (page: Page) => {
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog.settings-dialog[open]')).toHaveCount(0)
  }

  test('a process preset is saved in Settings, stays after a reload and can be deleted', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await settings(page, 'Presets')
    const group = page.getByRole('region', { name: 'Process presets' })
    await group.getByLabel('Name for a new process preset').fill('My fast print')
    await group.getByRole('button', { name: 'Save' }).click()
    await expect(group.getByText('My fast print')).toBeVisible()
    await page.reload()
    await plateReady(page)
    await settings(page, 'Presets')
    await expect(page.getByRole('region', { name: 'Process presets' }).getByText('My fast print')).toBeVisible()
    await page.getByRole('button', { name: 'Delete My fast print' }).click()
    await expect(page.getByText('My fast print')).toHaveCount(0)
    await shut(page)
    await sidebarDone(page)
  })

  test('printer settings open in Orca style tabs and keep a change', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    try {
      await page.getByTestId('slice-machine-printer').click()
      await page.getByTestId('slice-machine-printer-settings').click()
      const dialog = page.getByRole('dialog', { name: /Printer settings/ })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('radio', { name: 'Extruder and retraction' }).click()
      const field = dialog.getByLabel(/^Retraction length/).first()
      await field.fill('1.4')
      await field.press('Enter')
      await expect(dialog.getByText('1 changed')).toBeVisible()
      await expect(dialog.getByText(/Machine G-code is set by the profile/)).toBeVisible()
    } finally {
      await setState(page, { overrides: {}, printerSettingsOpen: false })
      await expect(page.getByRole('dialog', { name: /Printer settings/ })).toHaveCount(0)
      await sidebarDone(page)
    }
  })

  test('Settings > Controls changes a shortcut, uses it, and puts it back', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await settings(page, 'Controls')
    const row = page.getByRole('group', { name: `${await tabName(page, 'prepare')} shortcuts` })
    await row.getByRole('button', { name: 'Change the key for Rotate tool' }).click()
    await page.keyboard.press('j')
    await expect(row.getByLabel('Rotate tool: J')).toBeVisible()
    // Search finds it by key.
    await page.getByLabel('Search shortcuts').fill('rotate')
    await expect(row.getByText('Rotate tool')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.locator('body').press('j')
    await expect(toolbar(page).getByRole('button', { name: 'Rotate' })).toHaveAttribute('aria-pressed', 'true')
    await settings(page, 'Controls')
    await page.getByRole('button', { name: 'Put the key for Rotate tool back' }).click()
    await expect(page.getByLabel('Rotate tool: R')).toBeVisible()
    await shut(page)
    await sidebarDone(page)
  })

  test('presets sync through a file you keep: save one, merge another, and read the change notes', async ({ page }) => {
    await sidebarAs(page, { mode: 'advanced' })
    await page.evaluate(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker')
      Reflect.deleteProperty(window, 'showOpenFilePicker')
    })
    const { readFileSync } = await import('node:fs')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Presets' }).click()
    await page.getByLabel('Name for a new process preset').fill('Fast draft')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sync file' }).click()])
    const saved = JSON.parse(readFileSync(await download.path(), 'utf8')) as { format: string; presets: { name: string }[] }
    expect(saved.format).toBe('slicerx-presets')
    expect(saved.presets.map((p) => p.name)).toContain('Fast draft')
    const remote = { format: 'slicerx-presets', version: 1, exportedAt: Date.now(), presets: [{ id: 'remote-1', kind: 'filament', name: 'Remote PLA', values: { nozzle_temperature: 215 }, createdAt: 1, updatedAt: Date.now() }], deleted: [], changes: [] }
    const chooser = await expectFileDialog(page, () => page.getByRole('button', { name: 'Merge a sync file' }).click())
    await chooser.setFiles({ name: 'other.sync.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(remote)) })
    await expect(page.getByRole('status').filter({ hasText: 'Added Remote PLA' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Filament presets' })).toContainText('Remote PLA')
    await page.getByText(/Change notes/).click()
    await expect(page.getByText('Added Remote PLA (filament).').last()).toBeVisible()
    // Both presets are in this page's saved presets: take them out so the next test finds none.
    await shut(page)
    await setState(page, { userPresets: [] })
    await sidebarDone(page)
  })
})
