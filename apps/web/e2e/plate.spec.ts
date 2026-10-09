// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate tools on the plate tab: numeric transform fields, scale to size, undo and redo, tool keys.
import { type Page } from '@playwright/test'
import { closeSheet, expect, openSheet, plateReady, sliceCount, sliced, tab, tabName, test } from './fixtures'

/**
 * The G-code the printer runs. Files for Bambu Lab printers open with the header and the full settings (hundreds
 * of lines, the start G-code among them as one escaped line) and the moves follow EXECUTABLE_BLOCK_START, as Orca
 * and Bambu Studio write them; other files start with the moves.
 */
function executable(text: string): string {
  const at = text.indexOf('; EXECUTABLE_BLOCK_START')
  return at < 0 ? text : text.slice(at)
}

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true }))
  })
  await page.goto('./')
  await plateReady(page)
}

test('numeric fields move and scale the object, and undo puts it back', async ({ page }) => {
  await prepare(page)
  // On a phone the object's fields are in the sidebar's sheet.
  await openSheet(page)
  const posX = page.getByRole('group', { name: 'Position' }).getByRole('textbox', { name: /X/ })
  await expect(posX).toBeVisible()
  const before = await posX.inputValue()
  await posX.fill('100')
  await posX.press('Enter')
  await expect(posX).toHaveValue('100')

  const sizeX = page.getByRole('group', { name: 'Size' }).getByRole('textbox', { name: /X/ })
  const sizeY = page.getByRole('group', { name: 'Size' }).getByRole('textbox', { name: /Y/ })
  const y0 = Number(await sizeY.inputValue())
  const x0 = Number(await sizeX.inputValue())
  await sizeX.fill(String(Math.round(x0 * 2)))
  await sizeX.press('Enter')
  // Uniform scale doubles every axis.
  await expect.poll(async () => Math.round(Number(await sizeY.inputValue()) / y0)).toBe(2)
  await expect(page.getByRole('group', { name: 'Scale' }).getByRole('textbox', { name: /X/ })).toHaveValue('200')

  await closeSheet(page)
  await page.locator('.vp').click({ position: { x: 5, y: 200 } })
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(posX).toHaveValue(before)
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(posX).toHaveValue('100')
})

test('tool keys follow the look and feel keymap', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Tool keys need a keyboard')
  await prepare(page)
  const toolbar = page.getByRole('toolbar', { name: 'Plate tools' })
  await expect(toolbar).toBeVisible()
  await page.locator('body').press('r')
  await expect(toolbar.getByRole('button', { name: 'Rotate' })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('body').press('f')
  await expect(toolbar.getByRole('button', { name: 'Lay on face' })).toHaveAttribute('aria-pressed', 'true')
  await page.locator('body').press('m')
  await expect(toolbar.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true')
  // Keyboard undo works from the canvas too.
  const posX = page.getByRole('group', { name: 'Position' }).getByRole('textbox', { name: /X/ })
  const before = await posX.inputValue()
  await posX.fill('90')
  await posX.press('Enter')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('ControlOrMeta+z')
  await expect(posX).toHaveValue(before)
})

test('instances, fill bed and arrange, each one undo step', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  const objs = page.locator('.objs > li')
  await expect(objs).toHaveCount(1)
  await page.getByRole('button', { name: 'Add an instance' }).click()
  await expect(objs).toHaveCount(2)
  await expect(page.locator('.obj-meta', { hasText: 'Instance of Layered X' })).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Number of instances' })).toHaveValue('2')
  await page.getByRole('button', { name: 'Fill bed' }).click()
  await expect.poll(() => objs.count()).toBeGreaterThan(2)
  const filled = await objs.count()
  await closeSheet(page)
  await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Arrange all' }).click()
  // Arrange runs in the background; an undo before it lands would undo the fill instead.
  await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
  await expect(objs).toHaveCount(filled)
  const undo = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Undo' })
  await undo.click()
  await undo.click()
  await expect(objs).toHaveCount(2)
  await undo.click()
  await expect(objs).toHaveCount(1)
})

test('plates: add, switch, per-plate sequence, move objects', async ({ page }) => {
  await prepare(page)
  const objs = page.locator('.objs > li')
  await page.getByRole('button', { name: 'Add plate' }).first().click()
  const plates = page.getByRole('list', { name: 'Plates' })
  await expect(plates.locator('.plate-card')).toHaveCount(2)
  await expect(objs).toHaveCount(0)
  await plates.locator('.plate-card', { hasText: 'Plate 1' }).click()
  await expect(objs).toHaveCount(1)
  await page.getByRole('button', { name: 'Plate 2 settings' }).click()
  await page.getByRole('group', { name: 'Plate 2 settings' }).getByLabel('Print sequence').selectOption('by-object')
  await page.getByRole('button', { name: 'Done' }).click()
  await openSheet(page)
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  // Move to plate is on the selected object's bar over the view.
  await closeSheet(page)
  await page.getByRole('button', { name: 'Move to plate' }).click()
  await page.getByRole('menuitem', { name: 'Plate 2' }).click()
  await expect(objs).toHaveCount(0)
  await plates.locator('.plate-card', { hasText: 'Plate 2' }).click()
  await expect(objs).toHaveCount(1)
})

/** Set a plate's type in its plate settings, then close them. */
async function setBedType(page: Page, plate: string, value: string): Promise<void> {
  await page.getByRole('button', { name: `${plate} settings` }).click()
  await page.getByRole('group', { name: `${plate} settings` }).getByLabel('Bed type').selectOption(value)
  await page.getByRole('button', { name: 'Done' }).click()
}

test('the printer card shows each plate\'s bed type', async ({ page }) => {
  await prepare(page)
  const card = page.locator('[data-section="printer"]')
  const plateType = page.getByTestId('slice-machine-plate')
  // Plate 1 prints on the printer's default; the card names it and never reads "unknown".
  await expect(plateType).toHaveText(/\S/)
  const first = (await plateType.textContent()) ?? ''
  expect(['Textured PEI', 'Smooth PEI', 'Cool plate', 'Engineering plate', 'High temp plate']).toContain(first)
  await expect(card).not.toContainText('unknown')
  await page.getByRole('button', { name: 'Add plate' }).first().click()
  const plates = page.getByRole('list', { name: 'Plates' })
  await setBedType(page, 'Plate 2', 'smooth-pei')
  await expect(plateType).toHaveText('Smooth PEI')
  await plates.locator('.plate-card', { hasText: 'Plate 1' }).click()
  await expect(plateType).toHaveText(first)
  await plates.locator('.plate-card', { hasText: 'Plate 2' }).click()
  await expect(plateType).toHaveText('Smooth PEI')
  // Back to the printer's default.
  await setBedType(page, 'Plate 2', '')
  await expect(plateType).toHaveText(first)
})

