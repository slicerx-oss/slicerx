// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modeling tools end to end against the geometry engine: push and pull, sketch and extrude, a hole
// cut from a sketch, the hole and thread tools, fillet, the editable history (edit, suppress, delete), kept dimensions, SVG on a
// face, and a saved project that brings history and dimensions back.
import { readFileSync } from 'node:fs'
import { type Page } from '@playwright/test'
import { bounds, command, facePick, freshBox, height, openStudio, pick, placeAt, pointsAround, pushTop, roundWall, sketchAt, steps, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type Dim = { kind: string; value?: number }
type Sx = { getState(): { plate: { id: string; name: string; dimensions?: Dim[]; history?: { steps: unknown[] } }[]; selection: string | null }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

test.describe.configure({ mode: 'parallel' })
test.skip(({ isMobile }) => isMobile, 'The modeling tools run at desktop width')

test('push and pull moves the top face, shows the step and undoes in one go', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  expect(await height(page, id)).toBe(20)
  await pushTop(page, id, 5)
  await expect.poll(() => height(page, id)).toBe(25)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
  // Pushing in cuts.
  await pushTop(page, id, -8)
  await expect.poll(() => height(page, id)).toBe(17)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => height(page, id)).toBe(25)
})

test('a push typed with a named value follows the value when it changes', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'Named values for sizes')
  const values = toolPanel(page)
  await values.getByLabel("New value's name").fill('height')
  await values.getByLabel('New value', { exact: true }).fill('3')
  await values.getByRole('button', { name: 'Add value' }).click()
  await expect(values.getByTestId('value-height')).toContainText('= 3 mm')
  await values.getByRole('button', { name: 'Done' }).click()
  await pushTop(page, id, 'height + 2')
  await expect.poll(() => height(page, id)).toBe(25)
  await expect(page.getByTestId('step-bind')).toContainText('Follows height + 2')
  await command(page, 'Named values for sizes')
  const field = toolPanel(page).getByLabel('height is')
  await field.fill('6')
  await field.press('Enter')
  await expect(toolPanel(page).getByTestId('value-height')).toContainText('= 6 mm, 1 step')
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(28)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 8 mm', state: 'done' }])
})

test('a rectangle sketched with typed sizes on the bed extrudes to a new body of that size', async ({ page }) => {
  test.slow()
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  // Typing a number opens the size field at the cursor: first the corner, then the width and height.
  await sketchAt(page, 'hover', [120, 120])
  await page.locator('body').press('5')
  const field = page.getByRole('group', { name: 'Exact size' })
  await field.getByLabel('X mm').fill('50')
  await field.getByLabel('Y mm').fill('60')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [120, 120])
  await page.locator('body').press('3')
  await field.getByLabel('Width mm').fill('30')
  await field.getByLabel('Height mm').fill('20')
  await field.getByLabel('Height mm').press('Enter')
  await panel.locator('#sk-dist').fill('10')
  const extrude = panel.getByRole('button', { name: 'Extrude' })
  await expect(extrude).toBeEnabled({ timeout: 15_000 })
  await extrude.click()
  await expect.poll(async () => (await state(page)).plate.length, { timeout: 30_000 }).toBe(1)
  const b = await bounds(page, (await state(page)).plate[0]!.id)
  const size = [0, 1, 2].map((k) => Math.round((b.max[k]! - b.min[k]!) * 100) / 100)
  expect(size).toEqual([30, 20, 10])
})

test('a circle sketched on the top face cuts a hole through the part', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  // The face's frame is centered on the face: the center is 0, 0.
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('0')
  const field = page.getByRole('group', { name: 'Exact size' })
  await field.getByLabel('X mm').fill('0')
  await field.getByLabel('Y mm').fill('0')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('8')
  await field.getByLabel('Diameter mm').press('Enter')
  await panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' }).click()
  // A cut goes into the face on its own.
  await panel.locator('#sk-dist').fill('25')
  await expect(panel.getByRole('switch', { name: 'Extrude into the face' })).toHaveAttribute('aria-checked', 'true')
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Sketch cut 25 mm', state: 'done' }])
  // The bore reaches the bottom: the mesh has points on the bed 4 mm from the face center.
  const bore = await page.evaluate(({ id, cx, cy, bottom }) => {
    type E = { id: string; transform: number[]; parts: { positions: Float32Array }[] }
    const e = (window as unknown as { __sx: { getState(): { plate: E[] } } }).__sx.getState().plate.find((p) => p.id === id)!
    const m = e.transform
    let n = 0
    for (const part of e.parts) {
      const p = part.positions
      for (let i = 0; i < p.length; i += 3) {
        const x = m[0]! * p[i]! + m[4]! * p[i + 1]! + m[8]! * p[i + 2]! + m[12]!
        const y = m[1]! * p[i]! + m[5]! * p[i + 1]! + m[9]! * p[i + 2]! + m[13]!
        const z = m[2]! * p[i]! + m[6]! * p[i + 1]! + m[10]! * p[i + 2]! + m[14]!
        if (Math.abs(z - bottom) < 0.01 && Math.abs(Math.hypot(x - cx, y - cy) - 4) < 0.05) n++
      }
    }
    return n
  }, { id, cx, cy, bottom: before.min[2] })
  expect(bore).toBeGreaterThan(8)
  expect(await height(page, id)).toBe(20)
})

