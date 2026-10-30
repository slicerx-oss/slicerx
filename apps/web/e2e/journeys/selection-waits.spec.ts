// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's selection follows the app's even for parts it has not built yet. A project that opens holds its plate
// back until the swap frame; a selection made the moment the open finishes shows once the parts are drawn, instead of
// being lost. One undo after deleting a selection draws it selected again.
import type { Page } from '@playwright/test'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { zip } from '../project-zip'
import { openFile, settledView, useFileDialogs } from './lib/model'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, sliceLook: 'toolpaths', autoSliceBySize: false } })
test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
useFileDialogs()

type Entry = { id: string; name: string }
type State = { plate: Entry[]; plateLoading: boolean; selection: string | null; selectedIds: string[] }
type Sx = { getState(): State; setState(p: unknown): void; subscribe(cb: (s: State, prev: State) => void): () => void }
type Vp = { drawnObjects(): string[]; selectedObjects(): string[] }

/** A one-plate project with a 20 mm box at each spot. */
function project(spots: readonly [number, number][]): Buffer {
  const s = 20
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const ids = spots.map((_, i) => i + 1)
  const mesh = (id: number) => `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
  const items = spots.map(([x, y], i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${x - s / 2} ${y - s / 2} 0" printable="1"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${ids.map(mesh).join('')}</resources><build>${items}</build></model>`
  const objects = ids.map((id) => `<object id="${id}"><metadata key="name" value="Part ${id}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plate = `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Plate 1"/><metadata key="locked" value="false"/>${ids.map((id) => `<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`).join('')}</plate>`
  const settings = { printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle', printer_model: 'Bambu Lab A1 mini', nozzle_diameter: ['0.4'], printable_area: ['0x0', '180x0', '180x180', '0x180'], layer_height: '0.2', filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plate}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

const SPOTS: [number, number][] = [[60, 120], [120, 60]]

/** The parts the view draws as selected and the ones the app has selected, by name. */
const selected = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    const vp = (window as unknown as { __vp: Vp }).__vp
    const name = (id: string) => s.plate.find((o) => o.id === id)?.name ?? id
    return { view: vp.selectedObjects().map(name).sort(), app: s.selectedIds.map(name).sort() }
  })

const drawn = (page: Page) => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.drawnObjects().length)

test.describe('the view selection waits for its parts', () => {
  test('a selection made as an open finishes shows once the parts are drawn', async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ autoSlice: false }))
    // select both parts in the same turn the open lets go of its plate, before the view's swap frame builds them
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      const off = sx.subscribe((s, prev) => {
        if (!prev.plateLoading || s.plateLoading || s.plate.length !== 2) return
        off()
        const ids = s.plate.map((o) => o.id)
        queueMicrotask(() => sx.setState({ selection: ids[0], selectedIds: ids }))
      })
    })
    await openFile(page, { name: 'Selection.3mf', mimeType: 'model/3mf', buffer: project(SPOTS) })
    await expect.poll(() => drawn(page)).toBe(2)
    await expect.poll(() => selected(page)).toEqual({ view: ['Part 1', 'Part 2'], app: ['Part 1', 'Part 2'] })
  })

  // Undo puts the parts back in one go, before it sets the selection, so this passed before the view kept a waiting
  // selection too; it stays as a guard on the undo path.
  test('one undo after deleting a selection draws it selected again', async ({ page }) => {
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ autoSlice: false }))
    await openFile(page, { name: 'Selection.3mf', mimeType: 'model/3mf', buffer: project(SPOTS) })
    await expect.poll(() => drawn(page)).toBe(2)
    await settledView(page)
    const select = () =>
      page.evaluate(() => {
        const sx = (window as unknown as { __sx: Sx }).__sx
        const ids = sx.getState().plate.map((o) => o.id)
        sx.setState({ selection: ids[0], selectedIds: ids })
      })
    // the open may still settle its own selection: select until both stay selected
    await expect.poll(async () => {
      await select()
      return selected(page)
    }).toEqual({ view: ['Part 1', 'Part 2'], app: ['Part 1', 'Part 2'] })
    await page.locator('.vp-canvas').first().focus()
    await page.keyboard.press('Delete')
    await expect.poll(() => drawn(page)).toBe(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => drawn(page)).toBe(2)
    await expect.poll(() => selected(page)).toEqual({ view: ['Part 1', 'Part 2'], app: ['Part 1', 'Part 2'] })
  })
})