test('the plate box names the longest plate type in its tooltip and keeps the printer row one line', async ({ page }) => {
  await prepare(page)
  const plateType = page.getByTestId('slice-machine-plate')
  // The longest plate type in the picker, on the new plate.
  await page.getByRole('button', { name: 'Add plate' }).first().click()
  await setBedType(page, 'Plate 2', 'engineering')
  await openSheet(page)
  await expect(plateType).toHaveText('Engineering plate')
  await expect(plateType).toHaveAttribute('data-tip-title', 'Engineering plate')
  await expect(plateType).toHaveAttribute('aria-label', 'Plate: Engineering plate')
  // The box shows the type's icon, so the row keeps its height: the plate box is as tall as the printer box.
  expect(Math.abs((await plateType.boundingBox())!.height - (await page.getByTestId('slice-machine-printer').boundingBox())!.height)).toBeLessThan(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('add shapes, merge them, and split them back', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  const objs = page.locator('.objs > li')
  const addShape = async (name: string) => {
    await page.getByRole('button', { name: 'Add shape' }).click()
    await page.getByRole('menu', { name: 'Add shape' }).getByRole('menuitem', { name }).first().click()
  }
  await addShape('Box')
  await expect(objs).toHaveCount(2)
  await addShape('Cylinder')
  await expect(objs).toHaveCount(3)
  // Select the box too, then merge the two shapes.
  await page.locator('.obj-name', { hasText: 'Box' }).click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Object', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Merge selected objects' }).click()
  await expect(objs).toHaveCount(2)
  await page.getByRole('button', { name: 'Object', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Split to objects' }).click()
  await expect(objs).toHaveCount(3)
})

test('object settings: add one, undo it', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  await page.getByRole('button', { name: 'Add setting' }).click()
  await page.getByRole('textbox', { name: 'Find a setting to change for this object' }).fill('wall loops')
  await page.getByRole('list', { name: 'Settings you can add' }).getByRole('button').first().click()
  await expect(page.locator('.obj-set-list li')).toHaveCount(1)
  await closeSheet(page)
  await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Undo' }).click()
  await expect(page.locator('.obj-set-list li')).toHaveCount(0)
})

test('geometry tools run in the browser: cut in two, then repair', async ({ page }) => {
  await prepare(page)
  const objs = page.locator('.objs > li')
  // On a phone the object list, its Tools menu and the cut panel are in the sidebar's sheet.
  await openSheet(page)
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  await page.getByRole('button', { name: 'Tools' }).click()
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
  await page.getByRole('button', { name: 'Tools' }).click()
  await page.getByRole('menuitem', { name: 'Repair mesh' }).click()
  await expect(page.locator('.sx-toast, [role=status]').filter({ hasText: /Repaired|already clean/ }).first()).toBeVisible({ timeout: 30_000 })
})

test('save the project as .sx3mf with the SlicerX metadata', async ({ page }) => {
  // Headless Chromium has no save dialog; the host falls back to a download without the picker.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  await openSheet(page)
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /STL/ })).toHaveCount(0)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  expect(download.suggestedFilename()).toMatch(/\.sx3mf$/)
  const fs = await import('node:fs')
  const bytes = fs.readFileSync(await download.path())
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304')
  // Entries are deflated; read them back through their local headers.
  const { inflateRawSync } = await import('node:zlib')
  const entries = new Map<string, string>()
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
    const method = bytes.readUInt16LE(at + 8)
    const size = bytes.readUInt32LE(at + 18)
    const nameLen = bytes.readUInt16LE(at + 26)
    const start = at + 30 + nameLen + bytes.readUInt16LE(at + 28)
    const raw = bytes.subarray(start, start + size)
    entries.set(bytes.subarray(at + 30, at + 30 + nameLen).toString(), (method === 8 ? inflateRawSync(raw) : raw).toString())
    at = start + size
  }
  expect(entries.get('3D/3dmodel.model')).toContain('sx:ExportedBy')
  expect([...entries.keys()]).toContain('Metadata/model_settings.config')
})

test('sending runs the preflight and needs the bed-clear check', async ({ page }) => {
  // Slicing in the browser under a full parallel run can take a while.
  test.slow()
  await prepare(page)
  const slices1 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on')
  const item = page.locator('.sx-palette-item', { hasText: 'Print the plate on' }).first()
  await expect(item).toBeVisible()
  await item.click()
  // One sheet: what will print, the check against the printer, the printer's steps as toggles, and the confirm button as the approval.
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible()
  await expect(sheet).toContainText('Bed leveling')
  await expect(sheet.getByRole('switch', { name: 'Bed leveling' })).toHaveAttribute('aria-checked', 'true')
  await expect(sheet.getByRole('button', { name: /^Bed is clear, start/ })).toBeEnabled()
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toHaveCount(0)
})

test('the filament slot editor sets a slot and the panel shows it', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  const slot = page.locator('[data-section="filament"] .slot').first()
  await slot.getByRole('button', { name: 'Edit filament 1' }).first().click()
  const dialog = page.getByRole('dialog', { name: /Filament 1/ })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Material').selectOption('PETG')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(slot).toContainText('PETG')
})

test('a negative volume is added under the object and removed', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  const volumes = page.locator('[data-section="volumes"]')
  await volumes.getByRole('button', { name: 'Add' }).click()
  await expect(volumes.getByRole('button', { name: 'Negative volume 1', exact: true })).toBeVisible()
  // A new volume opens its fields.
  await expect(volumes.getByRole('group', { name: 'Volume size' })).toBeVisible()
  await volumes.getByRole('button', { name: 'Remove Negative volume 1' }).click()
  await expect(volumes.getByRole('button', { name: 'Negative volume 1', exact: true })).toHaveCount(0)
})

