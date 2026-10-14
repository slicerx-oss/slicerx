// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project with many named plates opens with the file's plates as they are: the first plate shows the
// file's name for it, not "Plate 1", an empty plate between full ones stays so plate N is plate N in the file, and
// each plate holds the objects the file puts on it. The project is made here in the shape of a real deck box project.
import { expect, type Page } from '@playwright/test'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { plateReady, test } from './fixtures'
import { plateSheet } from './plate-project'
import { zip } from './project-zip'

const PLATES: [string, string[]][] = [
  ['Deck Box Bottom', ['23']],
  ['Deck Box Top', ['21']],
  ['Cartridge Cover', ['19']],
  ['Start-Reset Buttons', ['13', '17']],
  ['Connectors', ['7', '8', '10', '11']],
  ['Insert Button', []],
  ['Flat Button', []],
  ['Colored Buttons', ['2', '3', '4', '5']],
]
const IDS = PLATES.flatMap(([, on]) => on).sort((a, b) => Number(a) - Number(b))

function cube(id: string): string {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** The project: one small cube per object, build items in id order, plates listed in their own order. */
function deckBoxProject(): Buffer {
  const items = IDS.map((id, i) => `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${30 + 20 * (i % 6)} ${40 + 20 * Math.floor(i / 6)} 0" printable="1"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${IDS.map(cube).join('')}</resources><build>${items}</build></model>`
  const objects = IDS.map((id) => `<object id="${id}"><metadata key="name" value="Part ${id}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plates = PLATES.map(
    ([name, on], i) =>
      `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="${name}"/><metadata key="locked" value="false"/><metadata key="thumbnail_file" value="Metadata/plate_${i + 1}.png"/>${on.map((o) => `<model_instance><metadata key="object_id" value="${o}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`,
  ).join('')
  const settings = { printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle', printer_model: 'Bambu Lab A1 mini', nozzle_diameter: ['0.4'], printable_area: ['0x0', '180x0', '180x180', '0x180'], layer_height: '0.2', filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plates}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

type Sx = { getState(): { plates: { id: string; name: string; objects: { name: string }[] }[]; plate: { name: string }[]; activePlate: string } }

async function openProject(page: Page): Promise<void> {
  interceptFileDialogs(page)
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'Deck Box.3mf', mimeType: 'model/3mf', buffer: deckBoxProject() })
}

test("a Bambu Studio project's plates open in the file's order, each with its name and objects", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  await openProject(page)
  // The plate picker's sheet lists every plate in the file's order, each card named for its plate.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plates.length), { timeout: 60_000 }).toBe(PLATES.length)
  const cards = (await plateSheet(page)).locator('.pp-card')
  await expect(cards).toHaveCount(PLATES.length)
  await expect(cards.locator('.pp-card-name .mid-text')).toHaveText(PLATES.map(([name]) => name))
  for (const [i, [, on]] of PLATES.entries()) await expect(cards.nth(i)).toHaveAttribute('data-tip-body', new RegExp(`^${on.length} objects?,`))
  await expect(cards.first().locator('.pp-card-name .mid-text')).not.toHaveText('Plate 1')
  await expect(page.getByTestId('plate-picker-current')).toContainText('Deck Box Bottom')
  // The store holds each plate's own objects, as the file lists them.
  const got = await page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    return s.plates.map((p) => ({ name: p.name, objects: (p.id === s.activePlate ? s.plate : p.objects).map((o) => o.name) }))
  })
  expect(got).toEqual(PLATES.map(([name, on]) => ({ name, objects: on.map((id) => `Part ${id}`) })))
})
