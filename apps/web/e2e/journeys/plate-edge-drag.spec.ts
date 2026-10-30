// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag: a part dragged out past a bed edge goes to another plate (left, top and right, in plate order) or to
// a new plate (the bottom), once all of it is past the commit line. A release short of the line, or Esc, puts it back.
// Past three other plates the top edge lists the rest. A multi-selection goes as one group, and one undo brings
// everything back. Each test opens its own project, so none counts on the one before.
import type { Page } from '@playwright/test'
import { pressable, steady } from '../canvas-press'
import { expect } from '../fixtures'
import { journey as test } from '../journey'
import { pickPlate } from '../plate-project'
import { zip } from '../project-zip'
import { openFile, settledView, settleOpen, useFileDialogs } from './lib/model'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, sliceLook: 'toolpaths', autoSliceBySize: false } })
test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
useFileDialogs()

type Entry = { id: string; name: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }
type Sx = {
  getState(): {
    plates: { id: string; name: string; objects: Entry[] }[]
    plate: Entry[]
    activePlate: string
    plateLoading: boolean
    selectedIds: string[]
    selection: string | null
    bed: { widthMm: number; depthMm: number }
  }
  setState(p: unknown): void
}
type Vp = { cancelDrag?(): boolean; rig: { move: unknown } }

const SIZE = 20