test('a process preset is saved in Settings, stays after a reload and can be deleted', async ({ page }) => {
  await prepare(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Presets' }).click()
  const group = page.getByRole('region', { name: 'Process presets' })
  await group.getByLabel('Name for a new process preset').fill('My fast print')
  await group.getByRole('button', { name: 'Save' }).click()
  await expect(group.getByText('My fast print')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Presets' }).click()
  await expect(page.getByRole('region', { name: 'Process presets' }).getByText('My fast print')).toBeVisible()
  await page.getByRole('button', { name: 'Delete My fast print' }).click()
  await expect(page.getByText('My fast print')).toHaveCount(0)
})

test('printer settings open in Orca style tabs and keep a change', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
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
})

test('the printer bridge section asks for a code and says plainly when sx-link is not running', async ({ page }) => {
  await prepare(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Printer bridge' }).click()
  const connect = page.getByRole('button', { name: 'Connect', exact: true })
  await expect(connect).toBeDisabled()
  await page.getByLabel('Pairing code').fill('abcd-2345')
  await expect(connect).toBeEnabled()
  await connect.click()
  await expect(page.getByRole('alert')).toContainText(/Cannot reach sx-link/)
})

test('Settings > Controls changes a shortcut, uses it, and puts it back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Shortcuts need a keyboard')
  await prepare(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Controls' }).click()
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
  await expect(page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Rotate' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Controls' }).click()
  await page.getByRole('button', { name: 'Put the key for Rotate tool back' }).click()
  await expect(page.getByLabel('Rotate tool: R')).toBeVisible()
})

test('the paint tool paints the object with a filament color, and undo takes it back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Painting needs a mouse')
  await prepare(page)
  await page.getByRole('button', { name: 'Paint', exact: true }).click()
  const panel = page.locator('[data-section="paint"]')
  await expect(panel).toBeVisible()
  await panel.getByRole('radio', { name: /Filament 2/ }).click()
  // The panel shows the brush's state, not a stale one.
  await expect(panel.getByRole('radio', { name: /Filament 2/ })).toHaveAttribute('aria-checked', 'true')
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  // The view opens on the whole plate: the iso view (7) brings the model to the middle before painting it.
  await page.keyboard.press('7')
  await page.waitForTimeout(600)
  const box = await page.locator('.vp-canvas').first().boundingBox()
  if (!box) throw new Error('no canvas')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 30, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 30, cy + 10, { steps: 12 })
  await page.mouse.up()
  const clear = panel.getByRole('button', { name: /Clear color/ })
  await expect(clear).toBeEnabled()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(clear).toBeDisabled()
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(clear).toBeEnabled()
})

test('a modifier volume takes its own settings', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  const volumes = page.locator('[data-section="volumes"]')
  await volumes.getByLabel('Volume type').selectOption('modifier')
  await volumes.getByRole('button', { name: 'Add' }).click()
  await expect(volumes.getByRole('button', { name: 'Modifier 1', exact: true })).toBeVisible()
  const mod = volumes.locator('[data-section="modifier-settings"]')
  await mod.getByRole('button', { name: 'Add setting' }).click()
  await mod.getByLabel('Find a setting for the modifier').fill('infill density')
  await mod.getByRole('list', { name: 'Settings you can add' }).getByRole('button').first().click()
  await expect(mod.locator('li.field')).toHaveCount(1)
})

test('copy and paste with the keys adds a copy beside the object, and undo takes it away', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Shortcuts need a keyboard')
  await prepare(page)
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
})

test('the command bar finds commands by alias, jumps to a setting, and offers the assistant for a question', async ({ page }) => {
  await prepare(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('clone')
  await expect(page.locator('.sx-palette-item', { hasText: 'Duplicate the selected objects' }).first()).toBeVisible()
  // A line that reads as a question ends with the mimir row.
  await page.locator('.sx-palette-input').fill('how do I stop stringing?')
  const items = page.locator('.sx-palette-item')
  await expect(items.last()).toContainText('Ask mimir')
  // A setting by name opens Expert settings at that setting.
  await page.locator('.sx-palette-input').fill('wall loops')
  await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
  await expect(page.locator('#expert-panel')).toBeVisible()
  await expect(page.locator('#expert-search')).toHaveValue(/wall/i)
})

test('with mimir off the command bar does not offer it', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', cadTools: true, pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.locator('.sx-palette-input').fill('how do I stop stringing?')
  await expect(page.locator('.sx-palette-item', { hasText: 'Ask mimir' })).toHaveCount(0)
})


test('send can upload without starting: no bed-clear question, and the file name is fixed', async ({ page }) => {
  test.slow()
  await prepare(page)
  const slices2 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices2)).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on')
  await page.locator('.sx-palette-item', { hasText: 'Print the plate on' }).first().click()
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible()
  // The name was decided with the plate: shown, not asked for.
  await expect(sheet.locator('.ps-file')).toContainText(/\.gcode/)
  await expect(sheet.getByLabel('File name on the printer')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'More ways to send' }).click()
  await sheet.getByRole('menuitemcheckbox', { name: 'Upload only' }).click()
  await expect(sheet.getByRole('button', { name: 'Upload only' })).toBeEnabled()
  await expect(sheet).toContainText('Nothing starts')
  await expect(sheet.getByRole('button', { name: /Bed is clear/ })).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Cancel' }).click()
})

