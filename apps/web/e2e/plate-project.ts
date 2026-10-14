// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Many-plate projects made in the specs, in the shape Bambu Studio writes them: one small box per object, each plate
// named and listing its objects. A plate with no objects stays in the file as an empty plate.
import { expect, type Locator, type Page } from '@playwright/test'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { plateReady } from './fixtures'
import { zip } from './project-zip'

/** 27 plate names in the shape of a real deck box project: a long shared start, with the part that differs at the end. */
export const DECK_BOX_27 = [
  'Shell, front half', 'Shell, back half', 'Lid with hinge pins', 'Cartridge slot insert (left)', 'Cartridge slot insert (right)',
  'Controller tray', 'Cable spool', 'Divider, 3 slots', 'Divider, 5 slots', 'Label plate, platformer', 'Label plate, adventure',
  'Label plate, space explorer', 'Label plate, time travel', 'Label plate, fantasy six', 'Label plate, small town', 'Label plate, jungle',
  'Label plate, starship', 'Label plate, racer', 'Label plate, kart racer', 'Feet, set of 4', 'Magnet cups, set of 8', 'Latch, left', 'Latch, right',
  'Hinge pins, spares', 'Logo inlay, purple', 'Logo inlay, gray', 'Test fit coupon',
].map((n) => `Retro console deck box, ${n.charAt(0).toLowerCase()}${n.slice(1)}`)

/** Three short plate names. */
export const SMALL_3 = ['Pi case base', 'Pi case lid', 'Layered X stand']

function box(id: number, size: number): string {
  const s = size
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/**
 * A project with one plate per name. Each plate holds one box (its size varies, so the thumbnails differ), except the
 * plates `empty` lists by index, which stay empty.
 */
export function plateProject(names: readonly string[], empty: readonly number[] = []): Buffer {
  const full = names.map((_, i) => i).filter((i) => !empty.includes(i))
  const ids = full.map((i) => i + 1)
  const items = full.map((i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${60 + (i % 4) * 8} ${60 + (i % 3) * 8} 0" printable="1"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${full.map((i) => box(i + 1, 8 + (i % 5) * 4)).join('')}</resources><build>${items}</build></model>`
  const objects = ids.map((id) => `<object id="${id}"><metadata key="name" value="Part ${id}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plates = names
    .map((name, i) => {
      const on = empty.includes(i) ? '' : `<model_instance><metadata key="object_id" value="${i + 1}"/><metadata key="instance_id" value="0"/></model_instance>`
      return `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="${name}"/><metadata key="locked" value="false"/>${on}</plate>`
    })
    .join('')
  const settings = { printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle', printer_model: 'Bambu Lab A1 mini', nozzle_diameter: ['0.4'], printable_area: ['0x0', '180x0', '180x180', '0x180'], layer_height: '0.2', filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plates}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

/** Starts the studio in Slice and opens a many-plate project through Open, waiting until all its plates are there. */
export async function openPlateProject(page: Page, names: readonly string[], empty: readonly number[] = [], extraPrefs: Record<string, unknown> = {}): Promise<void> {
  interceptFileDialogs(page)
  await page.addInitScript((prefs) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, ...prefs }))
  }, extraPrefs)
  await page.goto('./')
  await plateReady(page)
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'Deck box.3mf', mimeType: 'model/3mf', buffer: plateProject(names, empty) })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plates: unknown[] } } }).__sx.getState().plates.length), { timeout: 60_000 }).toBe(names.length)
}

/** The plate picker's sheet of every plate, opened from the picker when it is shut. */
export async function plateSheet(page: Page): Promise<Locator> {
  const sheet = page.getByRole('dialog', { name: 'Plates' })
  if (!(await sheet.isVisible())) await page.getByTestId('plate-picker-current').click()
  await expect(sheet).toBeVisible()
  return sheet
}

/** Adds a plate from the picker's sheet; the new plate is shown and the sheet shuts. */
export async function addPlateFromPicker(page: Page): Promise<void> {
  await (await plateSheet(page)).getByRole('button', { name: 'Add plate' }).click()
  await expect(page.getByRole('dialog', { name: 'Plates' })).toBeHidden()
}

/** Shows plate `n` (from 1) from the picker's sheet. */
export async function pickPlate(page: Page, n: number): Promise<void> {
  const sheet = await plateSheet(page)
  await sheet.locator('.pp-card').nth(n - 1).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText(`Plate ${n}`)
}

/** The shown plate's settings, opened in the picker's sheet; `name` is the plate's name as the form's group reads it. */
export async function shownPlateSettings(page: Page, name: string): Promise<Locator> {
  const sheet = await plateSheet(page)
  await sheet.getByRole('button', { name: 'Plate settings' }).click()
  const group = sheet.getByRole('group', { name: `${name} settings` })
  await expect(group).toBeVisible()
  return group
}

/** Shuts the picker's sheet. */
export async function shutPlateSheet(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Plates' })).toBeHidden()
}