/** A project of `plates` plates; the first holds a 20 mm box at each spot, the others are empty. */
function edgeProject(plates: number, spots: readonly [number, number][]): Buffer {
  const s = SIZE
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const mesh = (id: number) => `<object id="${id}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
  const ids = spots.map((_, i) => i + 1)
  const items = spots.map(([x, y], i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${x - s / 2} ${y - s / 2} 0" printable="1"/>`).join('')
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${ids.map(mesh).join('')}</resources><build>${items}</build></model>`
  const objects = ids.map((id) => `<object id="${id}"><metadata key="name" value="Part ${id}"/><metadata key="extruder" value="1"/></object>`).join('')
  const plateXml = Array.from({ length: plates }, (_, i) => {
    const on = i === 0 ? ids.map((id) => `<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`).join('') : ''
    return `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="plater_name" value="Edge ${i + 1}"/><metadata key="locked" value="false"/>${on}</plate>`
  }).join('')
  const settings = { printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle', printer_model: 'Bambu Lab A1 mini', nozzle_diameter: ['0.4'], printable_area: ['0x0', '180x0', '180x180', '0x180'], layer_height: '0.2', filament_colour: ['#00AE42'] }
  return zip({ '3D/3dmodel.model': model, 'Metadata/model_settings.config': `<?xml version="1.0" encoding="UTF-8"?><config>${objects}${plateXml}</config>`, 'Metadata/project_settings.config': JSON.stringify(settings) })
}

const state = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __sx: Sx }).__sx.getState()
  return {
    shown: s.plates.findIndex((p) => p.id === s.activePlate) + 1,
    plates: s.plates.map((p) => (p.id === s.activePlate ? s.plate : p.objects).map((o) => o.name).sort()),
    transforms: Object.fromEntries(s.plate.map((o) => [o.name, o.transform.map((v) => Math.round(v * 100) / 100)])),
    selected: s.selectedIds.map((id) => s.plate.find((o) => o.id === id)?.name ?? id).sort(),
  }
})

/**
 * Opens the project and waits until its plates are in with the first plate's parts drawn. Slicing stays off here: a
 * slice landing mid-test brings up the toolpath overlays and frames the view again under a press.
 */
async function open(page: Page, plates: number, spots: readonly [number, number][]): Promise<void> {
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ autoSlice: false }))
  const before = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((o) => o.id))
  await openFile(page, { name: 'Edge drag.3mf', mimeType: 'model/3mf', buffer: edgeProject(plates, spots) })
  await settleOpen(page, () =>
    page.evaluate(([n, k, before]) => {
      const s = (window as unknown as { __sx: Sx }).__sx.getState()
      return !s.plateLoading && s.plates.length === n && s.plates[0]!.id === s.activePlate && s.plate.length === k && !s.plate.some((o) => (before as string[]).includes(o.id))
    }, [plates, spots.length, before] as const),
  )
}

/** The bed point under a part's center, mm. */
const centerOf = (page: Page, name: string) =>
  page.evaluate((name) => {
    const e = (window as unknown as { __sx: Sx }).__sx.getState().plate.find((p) => p.name === name)!
    const m = e.transform
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const part of e.parts)
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
        const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        x0 = Math.min(x0, wx)
        x1 = Math.max(x1, wx)
        y0 = Math.min(y0, wy)
        y1 = Math.max(y1, wy)
      }
    return [(x0 + x1) / 2, (y0 + y1) / 2] as const
  }, name)

/** Presses on a part and drags it so its center would follow to bed point `to`, in steps. Leaves the button down. */
async function dragOut(page: Page, name: string, to: readonly [number, number]): Promise<void> {
  const [cx, cy] = await centerOf(page, name)
  const from = await pressable(page, await steady(page, cx, cy, SIZE / 2))
  const target = await page.evaluate(([x, y, z]) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf([x!, y!, z!]), [to[0], to[1], SIZE / 2] as const)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  const steps = 16
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((target[0] - from.x) * i) / steps, from.y + ((target[1] - from.y) * i) / steps)
  // a few more at the end, so the frame loop draws the last spot
  await page.mouse.move(target[0] + 1, target[1])
  await page.mouse.move(target[0], target[1])
}

const overlay = (page: Page) => page.getByTestId('edge-drag')
const BED = 180

test.describe('plate edge drag', () => {
  test('left, top and right add to the other plates in plate order; the band arms past the line', async ({ page }) => {
    await open(page, 4, [[90, 90]])
    const cases = [
      { side: 'left', to: [-120, 90] as const, plate: 2 },
      { side: 'top', to: [90, BED + 120] as const, plate: 3 },
      { side: 'right', to: [BED + 120, 90] as const, plate: 4 },
    ]
    for (const c of cases) {
      if ((await state(page)).shown !== 1) await pickPlate(page, 1)
      // back on plate 1 for each side: the part comes back from where the last case sent it
      await page.evaluate(([name]) => {
        const sx = (window as unknown as { __sx: Sx }).__sx
        const s = sx.getState()
        const owner = s.plates.find((p) => p.objects.some((o) => o.name === name))
        if (!owner) return
        const part = owner.objects.find((o) => o.name === name)!
        part.transform[12] = 90
        part.transform[13] = 90
        sx.setState({ plates: s.plates.map((p) => (p.id === owner.id ? { ...p, objects: [] } : p)), plate: [...s.plate, part] })
      }, ['Part 1'] as const)
      await expect.poll(async () => (await state(page)).plates[0]).toEqual(['Part 1'])
      await dragOut(page, 'Part 1', c.to)
      const label = page.getByTestId(`edge-drag-${c.side}`)
      await expect(label).toContainText(`Add to Plate ${c.plate}`)
      await expect(label).toHaveAttribute('data-armed', '')
      await expect(page.getByTestId('edge-drag-live')).toHaveText(`Release to add to Plate ${c.plate}`)
      await page.mouse.up()
      await expect.poll(async () => (await state(page)).shown, { message: `${c.side} shows plate ${c.plate}` }).toBe(c.plate)
      const s = await state(page)
      expect(s.plates[c.plate - 1]).toEqual(['Part 1'])
      expect(s.plates[0]).toEqual([])
      expect(s.selected).toEqual(['Part 1'])
      await expect(overlay(page)).toHaveCount(0)
    }
  })

  test('the bottom adds a new plate, and one undo takes the plate and the move back', async ({ page }) => {
    await open(page, 1, [[90, 90]])
    const before = await state(page)
    // one plate: only the bottom offers anything
    await dragOut(page, 'Part 1', [90, -120])
    await expect(page.getByTestId('edge-drag-bottom')).toContainText('Add to new plate')
    await expect(page.getByTestId('edge-drag-left')).toHaveCount(0)
    await expect(page.getByTestId('edge-drag-top')).toHaveCount(0)
    await expect(page.getByTestId('edge-drag-right')).toHaveCount(0)
    await expect(page.getByTestId('edge-drag-live')).toHaveText('Release to add to a new plate')
    await page.mouse.up()
    await expect.poll(async () => (await state(page)).shown).toBe(2)
    expect((await state(page)).plates).toEqual([[], ['Part 1']])
    await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 2')
    // one step back: no new plate, the part where it was, plate 1 shown
    await page.locator('.vp-canvas').first().focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await state(page)).plates).toEqual([['Part 1']])
    const after = await state(page)
    expect(after.shown).toBe(1)
    expect(after.transforms).toEqual(before.transforms)
  })

  test('a release short of the line snaps back with a hint; Esc calls a drag off past the line', async ({ page }) => {
    await open(page, 2, [[90, 90]])
    const before = await state(page)
    // half the part past the left edge, well short of the line
    await dragOut(page, 'Part 1', [0, 90])
    await expect(overlay(page)).toHaveCount(1)
    await expect(page.getByTestId('edge-drag-left')).not.toHaveAttribute('data-armed', '')
    await page.mouse.up()
    await expect(page.getByTestId('edge-drag-hint')).toHaveText('Drag past the line to move it')
    await expect.poll(async () => (await state(page)).transforms).toEqual(before.transforms)
    expect((await state(page)).plates).toEqual([['Part 1'], []])
    await expect(overlay(page)).toHaveCount(0, { timeout: 5_000 })

    // armed past the left line, then Esc: nothing moves, and the release after it is no move either
    await dragOut(page, 'Part 1', [-120, 90])
    await expect(page.getByTestId('edge-drag-left')).toHaveAttribute('data-armed', '')
    await page.keyboard.press('Escape')
    await expect(overlay(page)).toHaveCount(0)
    await page.mouse.up()
    await expect.poll(async () => (await state(page)).transforms).toEqual(before.transforms)
    const s = await state(page)
    expect(s.plates).toEqual([['Part 1'], []])
    expect(s.shown).toBe(1)
  })

  test('with five plates the top lists the rest, and a plate picked from it takes the part', async ({ page }) => {
    await open(page, 5, [[90, 90]])
    await dragOut(page, 'Part 1', [90, BED + 120])
    const top = page.getByTestId('edge-drag-top')
    await expect(top).toContainText('More plates')
    await expect(top).toHaveAttribute('data-armed', '')
    await expect(page.getByTestId('edge-drag-left')).toContainText('Add to Plate 2')
    await expect(page.getByTestId('edge-drag-right')).toContainText('Add to Plate 3')
    // a short dwell opens the list of the other plates
    const list = page.getByTestId('edge-drag-more')
    await expect(list).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveText(['Plate 4', 'Plate 5'])
    const row = await list.getByRole('listitem').nth(1).boundingBox()
    await page.mouse.move(row!.x + row!.width / 2, row!.y + row!.height / 2, { steps: 4 })
    await expect(list.getByRole('listitem').nth(1)).toHaveAttribute('data-hot', '')
    await expect(page.getByTestId('edge-drag-live')).toHaveText('Release to add to Plate 5')
    await page.mouse.up()
    await expect.poll(async () => (await state(page)).shown).toBe(5)
    expect((await state(page)).plates[4]).toEqual(['Part 1'])
  })

  test('a multi-selection goes as one group, and only once all of it is past the line', async ({ page }) => {
    await open(page, 2, [[60, 120], [120, 60]])
    await page.evaluate(() => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      const ids = sx.getState().plate.map((o) => o.id)
      sx.setState({ selection: ids[0], selectedIds: ids })
    })
    // the group's box runs 60 mm across: the pressed part past the left line, the other still on the bed
    await dragOut(page, 'Part 1', [-25, 120])
    await expect(overlay(page)).toHaveCount(1)
    await expect(page.getByTestId('edge-drag-left')).not.toHaveAttribute('data-armed', '')
    // further out, the whole group past the line
    const far = await page.evaluate(() => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf([-200, 120, 10]))
    await page.mouse.move(far[0], far[1], { steps: 8 })
    await expect(page.getByTestId('edge-drag-left')).toHaveAttribute('data-armed', '')
    await page.mouse.up()
    await expect.poll(async () => (await state(page)).shown).toBe(2)
    const s = await state(page)
    expect(s.plates).toEqual([[], ['Part 1', 'Part 2']])
    expect(s.selected).toEqual(['Part 1', 'Part 2'])
  })

  test('the view makes room: an armed part stays in sight beside both open panes, and the view eases back after', async ({ page }) => {
    await open(page, 4, [[90, 90]])
    // both side panes are open at 1440
    await expect(page.getByText('Printer and settings')).toBeVisible()
    await expect(page.getByText('Objects and slice summary')).toBeVisible()
    const id = await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id)
    const camera = () => page.evaluate(() => (window as unknown as { __vp: { camera: { position: { x: number; y: number; z: number } } } }).__vp.camera.position).then((p) => [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10))
    await settledView(page)
    const before = await camera()
    /** Where the part is drawn on screen now (its box's corners), and whether all of it is in the 3D view and on top. */
    const inSight = () =>
      page.evaluate((id) => {
        type V = { objects: Map<string, { group: { matrix: { elements: number[] } } }>; screenOf(p: number[]): [number, number]; canvas: HTMLCanvasElement }
        const vp = (window as unknown as { __vp: V }).__vp
        const e = (window as unknown as { __sx: Sx }).__sx.getState().plate.find((o) => o.id === id)!
        const m = vp.objects.get(id)!.group.matrix.elements
        const xs: number[] = []
        const ys: number[] = []
        for (const part of e.parts)
          for (let i = 0; i + 2 < part.positions.length; i += 3) {
            const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
            const s = vp.screenOf([m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!])
            xs.push(s[0])
            ys.push(s[1])
          }
        const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
        const stage = document.querySelector('.vp')!.getBoundingClientRect()
        const inside = box.x0 >= stage.left && box.x1 <= stage.right && box.y0 >= stage.top && box.y1 <= stage.bottom
        const onTop = [[(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2], [box.x0 + 2, box.y0 + 2], [box.x1 - 2, box.y1 - 2]].every(([x, y]) => document.elementFromPoint(x!, y!) === vp.canvas)
        return { box, stage: { left: stage.left, right: stage.right }, inside, onTop }
      }, id)
    for (const c of [{ side: 'right', to: [BED + 400, 90] as const }, { side: 'left', to: [-400, 90] as const }]) {
      await dragOut(page, 'Part 1', c.to)
      await expect(page.getByTestId(`edge-drag-${c.side}`)).toHaveAttribute('data-armed', '')
      // the view eases out, then the part is all in sight, not under a pane or a bar
      await expect.poll(async () => { const s = await inSight(); return s.inside && s.onTop ? 'in sight' : JSON.stringify(s) }, { message: `${c.side}: armed part in sight` }).toBe('in sight')
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(overlay(page)).toHaveCount(0)
      // and back to where it was
      await expect.poll(camera).toEqual(before)
    }
  })

  test('a move that stays on the bed is a normal move, close to the edge', async ({ page }) => {
    await open(page, 2, [[90, 90]])
    // the part's center to 6 mm inside its last spot on the bed (the transform is its corner, 10 mm from the center)
    await dragOut(page, 'Part 1', [BED - SIZE / 2 - 6, 90])
    await page.mouse.up()
    await expect.poll(async () => (await state(page)).transforms['Part 1']?.[12]).toBeGreaterThan(140)
    const s = await state(page)
    expect(s.plates).toEqual([['Part 1'], []])
    expect(s.shown).toBe(1)
    await expect(overlay(page)).toHaveCount(0)
  })
})