test('the shrinkage test builds its model and turns a measured length into a saved percentage', async ({ page }) => {
  test.slow()
  await prepare(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Calibration')
  await page.locator('.sx-palette-item', { hasText: 'Calibration: temperature' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Calibration' })
  await dialog.getByRole('radio', { name: /Shrinkage/ }).click()
  await dialog.getByRole('button', { name: 'Add to a new plate' }).click()
  await expect(dialog.getByRole('region', { name: 'Result' })).toBeVisible({ timeout: 60_000 })
  await dialog.getByLabel('Measured arm length').fill('99.2')
  await expect(dialog.getByText(/Shrinkage: 99.2 %/)).toBeVisible()
  await dialog.getByLabel('Measured arm length').fill('40')
  await expect(dialog.getByText(/outside 50 to 150/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Save to filament' })).toBeDisabled()
  await dialog.getByLabel('Measured arm length').fill('99.2')
  await dialog.getByRole('button', { name: 'Save to filament' }).click()
  await expect(page.getByText(/saved for .* nozzle in "/)).toBeVisible()
})

test('the object list renames an object, sets a part filament, and leaves an object out of the print', async ({ page }) => {
  await prepare(page)
  await openSheet(page)
  const row = page.locator('li.obj').first()
  await row.locator('.obj-h').click()
  const name = row.getByLabel('Name', { exact: true })
  await name.fill('Layered bracket')
  await name.press('Enter')
  await expect(page.locator('.obj-name', { hasText: 'Layered bracket' })).toBeVisible()
  await row.getByLabel(/^Filament for /).first().selectOption('3')
  await expect(page.locator('[data-section="filament"] .slot[data-slot="3"]')).not.toHaveClass(/unused/)
  await row.getByRole('button', { name: /^Do not print Layered bracket/ }).click()
  await expect(row).toHaveClass(/off/)
  // The Slice action and Undo are on the view.
  await closeSheet(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByText(/set not to print/)).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(row).not.toHaveClass(/off/)
})

test('the object row and the estimate use plain words: parts, slot names, and the engine detail in tooltips', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await prepare(page)
  const row = page.locator('li.obj').first()
  const meta = row.locator('.obj-meta')
  await expect(meta).toHaveText('2 parts')
  await expect(meta).toHaveAttribute('data-tip-title', /^\d[\d,]* triangles$/)
  // A part's filament reads as its slot, type and color, as the printer's slots do.
  await openSheet(page)
  await row.locator('.obj-h').click()
  const options = await row.getByLabel(/^Filament for /).first().locator('option').allTextContents()
  expect(options[0]).toMatch(/^\S+ [A-Z][\w-]* [A-Z][a-z]+( [a-z]+)?$/)
  expect(options.join('|')).not.toMatch(/Filament \d/)
  // Developer mode shows the triangles inline.
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ settingsMode: 'developer' }))
  await expect(meta).toHaveText(/^2 parts, \d[\d,]* triangles$/)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ settingsMode: 'advanced' }))
  // After a slice: the time's tooltip says how long it took; no threads note, no Warnings row at zero.
  const before = await sliceCount(page)
  await closeSheet(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
  const estimate = page.locator('[data-section="estimate"]')
  await expect(estimate.locator('.est-time')).toHaveAttribute('data-tip-title', /^Sliced in \d+(\.\d)? (ms|s)( on \d+ threads)?$/)
  await expect(estimate).not.toContainText('threads')
  await expect(estimate.locator('dt', { hasText: 'Warnings' })).toHaveCount(0)
  // The Sliced plate card: plain words, the engine detail in the line's tooltip, and inline only in Developer mode.
  const result = page.locator('[data-section="result"] .result-line').first()
  await expect(result).toHaveText(/^Sliced \d+ layers in \d+\.\d\d s\.$/)
  // The warnings have their own line under it.
  await expect(page.locator('[data-section="result"] .result-sub').first()).toHaveText(/^(No warnings|\d+ warnings?)\.$/)
  await expect(result).toHaveAttribute('data-tip-title', /^[\d,]+ toolpath segments from the (sx|Orca) engine$/)
  await expect(page.locator('[data-section="result"]')).not.toContainText('toolpath segments')
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ settingsMode: 'developer' }))
  await expect(page.locator('[data-section="result"]')).toContainText('toolpath segments from the')
})

test('the Volumes heading reads in sentence case', async ({ page }) => {
  await prepare(page)
  const heading = page.locator('[data-section="volumes"] .obj-volumes-h')
  await expect(heading).toHaveText('Volumes')
  expect(await heading.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none')
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the object row, part filaments and the estimate in plain words, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await prepare(page)
  const before = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
  const row = page.locator('li.obj').first()
  // On a phone the sidebar is a sheet.
  await openSheet(page)
  await row.locator('.obj-h').click()
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', new RegExp(scheme))
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await row.locator('.obj-meta').hover()
    await page.waitForTimeout(700)
    await page.screenshot({ path: `${dir}/plain-object-row-${scheme}-${width}.png` })
    // On a phone the footer and the summary are in sheets of their own; the review needs them at desktop width only.
    if (isMobile) continue
    const time = page.locator('[data-section="estimate"] .est-time')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    await time.hover()
    const tip = page.getByRole('tooltip').filter({ hasText: /^Sliced in/ })
    await expect(tip).toBeVisible()
    await expect(tip).toHaveAttribute('data-ready', /.*/)
    await page.screenshot({ path: `${dir}/plain-estimate-${scheme}-${width}.png` })
    const card = page.locator('[data-section="result"]').first()
    await card.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    await card.screenshot({ path: `${dir}/plain-sliced-plate-${scheme}-${width}.png` })
  }
})

test('seam paint changes where the seam lands in the sliced G-code', { tag: '@gpu' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Painting needs a mouse')
  test.slow()
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  const sliceAndExport = async (): Promise<string> => {
    const slices3 = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(sliced(page, slices3)).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('Export G-code')
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()])
    return fs.readFileSync(await download.path(), 'utf8')
  }
  const plain = await sliceAndExport()
  expect(plain).toContain('G1')
  await tab(page, 'prepare').click()
  await page.getByRole('button', { name: 'Paint', exact: true }).click()
  const panel = page.locator('[data-section="paint"]')
  await panel.getByRole('radio', { name: 'Seam' }).click()
  await panel.getByRole('radiogroup', { name: 'Brush' }).getByRole('radio', { name: 'Fill', exact: true }).click()
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  // The view opens on the whole plate: bring the model to the middle of the view before painting it.
  await page.keyboard.press('z')
  await page.waitForTimeout(600)
  const box = await page.locator('.vp-canvas').first().boundingBox()
  if (!box) throw new Error('no canvas')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // Bucket fill on a spread of points over the model paints whole surfaces with the seam enforcer.
  for (const [dx, dy] of [[-50, 0], [50, 0], [0, -40], [0, 40], [-30, 25], [30, -25], [-70, 30], [70, -30], [0, 0]] as const) await page.mouse.click(cx + dx, cy + dy)
  await expect(panel.getByRole('button', { name: /Clear seam/ })).toBeEnabled()
  const painted = await sliceAndExport()
  expect(painted).toContain('G1')
  expect(painted).not.toBe(plain)
  // The same slice twice is the same G-code, so the difference is the paint.
  await tab(page, 'prepare').click()
  await page.getByRole('button', { name: 'Undo' }).click()
})