test('a hole cut through the part gets its rim rounded', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('0')
  const field = page.getByRole('group', { name: 'Exact size' })
  await field.getByLabel('X mm').fill('0')
  await field.getByLabel('Y mm').fill('0')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('8')
  await field.getByLabel('Diameter mm').press('Enter')
  await panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' }).click()
  await panel.locator('#sk-dist').fill('25')
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Sketch cut 25 mm', state: 'done' }])
  const cut = await bounds(page, id)
  // A click on the top face just outside the 8 mm hole picks its rim, a round edge.
  await command(page, 'Fillet or chamfer edges')
  const tool = toolPanel(page)
  await expect(tool).toContainText('No edge yet')
  await pick(page, await facePick(page, id, [0, 0, 1], [cx + 4.3, cy, before.max[2]]))
  await expect(tool).toContainText('1 edge')
  await tool.locator('#edge-size').fill('1')
  await tool.getByRole('button', { name: 'Round' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([
    { name: 'Sketch cut 25 mm', state: 'done' },
    { name: 'Fillet 1 mm', state: 'done' },
  ])
  expect((await bounds(page, id)).triangles).toBeGreaterThan(cut.triangles)
  expect(await height(page, id)).toBe(20)
})

test('the hole tool makes a hole fit an M3 screw', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('0')
  const field = page.getByRole('group', { name: 'Exact size' })
  await field.getByLabel('X mm').fill('0')
  await field.getByLabel('Y mm').fill('0')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('8')
  await field.getByLabel('Diameter mm').press('Enter')
  await panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' }).click()
  await panel.locator('#sk-dist').fill('25')
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Sketch cut 25 mm', state: 'done' }])
  await command(page, 'Fit a hole for a screw or insert')
  const tool = toolPanel(page)
  await expect(tool).toContainText('No hole yet')
  const wall = await roundWall(page, id, [cx, cy], 4.5)
  await pick(page, wall)
  await expect(tool).toContainText('8 mm, through')
  await tool.getByRole('radiogroup', { name: 'What the hole is for' }).getByRole('radio', { name: 'Screw passes' }).click()
  await tool.locator('#hole-thread').selectOption('M3')
  await expect(tool.getByTestId('hole-size-words')).toContainText('an M3 screw passes')
  await tool.getByRole('button', { name: 'Make hole' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([
    { name: 'Sketch cut 25 mm', state: 'done' },
    { name: 'M3 clearance', state: 'done' },
  ])
  // The bore is now at least 3.4 mm across: points on the bed about 1.7 mm from its axis.
  const bore = await pointsAround(page, id, [cx, cy], before.min[2], [1.69, 1.9])
  expect(bore).toBeGreaterThan(8)
})

test('the thread tool cuts an M8 thread in a tapped hole, from the full engine', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Click the bed or a flat face')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('0')
  const field = page.getByRole('group', { name: 'Exact size' })
  await field.getByLabel('X mm').fill('0')
  await field.getByLabel('Y mm').fill('0')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [5, 0])
  await page.locator('body').press('6')
  await field.getByLabel('Diameter mm').fill('6.8')
  await field.getByLabel('Diameter mm').press('Enter')
  await panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' }).click()
  await panel.locator('#sk-dist').fill('25')
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Sketch cut 25 mm', state: 'done' }])
  await command(page, 'Cut a thread in a hole or on a rod')
  const tool = toolPanel(page)
  await expect(tool).toContainText('Nothing picked yet')
  await pick(page, await roundWall(page, id, [cx, cy], 3.9))
  await expect(tool).toContainText('Hole 6.8 mm')
  await expect(tool.locator('#thread-size')).toHaveValue('M8')
  await expect(tool.getByTestId('thread-words')).toContainText('M8 x 1.25 in the hole')
  await tool.getByRole('button', { name: 'Cut thread' }).click()
  await expect.poll(() => steps(page), { timeout: 60_000 }).toEqual([
    { name: 'Sketch cut 25 mm', state: 'done' },
    { name: 'M8 thread', state: 'done' },
  ])
  // The thread's roots reach out to the major diameter and a little more: points on the bed 4 to 4.3 mm out.
  expect(await pointsAround(page, id, [cx, cy], before.min[2], [4.0, 4.3])).toBeGreaterThan(8)
})