test('the object list reorders by drag and by buttons, and a locked object stays put', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Drag and keys need a desktop')
  await prepare(page)
  await page.locator('li.obj').first().locator('.obj-h').click()
  await page.keyboard.press('ControlOrMeta+d')
  const rows = page.locator('li.obj')
  await expect(rows).toHaveCount(2)
  await rows.nth(0).getByLabel('Name', { exact: true }).fill('First')
  await rows.nth(0).getByLabel('Name', { exact: true }).press('Enter')
  await rows.nth(1).locator('.obj-h').click()
  await rows.nth(1).getByLabel('Name', { exact: true }).fill('Second')
  await rows.nth(1).getByLabel('Name', { exact: true }).press('Enter')
  await expect(rows.nth(0).locator('.obj-name')).toHaveText('First')
  // Buttons.
  await rows.nth(1).getByRole('button', { name: 'Move Second up' }).click()
  await expect(rows.nth(0).locator('.obj-name')).toHaveText('Second')
  // Drag: the row at the bottom onto the top one.
  await rows.nth(1).dragTo(rows.nth(0))
  await expect(rows.nth(0).locator('.obj-name')).toHaveText('First')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(rows.nth(0).locator('.obj-name')).toHaveText('Second')
  // Lock: the numeric position will not change.
  await rows.nth(0).getByRole('button', { name: 'Lock Second' }).click()
  await rows.nth(0).locator('.obj-h').click()
  const posX = page.getByRole('group', { name: 'Position' }).getByRole('textbox', { name: /X/ })
  const before = await posX.inputValue()
  await posX.fill('30')
  await posX.press('Enter')
  await expect(page.getByText(/Second is locked/)).toBeVisible()
  await expect(posX).toHaveValue(before)
  await rows.nth(0).getByRole('button', { name: 'Unlock Second' }).click()
  await posX.fill('30')
  await posX.press('Enter')
  await expect(posX).toHaveValue('30')
})

test('a pressure advance line test exports its own G-code, and an input shaping tower carries its commands', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  const open = async () => {
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('Calibration')
    await page.locator('.sx-palette-item', { hasText: 'Calibration: temperature' }).first().click()
    const d = page.getByRole('dialog', { name: 'Calibration' })
    // The list shows the tests this spool needs; the line and input shaping tests are under Show every test.
    const all = d.getByRole('checkbox', { name: 'Show every test' })
    if (!(await all.isChecked())) await all.check()
    return d
  }
  const sliceAndExport = async (): Promise<string> => {
    const slices4 = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(sliced(page, slices4)).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('Export G-code')
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.sx-palette-item', { hasText: /^Export G-code/ }).first().click()])
    return fs.readFileSync(await download.path(), 'utf8')
  }
  let dialog = await open()
  await dialog.getByRole('radio', { name: /Pressure advance lines/ }).click()
  await dialog.getByRole('button', { name: 'Add to a new plate' }).click()
  await expect(dialog.getByRole('region', { name: 'Result' })).toBeVisible({ timeout: 60_000 })
  await page.keyboard.press('Escape')
  const pa = await sliceAndExport()
  expect(pa).toContain('calibration test: G-code from the test')
  expect(pa).toMatch(/M900 K|SET_PRESSURE_ADVANCE|M572|M233/)
  // The test's own G-code is the body: many lines, each at its own value.
  expect((pa.match(/M900 K|SET_PRESSURE_ADVANCE|M572 D0|M233/g) ?? []).length).toBeGreaterThan(5)
  await tab(page, 'prepare').click()
  dialog = await open()
  await dialog.getByRole('radio', { name: /Input shaping frequency/ }).click()
  await dialog.getByRole('button', { name: 'Add to a new plate' }).click()
  await expect(dialog.getByRole('region', { name: 'Result' })).toBeVisible({ timeout: 60_000 })
  await dialog.getByLabel('Best frequency').selectOption({ index: 3 })
  await expect(dialog.getByLabel('Commands for your printer')).toHaveValue(/M593|SET_INPUT_SHAPER|M593/)
  await page.keyboard.press('Escape')
  const tower = await sliceAndExport()
  // One command per band, all present even though the plate is sliced in shards.
  expect((tower.match(/M593 |SET_INPUT_SHAPER /g) ?? []).length).toBeGreaterThanOrEqual(5)
})

test('feature tooltips show with their key, hand over quickly, explain a disabled tool, and switch off in Settings', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Touch uses long press')
  await prepare(page)
  const tip = page.locator('#sx-tip')
  const move = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Move' })
  const rotate = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Rotate' })
  // Time from the pointer arriving to the tip existing, measured in the page.
  await page.evaluate(() => {
    const w = window as unknown as { __tip: { over: number; shown: number } }
    w.__tip = { over: 0, shown: 0 }
    document.addEventListener('pointerover', () => { if (!w.__tip.over) w.__tip.over = performance.now() }, true)
    new MutationObserver(() => {
      if (document.getElementById('sx-tip') && !w.__tip.shown) w.__tip.shown = performance.now()
    }).observe(document.body, { childList: true, subtree: true })
  })
  const delay = () => page.evaluate(() => { const t = (window as unknown as { __tip: { over: number; shown: number } }).__tip; return t.shown - t.over })
  await move.hover()
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('Drag the model across the plate.')
  await expect(tip.locator('.sx-tip-key')).toHaveText('M')
  // Never earlier than the spec's 450 ms. A loaded machine can be much later, so there is no upper bound here.
  const cold = await delay()
  expect(cold).toBeGreaterThanOrEqual(430)
  // A neighbor right after shows almost at once.
  await page.evaluate(() => { (window as unknown as { __tip: { over: number; shown: number } }).__tip = { over: 0, shown: 0 } })
  await rotate.hover()
  await expect(tip).toContainText('Drag a ring to turn the model around that axis.')
  // Warm is the quick hand over: clearly faster than the cold delay.
  expect(await delay()).toBeLessThan(cold * 0.6)
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  // A disabled tool still explains itself.
  const drop = page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Undo' })
  await expect(drop).toHaveAttribute('aria-disabled', 'true')
  await drop.hover()
  await expect(tip).toContainText('Nothing to undo.')
  // ? pins the tip under the pointer even when tips are off.
  await page.mouse.move(5, 5)
  await expect(tip).toHaveCount(0)
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}') as Record<string, unknown>
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ ...raw, tooltips: { enabled: false, media: true } }))
  })
  await page.reload()
  await expect(move).toBeVisible()
  await move.hover()
  await page.waitForTimeout(700)
  await expect(tip).toHaveCount(0)
  await page.keyboard.press('Shift+?')
  await expect(tip).toContainText('Move')
})

test('a part takes its own setting: it is listed under the part only, and the slice uses it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  const gramsOf = async (): Promise<number> => {
    const slices5 = await sliceCount(page)
    await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
    await expect(sliced(page, slices5)).toBeVisible({ timeout: 90_000 })
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
    const text = fs.readFileSync(await download.path(), 'utf8')
    await tab(page, 'prepare').click()
    return Number(/; total filament used \[g\] = ([\d.]+)/.exec(text)?.[1])
  }
  const before = await gramsOf()
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  const target = page.getByLabel('Settings apply to')
  const options = await target.locator('option').allTextContents()
  expect(options.length).toBeGreaterThan(2)
  await target.selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Add setting' }).click()
  await page.getByRole('textbox', { name: 'Find a setting to change for this object' }).fill('sparse infill density')
  await page.getByRole('list', { name: 'Settings you can add' }).getByRole('button').first().click()
  const field = page.locator('.obj-set-list li').first().getByRole('textbox')
  await field.fill('100')
  await field.press('Enter')
  await target.selectOption('')
  await expect(page.locator('.obj-set-list li')).toHaveCount(0)
  await target.selectOption({ index: 1 })
  await expect(page.locator('.obj-set-list li')).toHaveCount(1)
  const after = await gramsOf()
  expect(after).toBeGreaterThan(before)
})

test('sleipnir is on by default in the layer height picker and changes the layer count of a sphere', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await prepare(page)
  const picker = page.locator('#easy-layer')
  await expect(picker).toHaveText('sleipnir')
  const pick = async (name: string | RegExp): Promise<void> => {
    await picker.click()
    await page.getByRole('menuitemcheckbox', { name }).click()
  }
  // A sphere alone: the demo model comes off the plate.
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Add shape' }).click()
  await page.getByRole('menuitem', { name: 'Sphere' }).first().click()
  await expect(page.locator('.obj-name')).toHaveCount(1)
  const layers = async (): Promise<number> => {
    const slices6 = await sliceCount(page)
    await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
    await expect(sliced(page, slices6)).toBeVisible({ timeout: 90_000 })
    const text = await page.locator('[data-section="result"]').innerText()
    const n = Number(/Sliced (\d+) layers/.exec(text)?.[1])
    await tab(page, 'prepare').click()
    return n
  }
  const smart = await layers()
  await pick('0.20 mm')
  await expect(picker).toHaveText('0.20 mm')
  const fixed = await layers()
  expect(smart).not.toBe(fixed)
  await pick(/^sleipnir/)
  await expect(picker).toHaveText('sleipnir')
  expect(await layers()).toBe(smart)
})

test('queue for later uploads and waits; a queued plate is started from Printers with the bed-clear question', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await prepare(page)
  const slices7 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices7)).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on')
  await page.locator('.sx-palette-item', { hasText: 'Print the plate on' }).first().click()
  const sheet = page.locator('dialog.print-sheet[open]')
  await sheet.getByRole('button', { name: 'More ways to send' }).click()
  await sheet.getByRole('menuitemcheckbox', { name: 'Queue for later' }).click()
  await sheet.getByLabel('Not before (optional)').fill('2030-01-01T02:00')
  await expect(sheet).toContainText('adds it to the queue')
  await expect(sheet.getByRole('button', { name: /Bed is clear/ })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Add to queue' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Cancel' }).click()
})

test('the queue on Printers lists waiting plates, marks a due one, and asks before starting', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    const item = (id: string, startAfter?: string) => ({ id, printerId: 'bay-2', printerName: 'Bay 2', plateName: id, remote: { printerId: 'bay-2', path: `/${id}.gcode`, name: `${id}.gcode` }, sha256: 'abcdef0123456789', layers: 120, timeS: 3600, grams: 12, options: {}, ...(startAfter ? { startAfter } : {}), addedAt: '2026-09-30T10:00:00.000Z' })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'printers', queue: [item('Bracket', '2020-01-01T00:00:00.000Z'), item('Lid')] }))
  })
  await page.goto('./')
  const list = page.getByRole('list', { name: 'Queued plates' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await expect(list.getByRole('listitem').first()).toContainText('Ready')
  // The second plate on the same printer waits for the first.
  await expect(list.getByRole('listitem').nth(1).getByRole('button', { name: 'Start' })).toHaveAttribute('aria-disabled', 'true')
  await list.getByRole('listitem').first().getByRole('button', { name: 'Start' }).click()
  const dialog = page.locator('dialog.approve-dialog[open]')
  await expect(dialog).toContainText('Start Bracket on Bay 2?')
  await expect(dialog.getByRole('button', { name: 'Bed is clear, start print' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await list.getByRole('listitem').first().getByRole('button', { name: 'Remove Bracket from the queue' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
})

test('a slot links to a Spoolman spool, and the plate can be subtracted from it with approval', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await prepare(page)
  await page.getByRole('button', { name: 'Edit filament 1' }).first().click()
  const dialog = page.getByRole('dialog', { name: /Filament 1/ })
  // The spool picker is a list with a search and a vendor filter; the first row is Not linked.
  const spools = dialog.getByRole('listbox', { name: 'Spools' }).getByRole('option')
  await expect(spools.first()).toBeVisible()
  expect(await spools.count()).toBeGreaterThan(2)
  await spools.nth(1).getByRole('button').click()
  await expect(spools.nth(1)).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('button', { name: 'Done' }).click()
  const slices8 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices8)).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Record use in Spoolman' }).click()
  const approve = page.locator('dialog.approve-dialog[open]')
  await expect(approve).toContainText('Subtract this print from your spools in Spoolman?')
  await approve.getByRole('button', { name: 'Deny' }).click()
})

test('send shows each filament on its printer slot as text when every filament has one', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await prepare(page)
  const slices9 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices9)).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Print the plate on')
  await page.locator('.sx-palette-item', { hasText: 'Print the plate on' }).first().click()
  const sheet = page.locator('dialog.print-sheet[open]')
  await expect(sheet.locator('.ps-file[data-checked]')).toBeVisible()
  const fils = sheet.getByRole('list', { name: 'Filaments' }).locator('.ps-fil')
  expect(await fils.count()).toBeGreaterThanOrEqual(1)
  await expect(fils.first()).toContainText(/AMS |Slot |External spool|Not loaded/)
  // A slot is picked on the sheet only when no loaded slot fits a filament.
  const picker = sheet.getByRole('group', { name: 'Pick a slot' })
  if (await picker.count()) await expect(sheet.getByRole('button', { name: /^Bed is clear, start/ })).toBeDisabled()
  else await expect(sheet.getByRole('combobox')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Cancel' }).click()
})