test('the shell tool hollows a box with its top left open, from the full engine', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  await command(page, 'Shell: hollow with faces left open')
  const tool = toolPanel(page)
  await expect(tool).toContainText('Click the flat faces to leave open')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(tool).toContainText('1 open face')
  await tool.locator('#shell-wall').fill('2')
  await tool.getByRole('button', { name: 'Make shell' }).click()
  await expect.poll(() => steps(page), { timeout: 60_000 }).toEqual([{ name: 'Shell, 2 mm walls, 1 open face', state: 'done' }])
  // The outside is unchanged and the box is open at the top: the floor inside sits 2 mm up, inside the walls.
  const after = await bounds(page, id)
  expect(after.max[2]).toBeCloseTo(before.max[2], 3)
  expect(after.triangles).toBeGreaterThan(before.triangles)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  expect(await pointsAround(page, id, [cx, cy], before.min[2] + 2, [0, 0.7 * (before.max[0] - before.min[0])])).toBeGreaterThan(3)
})

test('fillet rounds one edge and adds a history step', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  // A spot where the engine finds the faces at the edge ends; see the expected failure below for one where it does not.
  await placeAt(page, 100, 100)
  const b = await bounds(page, id)
  await command(page, 'Fillet or chamfer edges')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No edge yet')
  // A click on the top face next to its +X edge picks that edge.
  await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
  await expect(panel).toContainText('1 edge')
  await panel.locator('#edge-size').fill('2')
  await panel.getByRole('button', { name: 'Round' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Fillet 2 mm', state: 'done' }])
  const after = await bounds(page, id)
  expect(after.triangles).toBeGreaterThan(b.triangles)
  expect(await height(page, id)).toBe(20)
})

test('editing an earlier step replays the steps after it; suppress and delete work', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  await placeAt(page, 100, 100)
  await pushTop(page, id, 5)
  await expect.poll(() => height(page, id)).toBe(25)
  const b = await bounds(page, id)
  await command(page, 'Fillet or chamfer edges')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No edge yet')
  await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
  await expect(panel).toContainText('1 edge')
  await panel.locator('#edge-size').fill('2')
  await panel.getByRole('button', { name: 'Round' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 5 mm', state: 'done' }, { name: 'Fillet 2 mm', state: 'done' }])
  await panel.getByRole('button', { name: 'Done' }).click()
  const filleted = (await bounds(page, id)).triangles

  // Step 1 opens in the push tool with the part as it was before it; a new distance replays the fillet.
  await page.getByRole('button', { name: 'Edit Pull 5 mm' }).click()
  await expect(toolPanel(page)).toContainText('Editing step 1')
  await toolPanel(page).locator('#push-dist').fill('10')
  await toolPanel(page).getByRole('button', { name: 'Pull out' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }, { name: 'Fillet 2 mm', state: 'done' }])
  await expect.poll(() => height(page, id)).toBe(30)
  // The fillet ran again on the taller box (a plain box has 12 triangles).
  expect((await bounds(page, id)).triangles).toBeGreaterThan(12)
  expect(filleted).toBeGreaterThan(12)

  // Suppressing the pull drops it. The fillet's edge was on the pulled top, so that step breaks and says why.
  await page.getByRole('button', { name: 'Suppress Pull 10 mm' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'suppressed' }, { name: 'Fillet 2 mm', state: 'broken' }])
  await expect(page.locator('.cad-step[data-state=broken] .cad-step-why')).not.toBeEmpty()
  await expect.poll(() => height(page, id)).toBe(20)
  await page.getByRole('button', { name: 'Turn Pull 10 mm back on' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }, { name: 'Fillet 2 mm', state: 'done' }])
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(30)
  const withFillet = (await bounds(page, id)).triangles

  // Deleting the fillet leaves a square box 30 mm high: fewer triangles than with the round.
  await page.getByRole('button', { name: 'Delete Fillet 2 mm' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }])
  await expect.poll(async () => (await bounds(page, id)).triangles).toBeLessThan(withFillet)
  expect(await height(page, id)).toBe(30)
})