test('send to several printers walks each one through its own send step', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await prepare(page)
  const slices10 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices10)).toBeVisible({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Printers', exact: true }).click()
  await page.getByRole('button', { name: 'Several' }).click()
  const pick = page.getByRole('dialog', { name: 'Print on several printers' })
  const boxes = pick.getByRole('checkbox')
  expect(await boxes.count()).toBeGreaterThan(1)
  await expect(pick.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await boxes.nth(0).check()
  await boxes.nth(1).check()
  await pick.getByRole('button', { name: /Continue with 2 printers/ }).click()
  const first = page.locator('dialog.print-sheet[open]')
  await expect(first).toBeVisible()
  const titles = () => page.locator('dialog.print-sheet[open] .ps-printer-name').allInnerTexts().then((t) => t.join('|'))
  const firstTitle = await titles()
  expect(firstTitle.length).toBeGreaterThan(0)
  await first.getByRole('button', { name: 'Cancel' }).click()
  // The next printer's sheet opens with its own name.
  await expect.poll(async () => { const t = await titles(); return t.length > 0 && t !== firstTitle }).toBe(true)
  await page.locator('dialog.print-sheet[open]').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('dialog.print-sheet[open]')).toHaveCount(0)
})

test('presets sync through a file you keep: save one, merge another, and read the change notes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
    Reflect.deleteProperty(window, 'showOpenFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Presets' }).click()
  await page.getByLabel('Name for a new process preset').fill('Fast draft')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save sync file' }).click()])
  const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8')) as { format: string; presets: { name: string }[] }
  expect(saved.format).toBe('slicerx-presets')
  expect(saved.presets.map((p) => p.name)).toContain('Fast draft')
  const remote = { format: 'slicerx-presets', version: 1, exportedAt: Date.now(), presets: [{ id: 'remote-1', kind: 'filament', name: 'Remote PLA', values: { nozzle_temperature: 215 }, createdAt: 1, updatedAt: Date.now() }], deleted: [], changes: [] }
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Merge a sync file' }).click()])
  await chooser.setFiles({ name: 'other.sync.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(remote)) })
  await expect(page.getByRole('status').filter({ hasText: 'Added Remote PLA' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Filament presets' })).toContainText('Remote PLA')
  await page.getByText(/Change notes/).click()
  await expect(page.getByText('Added Remote PLA (filament).').last()).toBeVisible()
})

test('pause, color change and custom G-code are set on the layer slider and land in the G-code', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  const slices11 = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(sliced(page, slices11)).toBeVisible({ timeout: 120_000 })
  const slider = page.locator('#pv-layer')
  await slider.fill('20')
  await slider.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add pause' }).click()
  await slider.fill('40')
  await page.getByRole('button', { name: 'Add at this layer' }).click()
  await page.getByRole('menuitem', { name: 'Add color change' }).click()
  await slider.fill('60')
  await page.getByRole('button', { name: 'Add at this layer' }).click()
  await page.getByRole('menuitem', { name: 'Add custom G-code' }).click()
  const dialog = page.getByRole('dialog', { name: /Custom G-code at layer 60/ })
  await dialog.getByLabel('G-code').fill('M500')
  await expect(dialog.getByRole('button', { name: 'Add' })).toBeDisabled()
  await expect(dialog).toContainText('printer memory')
  await dialog.getByLabel('G-code').fill('M117 Swap the lid')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(page.locator('.layer-mark')).toHaveCount(3)
  // The marks go into the next slice, at their layers.
  await tab(page, 'prepare').click()
  const slices12 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect(sliced(page, slices12)).toBeVisible({ timeout: 120_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
  const text = fs.readFileSync(await download.path(), 'utf8')
  expect(text).toContain('M117 Swap the lid')
  // The pause is the printer profile's own pause G-code: M601 by default, M400 U1 on a Bambu Lab printer.
  const pause = /\n(M601|M400 U1)/
  expect(text).toMatch(pause)
  expect(text).toMatch(/\nM600/)
  const at = (needle: RegExp) => text.slice(0, text.search(needle)).split(/;LAYER_CHANGE|; CHANGE_LAYER/).length - 1
  expect(at(pause)).toBeLessThan(at(/\nM600/))
  expect(at(/\nM600/)).toBeLessThan(at(/M117 Swap the lid/))
  // A mark is deleted from its own menu.
  await page.locator('.layer-mark').first().click()
  await page.getByRole('menuitem', { name: 'Delete pause' }).click()
  await expect(page.locator('.layer-mark')).toHaveCount(2)
})

test('Printer settings open from the command bar in Simple mode', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('Printer settings')
  await page.locator('.sx-palette-item', { hasText: /^Printer settings/ }).first().click()
  await expect(page.getByRole('dialog', { name: /Printer settings/ })).toBeVisible()
})

for (const printer of [
  { name: 'Bay 2', model: 'Bambu Lab P1S', start: 'machine: P1S-0.4' },
  { name: 'Bay 3', model: 'Prusa MK4S', start: 'M862.1 P' },
  { name: 'Bay 5', model: 'Creality K1 Max', start: 'START_PRINT EXTRUDER_TEMP' },
]) {
  test(`${printer.model}: the stock presets slice with no lint errors and the maker start G-code is in the file`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Runs at desktop width')
    test.slow()
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker')
    })
    await prepare(page)
    const fs = await import('node:fs')
    await page.getByTestId('slice-machine-printer').click()
    await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: new RegExp(printer.name) }).click()
    await expect(page.locator('.printer-name')).toContainText(printer.name)
    const slices13 = await sliceCount(page)
    await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
    await expect(sliced(page, slices13)).toBeVisible({ timeout: 120_000 })
    // No warning about the G-code: the linter let the shipped text through.
    await expect(page.locator('.warns li').filter({ hasText: /G-code|lint|blocked|refused/i })).toHaveCount(0)
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
    const text = fs.readFileSync(await download.path(), 'utf8')
    expect(executable(text).slice(0, 20_000)).toContain(printer.start)
  })
}

test('the nozzle size is chosen per printer from its chip, and the slice uses the matching presets', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  const chip = page.getByTestId('slice-machine-nozzle')
  await expect(chip).toHaveAttribute('aria-label', 'Nozzle: 0.4 mm')
  await chip.click()
  const sizes = page.getByRole('radiogroup', { name: 'Nozzle size' })
  await expect(sizes.getByRole('radio', { name: '0.4 mm' })).toHaveAttribute('aria-checked', 'true')
  await sizes.getByRole('radio', { name: '0.6 mm' }).click()
  await expect(chip).toHaveAttribute('aria-label', 'Nozzle: 0.6 mm')
  const slices14 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect(sliced(page, slices14)).toBeVisible({ timeout: 120_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
  const text = fs.readFileSync(await download.path(), 'utf8')
  // The 0.6 mm nozzle's lines: 1.05 times the nozzle, not the 0.42 of a 0.4 mm nozzle.
  expect(text.slice(0, text.length - executable(text).length || 1500)).toMatch(/^; line_width = 0\.6\d/m)
  // The choice stays after a reload.
  await page.reload()
  await tab(page, 'prepare').click()
  await expect(page.getByTestId('slice-machine-nozzle')).toHaveAttribute('aria-label', 'Nozzle: 0.6 mm')
})

test('brim ears: click the model to add ears, they print as discs on the first layer, and remove all clears them', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  // The brim type is painted; the tool appears with it.
  await page.keyboard.press('ControlOrMeta+k')
  await page.locator('.sx-palette-input').fill('brim type')
  await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
  await expect(page.locator('#expert-panel')).toBeVisible()
  await page.locator('#expert-panel').getByLabel('Brim type').selectOption('painted')
  const toolbar = page.getByRole('toolbar', { name: 'Plate tools' })
  await toolbar.getByRole('button', { name: 'Brim ears' }).click()
  const panel = page.locator('[data-section=brim-ears]')
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/No ears yet/)
  await page.locator('.obj-name', { hasText: 'Layered X' }).click()
  const vp = page.locator('.vp-canvas').first()
  const box = (await vp.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/1 ear/)
  // A click inside the footprint prints nothing (the ear is cut by the part). A second ear goes on the model's left edge,
  // sent through the viewport's own event, so it is the same path as a click there.
  await page.evaluate(() => {
    const w = window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[]; parts: { positions: Float32Array }[] }[] } }; __vp: { emit(e: string, p: unknown): void } }
    const o = w.__sx.getState().plate[0]!
    const m = o.transform
    let minX = Infinity
    let y = 0
    let n = 0
    for (const part of o.parts) for (let i = 0; i + 2 < part.positions.length; i += 3) {
      const px = part.positions[i]!
      const py = part.positions[i + 1]!
      const pz = part.positions[i + 2]!
      const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!
      if (x < minX) minX = x
      y += m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!
      n++
    }
    w.__vp.emit('brimadd', { objectId: o.id, point: [minX, y / n, 0] })
  })
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/2 ears/)
  // Select all, remove the selected ones, then Auto-generate puts ears on the corners of the first layer.
  await panel.getByRole('button', { name: 'Select all' }).click()
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/2 selected/)
  await panel.getByRole('button', { name: 'Remove selected' }).click()
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/No ears yet/)
  await panel.getByRole('button', { name: 'Auto-generate' }).click()
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/\d+ ears?/)
  const generated = Number(/(\d+) ear/.exec((await panel.getByTestId('brim-ear-count').textContent()) ?? '')?.[1])
  expect(generated).toBeGreaterThanOrEqual(3)
  // A click on an ear selects it (the viewport's brimselect event), and Delete removes the ear, not the object.
  await page.evaluate(() => {
    const w = window as unknown as { __sx: { getState(): { selection: string } }; __vp: { emit(e: string, p: unknown): void } }
    w.__vp.emit('brimselect', { objectId: w.__sx.getState().selection, indices: [0], mode: 'set' })
  })
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/1 selected/)
  await page.keyboard.press('Delete')
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(new RegExp(`${generated - 1} ears?`))
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible()
  const slices15 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect(sliced(page, slices15)).toBeVisible({ timeout: 120_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
  const text = fs.readFileSync(await download.path(), 'utf8')
  const mark = text.includes('\n; CHANGE_LAYER\n') ? '; CHANGE_LAYER' : ';LAYER_CHANGE'
  const firstLayer = text.slice(text.indexOf(mark), text.indexOf(mark, text.indexOf(mark) + 1))
  expect(firstLayer).toMatch(/;\s*(?:TYPE|FEATURE):\s*Brim/)
  // Remove all clears them. The slice showed the toolpaths and ended the brim tool; open it again.
  await tab(page, 'prepare').click()
  await page.getByRole('toolbar', { name: 'Plate tools' }).getByRole('button', { name: 'Brim ears' }).click()
  await panel.getByRole('button', { name: 'Remove all' }).click()
  await expect(panel.getByTestId('brim-ear-count')).toHaveText(/No ears yet/)
})

test('the G-code carries the real date and local time: the date variables in the start G-code are not 1970', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  // Printers such as the Creality K2 Plus write the date in their start G-code ([year] to [second]); a comment line does the same here.
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { overrides: Record<string, unknown> }; setState(s: unknown): void } }).__sx
    sx.setState({ overrides: { ...sx.getState().overrides, machine_start_gcode: '; stamp [year]-[month]-[day] at [hour]:[minute]:[second]\nG28' } })
  })
  const stamp = () => page.evaluate(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours() }
  })
  const before = await stamp()
  const slices16 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect(sliced(page, slices16)).toBeVisible({ timeout: 120_000 })
  const after = await stamp()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
  const text = fs.readFileSync(await download.path(), 'utf8')
  const m = /; stamp (\d+)-(\d+)-(\d+) at (\d+):(\d+):(\d+)/.exec(executable(text).slice(0, 20_000))
  expect(m, 'the start G-code has the stamp line').not.toBeNull()
  const [year, month, day, hour] = [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])]
  expect(year).toBeGreaterThanOrEqual(before.year)
  expect(year).toBeLessThanOrEqual(after.year)
  // The slice happened between the two readings, so the date and local hour are one of the two.
  expect([before.month, after.month]).toContain(month)
  expect([before.day, after.day]).toContain(day)
  expect([before.hour, after.hour]).toContain(hour)
})

test('a two-color plate on a Bambu printer gets a prime tower from the printer preset and a flush matrix with its measured volumes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    Reflect.deleteProperty(window, 'showSaveFilePicker')
  })
  await prepare(page)
  const fs = await import('node:fs')
  await page.getByTestId('slice-machine-printer').click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
  // Layered X has two parts, on the printer's AMS slots A1 and A2 (black and dark gray, the measured pair #000000 to #545454: 236 plus the printer minimum).
  const slices17 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect(sliced(page, slices17)).toBeVisible({ timeout: 120_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
  const text = fs.readFileSync(await download.path(), 'utf8')
  // The preset's tower reaches the slice: the engine prints it and changes tools. The matrix values are checked in test/filament.test.ts.
  expect(text).toMatch(/;\s*(?:TYPE|FEATURE):\s*Prime tower/i)
  // The start G-code selects T0 (indented inside its AMS block) and the plinth to X change selects T1 once.
  expect((text.match(/^\s*T[01]\b/gm) ?? []).length).toBeGreaterThanOrEqual(2)
  expect(text).toMatch(/^T1\b/m)
})