/** Measures the box from its top to its bottom face and keeps the distance. */
async function keepHeight(page: Page, id: string): Promise<void> {
  await command(page, 'Measure distance, angle and radius')
  const panel = toolPanel(page)
  await expect(panel).toContainText('Nothing picked')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('One pick')
  await pick(page, await facePick(page, id, [0, 0, -1]))
  await expect(panel).toContainText('Between two picks')
  await panel.getByRole('button', { name: 'Keep this dimension' }).click()
  await expect.poll(async () => (await state(page)).plate.find((p) => p.id === id)?.dimensions?.map((d) => [d.kind, Math.round((d.value ?? 0) * 100) / 100])).toEqual([['distance', 20]])
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ objectTool: null }))
}

test('a kept dimension follows a push of its face', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  await keepHeight(page, id)
  await pushTop(page, id, 5)
  await expect.poll(async () => (await state(page)).plate.find((p) => p.id === id)?.dimensions?.map((d) => Math.round((d.value ?? 0) * 100) / 100), { timeout: 30_000 }).toEqual([25])
})

test('a saved project opens again with its history and dimensions', async ({ page }) => {
  test.slow()
  await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await openStudio(page)
  const id = await freshBox(page)
  await keepHeight(page, id)
  await pushTop(page, id, 5)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  const bytes = [...readFileSync(await download.path())]
  const name = download.suggestedFilename()

  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await page.evaluate(({ name, bytes }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], name))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { name, bytes })
  const discard = page.getByRole('button', { name: /^(Discard|Don't save|Open without saving)/ })
  await discard.click({ timeout: 3000 }).catch(() => undefined)
  await expect.poll(async () => (await state(page)).plate.length, { timeout: 30_000 }).toBe(1)
  const opened = (await state(page)).plate[0]!
  expect(opened.history?.steps.length).toBe(1)
  expect(opened.dimensions?.map((d) => [d.kind, Math.round((d.value ?? 0) * 100) / 100])).toEqual([['distance', 25]])
  expect(await height(page, opened.id)).toBe(25)
  await page.evaluate((oid) => (window as unknown as { __sx: Sx }).__sx.setState({ selection: oid, selectedIds: [oid] }), opened.id)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
  // The step can still be edited after the reopen.
  await page.getByRole('button', { name: 'Edit Pull 5 mm' }).click()
  await toolPanel(page).locator('#push-dist').fill('2')
  await toolPanel(page).getByRole('button', { name: 'Pull out' }).click()
  await expect.poll(() => height(page, opened.id), { timeout: 30_000 }).toBe(22)
})

test('an SVG outline on the top face joins as a raised shape', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'SVG outline on a face')
  const panel = toolPanel(page)
  await expect(panel.locator('#cad-svg')).toBeAttached()
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await panel.locator('#cad-svg').setInputFiles({ name: 'star.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0 L6.2 3.8 L10 3.8 L7 6.2 L8.1 10 L5 7.6 L1.9 10 L3 6.2 L0 3.8 L3.8 3.8 Z"/></svg>') })
  await panel.locator('#cad-w').fill('12')
  await panel.locator('#cad-dist').fill('3')
  await panel.getByRole('button', { name: 'Join' }).click()
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(23)
  const steps = (await state(page)).plate.find((p) => p.id === id)?.history?.steps ?? []
  expect(steps).toHaveLength(1)
})

// The fillet engine matches the picked edge to the mesh within 0.001 mm, so an edge is found wherever
// the box stands (it used to miss at some positions after the JSON round trip).
test('fillet works on a box edge wherever the box stands', async ({ page }) => {
  test.slow()
  await openStudio(page)
  const id = await freshBox(page)
  await placeAt(page, 37.4333333, 12.7666667)
  const b = await bounds(page, id)
  await command(page, 'Fillet or chamfer edges')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No edge yet')
  await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
  await expect(panel).toContainText('1 edge')
  await panel.locator('#edge-size').fill('2')
  await expect(panel.getByRole('button', { name: 'Round' })).toBeEnabled({ timeout: 15_000 })
  await expect(panel).not.toContainText('faces meet')
  await panel.getByRole('button', { name: 'Round' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Fillet 2 mm', state: 'done' }])
})
