// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modeling tools end to end against the geometry engine, on one page: push and pull, sketch and extrude, a hole
// cut from a sketch, the hole and thread tools, fillet, shell, patterns, the editable history (edit, suppress, delete),
// kept dimensions, SVG on a face and a saved project that brings history and dimensions back. Then the Model views of
// that history: the design timeline and its marker, display units, the tree (menus, filter, rollback), the inspector,
// the ribbon and its menus, the tool footer, the handoffs between Design and Slice, and the push and operation previews
// in the view. The phone legs of the previews are in phone-cad.spec.ts.
//
// Every test builds its own part first (`studio` empties the plate and puts the look back), so tests do not depend on
// the order they run in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Locator, type Page } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { addMenu, sliceCount, sliced, tab } from '../fixtures'
import { openStudio } from '../cad-helpers'
import {
  bounds, circleCut, clickStepButton, command, designTab, emptyPlate, facePick, framedBox, freshBox, height, pick, pickThenPush, placeAt, pointsAround, pushTop, roundWall,
  shown, sketchAt, steps, store, studio, toolPanel, topMiddle, type Shown,
} from './lib/cad'

test.skip(({ isMobile }) => isMobile, 'The modeling tools run at desktop width; the phone legs are in phone-cad.spec.ts')

type Dim = { kind: string; value?: number }
type Sx = { getState(): { plate: { id: string; name: string; dimensions?: Dim[]; history?: { steps: unknown[] } }[]; selection: string | null }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

// -------------------------------------------------------------------------------------------------------------
// The tools
// -------------------------------------------------------------------------------------------------------------

test('push and pull moves the top face, shows the step and undoes in one go', async ({ page }) => {
  test.slow()
  await studio(page)
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
  await studio(page)
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
  await studio(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  // Typing a number opens the size field at the cursor: first the corner, then the width and height.
  await sketchAt(page, 'hover', [120, 120])
  await page.locator('body').press('5')
  const field = page.getByRole('group', { name: 'Exact size' })
  // the size of the shape after its first point: the boxes on the shape
  const sizes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  await field.getByLabel('X mm').fill('50')
  await field.getByLabel('Y mm').fill('60')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [120, 120])
  await page.locator('body').press('3')
  await sizes.getByLabel('Width mm').fill('30')
  await sizes.getByLabel('Height mm').fill('20')
  await sizes.getByLabel('Height mm').press('Enter')
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
  await studio(page)
  const { id, before, cx, cy } = await circleCut(page, '8')
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
  await studio(page)
  const { id, before, cx, cy } = await circleCut(page, '8')
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
  await studio(page)
  const { id, before, cx, cy } = await circleCut(page, '8')
  await command(page, 'Fit a hole for a screw or insert')
  const tool = toolPanel(page)
  await expect(tool).toContainText('No hole yet')
  const wall = await roundWall(page, id, [cx, cy], 4.5)
  await pick(page, wall)
  await expect(tool).toContainText('8 mm, through')
  await tool.getByRole('combobox', { name: 'What the hole is for' }).selectOption('clearance')
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
  await studio(page)
  const { id, before, cx, cy } = await circleCut(page, '6.8')
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
  await studio(page)
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

test('a hole repeated round a circle is one step with every copy cut', async ({ page }) => {
  test.slow()
  await studio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  const cx = (before.min[0] + before.max[0]) / 2
  const cy = (before.min[1] + before.max[1]) / 2
  await command(page, 'Shape on a face: rectangle, circle, slot or polygon')
  const tool = toolPanel(page)
  await expect(tool).toContainText('No face yet')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(tool).toContainText('A face of')
  await tool.locator('#cad-shape').selectOption('circle')
  await tool.locator('#cad-dia').fill('3')
  const center = tool.getByRole('group', { name: 'Shape center' })
  await center.getByRole('textbox', { name: /X/ }).fill('5')
  await center.getByRole('textbox', { name: /Y/ }).fill('0')
  await tool.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' }).click()
  await tool.locator('#cad-dist').fill(String(before.max[2] - before.min[2]))
  await tool.getByRole('combobox', { name: 'Pattern' }).selectOption('circle')
  await tool.locator('#pat-count').fill('4')
  await tool.getByRole('button', { name: 'Cut' }).click()
  await expect.poll(() => steps(page), { timeout: 60_000 }).toEqual([{ name: 'Hole 3 mm, 4 copies', state: 'done' }])
  // Four round holes 5 mm from the middle reach the bed: their rims there, 3.5 to 6.5 mm out (one hole alone has
  // about 10 such points).
  expect(await pointsAround(page, id, [cx, cy], before.min[2], [3.4, 6.6])).toBeGreaterThan(30)
})

test('fillet rounds one edge and adds a history step', async ({ page }) => {
  test.slow()
  await studio(page)
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
  await studio(page)
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
  await expect(panel).toHaveCount(0)
  const filleted = (await bounds(page, id)).triangles

  // Step 1 opens in the push tool with the part as it was before it; a new distance replays the fillet.
  await page.getByRole('button', { name: 'Edit Pull 5 mm' }).click()
  await expect(toolPanel(page).getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
  await toolPanel(page).locator('#push-dist').fill('10')
  await toolPanel(page).getByRole('button', { name: 'Pull out' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }, { name: 'Fillet 2 mm', state: 'done' }])
  await expect.poll(() => height(page, id)).toBe(30)
  // The fillet ran again on the taller box (a plain box has 12 triangles).
  expect((await bounds(page, id)).triangles).toBeGreaterThan(12)
  expect(filleted).toBeGreaterThan(12)

  // Suppressing the pull keeps the original cap and wall identities, so the fillet follows their edge back.
  const edgeKeys = async () => ((await state(page)).plate.find((p) => p.id === id)?.history?.steps[1] as { params: { edges: { keys?: number[] }[] } }).params.edges[0]?.keys
  const selectedKeys = await edgeKeys()
  expect(selectedKeys).toHaveLength(2)
  await clickStepButton(page, 'Pull 10 mm', 'Suppress Pull 10 mm')
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'suppressed' }, { name: 'Fillet 2 mm', state: 'done' }])
  await expect.poll(() => height(page, id)).toBe(20)
  expect((await bounds(page, id)).triangles).toBeGreaterThan(12)
  expect(await edgeKeys()).toEqual(selectedKeys)
  await clickStepButton(page, 'Pull 10 mm', 'Turn Pull 10 mm back on')
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }, { name: 'Fillet 2 mm', state: 'done' }])
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(30)
  const withFillet = (await bounds(page, id)).triangles

  // Deleting the fillet leaves a square box 30 mm high: fewer triangles than with the round.
  await clickStepButton(page, 'Fillet 2 mm', 'Delete Fillet 2 mm')
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
  await studio(page)
  const id = await freshBox(page)
  await keepHeight(page, id)
  await pushTop(page, id, 5)
  await expect.poll(async () => (await state(page)).plate.find((p) => p.id === id)?.dimensions?.map((d) => Math.round((d.value ?? 0) * 100) / 100), { timeout: 30_000 }).toEqual([25])
})

test('a saved project opens again with its history and dimensions', async ({ page }) => {
  test.slow()
  // Save falls back to a download when the browser has no save picker.
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await studio(page)
  const id = await freshBox(page)
  await keepHeight(page, id)
  await pushTop(page, id, 5)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
  // Push and pull opened Design; Export is in Slice.
  await tab(page, 'prepare').click()
  await addMenu(page, 'Export')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  const bytes = [...readFileSync(await download.path())]
  const name = download.suggestedFilename()

  await emptyPlate(page)
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
  await studio(page)
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

test('text on a face says when it is wider than the face, and the letter height it suggests fits', async ({ page }) => {
  test.slow()
  await studio(page)
  const id = await freshBox(page)
  const before = await bounds(page, id)
  await command(page, 'Text on a face')
  const panel = toolPanel(page)
  // the middle of the top face, so text that fits the face's size stays on it
  await pick(page, await facePick(page, id, [0, 0, 1], [(before.min[0] + before.max[0]) / 2, (before.min[1] + before.max[1]) / 2, before.max[2]]))
  await expect(panel).toContainText('A face of')
  await panel.locator('#cad-text').fill('SlicerX')
  await panel.locator('#cad-size').fill('8')
  // Before Apply: both widths and a size that fits; Join stays on, as text may run onto a wall beside the face
  const fit = panel.getByTestId('text-fit')
  await expect(fit).toHaveText(/The text is [\d.]+ mm wide; the face is 20 mm\. A letter height of [\d.]+ mm fits\.$/)
  const [, wide, suggested] = /The text is ([\d.]+) mm wide.*A letter height of ([\d.]+) mm fits/.exec(await fit.innerText())!
  expect(Number(wide)).toBeGreaterThan(20)
  expect(Number(suggested)).toBeLessThan(8)
  await expect(panel.getByRole('button', { name: 'Join' })).toBeEnabled()
  await panel.getByTestId('text-fit-use').click()
  await expect(panel.locator('#cad-size')).toHaveValue(suggested!)
  await expect(fit).toHaveCount(0)
  await panel.getByRole('button', { name: 'Join' }).click()
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(20.6)
  // the text stays on the face: the body is no wider or deeper than before
  const after = await bounds(page, id)
  for (const k of [0, 1]) {
    expect(after.min[k]).toBeCloseTo(before.min[k]!, 3)
    expect(after.max[k]).toBeCloseTo(before.max[k]!, 3)
  }
  expect((await state(page)).plate.find((p) => p.id === id)?.history?.steps ?? []).toHaveLength(1)
})

// The fillet engine matches the picked edge to the mesh within 0.001 mm, so an edge is found wherever
// the box stands (it used to miss at some positions after the JSON round trip).
test('fillet works on a box edge wherever the box stands', async ({ page }) => {
  test.slow()
  await studio(page)
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

// -------------------------------------------------------------------------------------------------------------
// The history views: timeline, units, tree, inspector
// -------------------------------------------------------------------------------------------------------------

test('the marker rolls every body back, Slice says so, and Move to the end and undo bring it back', async ({ page }) => {
  await studio(page)
  const ids = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate.map((e) => e.id))
  const marker = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { marker: number } } } }).__sx.getState().timeline.marker)
  const a = await freshBox(page)
  await designTab(page)
  await pushTop(page, a, 5)
  await command(page, 'Add a box')
  await expect.poll(async () => (await ids()).length).toBe(2)
  const b = (await ids()).find((x) => x !== a)!
  await pushTop(page, b, 3)
  await expect.poll(() => height(page, a)).toBeCloseTo(25, 3)
  await expect.poll(() => height(page, b)).toBeCloseTo(23, 3)

  await page.getByRole('button', { name: 'Open Timeline' }).click()
  const chips = page.locator('.tl-chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveAttribute('aria-label', /Pull 5 mm, on Box/)
  await expect(chips.nth(1)).toHaveAttribute('aria-label', /Pull 3 mm, on Box/)

  // one back: the second box loses its pull, the first keeps its own
  await page.getByTestId('tl-marker').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('tl-rolled')).toHaveText('Rolled back to 1 of 2')
  await expect.poll(() => height(page, b)).toBeCloseTo(20, 3)
  await expect.poll(() => height(page, a)).toBeCloseTo(25, 3)
  await expect(chips.nth(1)).toHaveAttribute('data-later', 'true')

  // Slice says what it slices
  await page.getByTestId('tab-prepare').click()
  const note = page.getByTestId('rolled-back')
  await expect(note).toContainText('The timeline is rolled back to step 1. Slicing uses this state.')
  await note.getByRole('button', { name: 'Move to the end' }).click()
  await expect(note).toHaveCount(0)
  await expect.poll(() => height(page, b)).toBeCloseTo(23, 3)

  // undo puts the marker back where it was, then back at the end
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(marker).toBe(1)
  await expect.poll(() => height(page, b)).toBeCloseTo(20, 3)
  await expect(page.getByTestId('rolled-back')).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(marker).toBe(2)
  await expect.poll(() => height(page, b)).toBeCloseTo(23, 3)
})

test('inches: a typed 1" pulls 25.4 mm and shows as 1.000 in; mm shows the same step as 25.4 mm', async ({ page }) => {
  type U = { __sx: { getState(): { plate: { history?: { steps: { params: { distanceMm?: number } }[] } }[]; units: { length: string } }; setState(p: unknown): void } }
  const history = () => page.evaluate(() => JSON.stringify((window as unknown as U).__sx.getState().plate.map((e) => e.history ?? null)))
  await studio(page)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: /Slicing and modeling|Modeling/ }).first().click()
  await dialog.getByTestId('set-units-in').click()
  await expect.poll(() => page.evaluate(() => (window as unknown as U).__sx.getState().units.length)).toBe('in')
  await expect(dialog.getByTestId('set-precision-pick')).toHaveValue('d3')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const id = await freshBox(page)
  await command(page, 'Push or pull a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No face yet')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face is picked')
  await expect(panel.locator('label[for="push-dist"] .cad-num-unit')).toHaveText('in')
  await panel.locator('#push-dist').fill('1"')
  await expect(panel).toContainText('Adds 1.000 in')
  // the folded Transform line keeps the precision's three decimals
  await expect(page.getByTestId('model-transform-summary')).toHaveText(/^X -?\d+\.\d{3} Y -?\d+\.\d{3} Z -?\d+\.\d{3} in$/)
  // and stays inside the panel
  const line = await page.getByTestId('model-transform-summary').boundingBox()
  const pane = await page.getByRole('complementary', { name: 'Tool and transform' }).boundingBox()
  expect(line!.x + line!.width).toBeLessThanOrEqual(pane!.x + pane!.width)
  // the full line is the toggle's tooltip, and the line lets clicks through to it
  await expect(page.locator('#model-transform')).toHaveAttribute('data-tip-body', /^X -?\d+\.\d{3} Y .* in$/)
  await panel.getByRole('button', { name: 'Pull out' }).click()
  await expect(panel).toHaveCount(0, { timeout: 30_000 })

  await expect.poll(() => height(page, id)).toBeCloseTo(45.4, 3)
  const mm = await page.evaluate(() => (window as unknown as U).__sx.getState().plate[0]!.history!.steps[0]!.params.distanceMm)
  expect(mm).toBeCloseTo(25.4, 9)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 1.000 in', state: 'done' }])
  await expect(page.getByLabel('Model size')).toContainText('0.787 x 0.787 x 1.787 in')
  // Transform's position is in inches too
  await expect(page.getByRole('textbox', { name: 'Position X, in' })).toBeVisible()

  // the step opens with its distance in inches
  await page.getByRole('button', { name: 'Edit Pull 1.000 in' }).click()
  await expect(toolPanel(page).locator('#push-dist')).toHaveValue('1.000')
  await toolPanel(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(toolPanel(page)).toHaveCount(0)

  // back to mm: the same data, shown in mm
  const before = await history()
  await page.evaluate(() => (window as unknown as U).__sx.setState({ units: { length: 'mm', mmDigits: 2, inchDigits: 3, inchFraction: 0 } }))
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 25.4 mm', state: 'done' }])
  expect(await history()).toBe(before)
})

/** A box with two pulls on it, selected in the tree, in Design. */
async function twoPulls(page: Page): Promise<string> {
  const id = await freshBox(page)
  await designTab(page)
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  await pushTop(page, id, 5)
  await pushTop(page, id, 3)
  await expect.poll(() => steps(page)).toEqual([
    { name: 'Pull 5 mm', state: 'done' },
    { name: 'Pull 3 mm', state: 'done' },
  ])
  return id
}

test('Model tree menus: roll to a step and back, Shift+F10 and Escape, and rename an object and a step', async ({ page }) => {
  await studio(page)
  await twoPulls(page)
  const first = page.getByTestId('model-tree-step').first()
  await first.click({ button: 'right', position: { x: 60, y: 10 } })
  const menu = page.getByTestId('model-ctx')
  await expect(menu).toHaveAttribute('data-target', 'step')
  await menu.getByTestId('model-ctx-roll').click()
  await expect(page.getByTestId('model-tree-step').nth(1)).toHaveAttribute('data-later', 'true')
  await first.click({ button: 'right', position: { x: 60, y: 10 } })
  await menu.getByTestId('model-ctx-end').click()
  await expect(page.locator('[data-testid="model-tree-step"][data-later]')).toHaveCount(0)

  // The keyboard's right click, and focus back on the row after Escape.
  const name = first.locator('.cad-step-name')
  await name.focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(first).toBeFocused()

  // Rename the step with F2, and the object from its menu.
  await page.keyboard.press('F2')
  const field = page.getByTestId('model-tree-rename')
  await field.fill('Base boss')
  await field.press('Enter')
  await expect(first.locator('.cad-step-label')).toHaveText('Base boss')
  await page.locator('.dtree-name', { hasText: 'Box' }).click({ button: 'right' })
  await expect(menu).toHaveAttribute('data-target', 'object')
  await menu.getByTestId('model-ctx-rename').click()
  await field.fill('Bracket')
  await field.press('Enter')
  await expect(page.locator('.dtree-name', { hasText: 'Bracket' })).toBeVisible()
})

test('Model tree filter and rollback: type to filter, then roll back with the keys', async ({ page }) => {
  await studio(page)
  await twoPulls(page)
  // Typing in the tree opens the filter with that letter.
  await page.locator('.dtree-name', { hasText: 'Box' }).focus()
  await page.keyboard.type('3 mm')
  const filter = page.getByTestId('model-tree-filter')
  await expect(filter).toHaveValue('3 mm')
  await expect(page.getByTestId('model-tree-step')).toHaveCount(1)
  await expect(page.getByTestId('model-tree-step')).toContainText('Pull 3 mm')
  await filter.fill('nothing like it')
  await expect(page.getByText('Nothing matches "nothing like it"')).toBeVisible()
  await filter.press('Escape')
  await expect(filter).toHaveCount(0)
  await expect(page.getByTestId('model-tree-step')).toHaveCount(2)

  // Roll back to step 1 from its menu, then move the row with the keys.
  await page.getByTestId('model-tree-step').first().click({ button: 'right', position: { x: 60, y: 10 } })
  await page.getByTestId('model-ctx-roll').click()
  const row = page.getByTestId('model-tree-rollback')
  await expect(row).toHaveAttribute('aria-valuenow', '1')
  await row.focus()
  await page.keyboard.press('End')
  await expect(row).toHaveCount(0)
  await expect(page.locator('[data-testid="model-tree-step"][data-later]')).toHaveCount(0)
})

test('Model tree: a hover does not move the step name, and More holds the step actions', async ({ page }) => {
  await studio(page)
  const id = await freshBox(page)
  await designTab(page)
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  await pushTop(page, id, 5)
  await expect.poll(() => steps(page)).toEqual([{ name: 'Pull 5 mm', state: 'done' }])
  const row = page.getByTestId('model-tree-step').first()
  const label = row.locator('.cad-step-label')
  const more = row.getByTestId('model-tree-more')
  await page.mouse.move(700, 450)
  await expect(more).toHaveCSS('opacity', '0')
  const before = await label.boundingBox()
  await row.hover()
  await expect(more).toHaveCSS('opacity', '1')
  expect(await label.boundingBox()).toEqual(before)
  await more.click()
  await expect(page.getByTestId('model-ctx')).toHaveAttribute('data-target', 'step')
  await page.keyboard.press('Escape')
  // The closed menu hands focus back to More; the keyboard walk starts after that.
  await expect(page.getByTestId('model-ctx')).toHaveCount(0)
  await expect(more).toBeFocused()

  // The keyboard: the object is the row Tab reaches, Down goes to the step.
  const name = page.locator('.dtree-name', { hasText: 'Box' })
  await name.focus()
  await page.keyboard.press('ArrowDown')
  await expect(row.locator('.cad-step-name')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(name).toBeFocused()
})

test('Model inspector: Transform folds under a tool, and a step being edited names the object and the step', async ({ page }) => {
  await studio(page)
  const id = await freshBox(page)
  await designTab(page)
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  // No tool: Transform shows whole.
  await expect(page.getByTestId('model-inspector').locator('.tf')).toBeVisible()
  await command(page, 'Push or pull a face')
  await expect(toolPanel(page)).toBeVisible()
  const summary = page.getByTestId('model-transform-summary')
  await expect(summary).toHaveText(/^X [-\d.]+ Y [-\d.]+ Z [-\d.]+ mm$/)
  await expect(page.locator('#model-transform')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('model-inspector').locator('.tf')).toHaveCount(0)
  await page.locator('#model-transform').click()
  await expect(page.getByTestId('model-inspector').locator('.tf')).toBeVisible()
  await page.keyboard.press('Escape')
  // Editing the pull: the header reads "Box › Pull 5 mm".
  await pushTop(page, id, 5)
  await page.keyboard.press('Escape')
  await page.getByTestId('model-tree-step').first().locator('[data-tree-row]').click()
  await expect(page.getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
})

test('Model inspector: two objects selected show together, and a name picks one alone', async ({ page }) => {
  await studio(page)
  await freshBox(page)
  await command(page, 'Add a box')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.length)).toBe(2)
  await designTab(page)
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: Sx }).__sx
    const ids = sx.getState().plate.map((p) => p.id)
    sx.setState({ selection: ids[0], selectedIds: ids })
  })
  const multi = page.getByTestId('model-inspector-multi')
  await expect(multi).toContainText('2 objects')
  await expect(page.getByTestId('model-multi-size')).toHaveText(/^Together [\d.]+ x [\d.]+ x [\d.]+ mm$/)
  await expect(page.getByTestId('model-multi-object')).toHaveCount(2)
  await page.getByTestId('model-multi-object').nth(1).click()
  await expect(multi).toHaveCount(0)
  await expect(page.getByTestId('model-inspector').locator('.tf')).toBeVisible()
})

test('Model inspector: a position of -123.4 fits its field whole', async ({ page }) => {
  await studio(page)
  await freshBox(page)
  await designTab(page)
  const fields = page.getByTestId('model-inspector').locator('.tf-row').first().locator('.sx-scrub-input')
  for (const i of [0, 1]) {
    await fields.nth(i).fill('-123.4')
    await fields.nth(i).press('Enter')
    await expect(fields.nth(i)).toHaveValue('-123.4')
  }
  const fit = await fields.evaluateAll((els) =>
    (els as HTMLInputElement[]).map((el) => {
      const cs = getComputedStyle(el)
      const c = document.createElement('canvas').getContext('2d')!
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      return c.measureText(el.value).width <= el.clientWidth
    }),
  )
  expect(fit).toEqual([true, true, true])
})

// -------------------------------------------------------------------------------------------------------------
// The ribbon
// -------------------------------------------------------------------------------------------------------------

type Size = 'large' | 'medium' | 'small'
const PX: Record<Size, number> = { large: 32, medium: 24, small: 16 }

/** Every visible ribbon button's box, rounded to a tenth of a pixel. */
const boxes = (ribbon: Locator) =>
  ribbon.evaluate((r) =>
    [...r.querySelectorAll<HTMLElement>('button')]
      .filter((b) => b.offsetParent !== null && getComputedStyle(b).visibility !== 'hidden')
      .map((b) => {
        const x = b.getBoundingClientRect()
        return [b.getAttribute('aria-label') ?? b.textContent ?? '', Math.round(x.left * 10) / 10, Math.round(x.top * 10) / 10, Math.round(x.width * 10) / 10, Math.round(x.height * 10) / 10] as const
      }),
  )

/** No two visible buttons overlap, every one is inside the ribbon's row, and the row does not scroll. */
async function fits(ribbon: Locator): Promise<void> {
  // polled: the next slot finds out it has no room one frame after it shows
  await expect.poll(() => ribbon.evaluate((el) => {
    const body = el.querySelector<HTMLElement>('.rb-body')!
    const b = body.getBoundingClientRect()
    const btns = [...body.querySelectorAll<HTMLElement>('button')].filter((x) => x.offsetParent !== null && getComputedStyle(x).visibility !== 'hidden').map((x) => x.getBoundingClientRect())
    let overlaps = 0
    for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
      const p = btns[i]!, q = btns[j]!
      if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) overlaps++
    }
    const out = btns.filter((x) => x.right > b.right + 0.5 || x.left < b.left - 0.5 || x.bottom > b.bottom + 0.5).length
    return { overlaps, out, scrolls: body.scrollWidth > body.clientWidth + 1 }
  }), { timeout: 3000 }).toEqual({ overlaps: 0, out: 0, scrolls: false })
}

/** Waits until the ribbon has taken its width and says how it fits (names, icons) for it. */
async function ribbonSettled(ribbon: Locator): Promise<void> {
  let last = ''
  let still = 0
  await expect
    .poll(async () => {
      const now = `${(await ribbon.getAttribute('data-fit')) ?? ''} ${Math.round((await ribbon.boundingBox())?.width ?? 0)}`
      still = now === last ? still + 1 : 0
      last = now
      return still >= 3
    }, { intervals: [150], timeout: 10_000 })
    .toBe(true)
}

/** The Design half open at `width`, the ribbon at toolbar `size`. The page goes back to its look in the next `studio`. */
async function openModel(page: Page, size: Size, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 900 })
  const appearance = (await store(page))['appearance'] as Record<string, unknown>
  await page.evaluate((appearance) => (window as unknown as { __sx: Sx }).__sx.setState({ appearance }), { ...appearance, toolbarSize: size })
  await designTab(page)
  const ribbon = page.getByTestId('model-shelf')
  await expect(ribbon).toBeVisible()
  await expect(ribbon).toHaveAttribute('data-setting', size)
  await ribbonSettled(ribbon)
  return ribbon
}

for (const width of [1440, 1280]) {
  for (const size of ['large', 'medium', 'small'] as const) {
    test(`Model ribbon ${size} at ${width} px: drawn at its size, the same height on every tab, nothing moves on press or hover`, async ({ page }) => {
      await studio(page)
      const ribbon = await openModel(page, size, width)
      const fit = await ribbon.getAttribute('data-fit')
      const px = fit === 'icons' ? 16 : PX[size]
      // icons at the size's grid; names under them unless Small (or the row ran out of room)
      expect(await ribbon.locator('.rb-body svg.ti').first().getAttribute('width')).toBe(String(px))
      await expect(ribbon.locator('[data-tool="push"] .rb-label')).toBeVisible({ visible: size !== 'small' && fit === 'labels' })
      await expect(ribbon.locator('[data-tool="push"]')).toHaveAttribute('data-tip-title', 'Push and pull')
      await fits(ribbon)

      // every tab: the same ribbon height, the tabs and undo/redo in place
      const height = (await ribbon.boundingBox())!.height
      const fixed = () => ribbon.locator('.rb-tabs').evaluate((t) => [...t.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left * 10), Math.round(r.top * 10), Math.round(r.width * 10)] }))
      const tabsBefore = await fixed()
      for (const t of ['mesh', 'sketch', 'solid'] as const) {
        await page.getByTestId(`ribbon-tab-${t}`).click()
        await expect(page.getByTestId(`ribbon-tab-${t}`)).toHaveAttribute('aria-selected', 'true')
        expect((await ribbon.boundingBox())!.height, t).toBeCloseTo(height, 1)
        expect(await fixed(), t).toEqual(tabsBefore)
        await fits(ribbon)
      }

      // hover, then press: no button moves or changes size
      const before = await boxes(ribbon)
      await ribbon.locator('[data-tool="fillet"]').hover()
      expect(await boxes(ribbon)).toEqual(before)
      await ribbon.locator('[data-tool="measure"]').click()
      await expect(ribbon.locator('[data-tool="measure"]')).toHaveAttribute('aria-pressed', 'true')
      expect(await boxes(ribbon)).toEqual(before)
      await page.keyboard.press('Escape')
    })
  }
}

test('the Toolbar size row in Settings changes the ribbon at once', async ({ page }) => {
  await studio(page)
  const ribbon = await openModel(page, 'large', 1440)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
  const row = dialog.getByTestId('set-toolbar-size')
  await expect(row).toContainText('32 px')
  await row.getByRole('radio', { name: 'Small' }).click()
  await expect(ribbon).toHaveAttribute('data-setting', 'small')
  expect(await ribbon.locator('.rb-body svg.ti').first().getAttribute('width')).toBe('16')
  await row.getByRole('radio', { name: 'Medium' }).click()
  await expect(ribbon).toHaveAttribute('data-setting', 'medium')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('each ribbon tab shows each tool once, with an object picked too, and Solid has Extrude', async ({ page }) => {
  await studio(page)
  const ribbon = await openModel(page, 'large', 1440)
  // every button in the row, by the tool, action or menu it opens
  const ids = () => ribbon.locator('.rb-body').evaluate((b) => [...b.querySelectorAll<HTMLElement>('button')].map((x) => x.dataset['tool'] ?? x.dataset['action'] ?? x.dataset['testid'] ?? x.getAttribute('aria-label') ?? ''))
  const once = async (tab: string) => {
    const all = await ids()
    expect(all.filter((id, i) => all.indexOf(id) !== i), `${tab}: shown twice`).toEqual([])
    return all
  }
  await freshBox(page)
  for (const picked of [false, true]) {
    if (picked) await page.evaluate(() => {
      const sx = (window as unknown as { __sx: { getState(): { plate: { id: string }[] }; setState(p: unknown): void } }).__sx
      const id = sx.getState().plate[0]!.id
      sx.setState({ selection: id, selectedIds: [id] })
    })
    await page.getByTestId('ribbon-tab-solid').click()
    const solid = await once(`solid, picked ${picked}`)
    expect(solid).toEqual(expect.arrayContaining(['sketch', 'extrude', 'revolve', 'push', 'cut', 'array', 'holefit']))
    await expect(ribbon.getByTestId('ribbon-extrude')).toBeVisible()
    for (const t of ['mesh', 'sketch'] as const) {
      await page.getByTestId(`ribbon-tab-${t}`).click()
      await once(`${t}, picked ${picked}`)
    }
  }
})

test('the Sketch ribbon tab has its drawing tools, and leaving the sketch goes back', async ({ page }) => {
  await studio(page)
  const ribbon = await openModel(page, 'large', 1440)
  await page.getByTestId('ribbon-tab-solid').click()
  await expect(page.getByTestId('ribbon-tab-solid')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('ribbon-draw-line')).toHaveCount(0)
  await page.getByTestId('ribbon-tab-sketch').click()
  // nobody is sketching: the drawing tools wait, saying why
  await expect(page.getByTestId('ribbon-draw-line')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('ribbon-draw-line')).toHaveAttribute('data-tip-body', 'Start a sketch first.')
  await page.getByTestId('ribbon-tab-solid').click()
  await ribbon.locator('[data-tool="sketch"]').click()
  // the sketch starts on an origin plane; the tab follows it
  await expect(toolPanel(page)).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, originPlane: 'xy' })
  await expect(page.getByTestId('sketch-finish')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('ribbon-tab-sketch')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('ribbon-draw-rect').click()
  await expect(page.getByTestId('ribbon-draw-rect')).toHaveAttribute('aria-pressed', 'true')
  await expect(toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' })).toHaveAttribute('aria-checked', 'true')
  // the panel's pick shows on the ribbon too
  await toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await expect(page.getByTestId('ribbon-draw-circle')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('ribbon-tab-solid').click()
  await expect(page.getByTestId('ribbon-tab-solid')).toHaveAttribute('aria-selected', 'true')
})

// The pictures of the ribbon, only with SX_SHOTS=1: each shot opens its own window, so no page of the journey is used.
for (const scheme of ['dark', 'light'] as const) {
  test(`shots: the ribbon in ${scheme}`, async ({ browser }, info) => {
    test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
    test.setTimeout(240_000)
    const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
    for (const width of [1440, 1280]) {
      for (const size of ['large', 'medium', 'small'] as const) {
        const ctx = await browser.newContext({ ...(info.project.use.baseURL ? { baseURL: info.project.use.baseURL } : {}), deviceScaleFactor: 2 })
        const page = await ctx.newPage()
        await page.setViewportSize({ width, height: 900 })
        await openStudio(page, { appearance: { toolbarSize: size }, scheme, themeFollowsSystem: false })
        await designTab(page)
        const ribbon = page.getByTestId('model-shelf')
        await expect(ribbon).toHaveAttribute('data-setting', size)
        await ribbon.locator('[data-tool="push"]').click()
        await ribbon.locator('[data-tool="fillet"]').hover()
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(dir, `ribbon-${width}-${size}-${scheme}.png`) })
        await ribbon.screenshot({ path: join(dir, `ribbon-${width}-${size}-${scheme}-strip.png`) })
        await ctx.close()
      }
    }
  })
}

// ---- the Solid tab's groups and what the selection turns off

/** Boxes of the shelf's visible tools, none overlapping another. */
async function noOverlap(page: Page): Promise<void> {
  const overlaps = await page.getByTestId('model-shelf').evaluate((bar) => {
    const boxes = [...bar.querySelectorAll<HTMLElement>('button')].filter((b) => b.offsetParent !== null).map((b) => b.getBoundingClientRect())
    let n = 0
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!
      const b = boxes[j]!
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) n++
    }
    return n
  })
  expect(overlaps).toBe(0)
}

test('Model ribbon: groups, and the selection shows in them with no separate slot', async ({ page }) => {
  await studio(page)
  await designTab(page)
  const shelf = page.getByTestId('model-shelf')
  await expect(shelf.locator('.rb-grp')).toHaveCount(4)
  expect(await shelf.locator('.rb-glabel').allTextContents()).toEqual(['Create', 'Modify', 'Inspect', 'Output'])
  await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
  // nothing selected: the tools that work on an object are off, saying why
  for (const id of ['cut', 'array']) await expect(shelf.locator(`[data-tool="${id}"]`)).toHaveAttribute('aria-disabled', 'true')
  await expect(shelf.locator('[data-tool="cut"]')).toHaveAttribute('data-tip-body', 'Select an object first.')
  await freshBox(page)
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  for (const id of ['cut', 'array', 'holefit']) await expect(shelf.locator(`[data-tool="${id}"]`)).not.toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
  await noOverlap(page)
  // Everything fits at 1440 px: the shelf does not scroll, so undo and redo are on screen.
  expect(await shelf.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  for (const [width, labels] of [[1100, false], [900, false]] as const) {
    await page.setViewportSize({ width, height: 800 })
    await expect(shelf.locator('[data-tool="push"] .rb-label')).toBeVisible({ visible: labels })
    await noOverlap(page)
  }
})

test('Model ribbon with more picked than a tool takes turns off the tools that take one face at a time', async ({ page }) => {
  await studio(page)
  const id = await freshBox(page)
  await designTab(page)
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  const shelf = page.getByTestId('model-shelf')
  const off = (tool: string) => shelf.locator(`[data-tool="${tool}"]`).getAttribute('aria-disabled')
  await page.keyboard.press('Alt+2')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  // A pick lands a moment after the view sends it (the first one loads the pick code), so each is waited for before the next.
  const readout = page.getByTestId('model-select-readout')
  await expect(readout).toHaveText('1 face on Box')
  expect([await off('push'), await off('sketch'), await off('shell')]).toEqual([null, null, null])
  await pick(page, { ...(await facePick(page, id, [1, 0, 0])), shift: true })
  await expect(readout).toHaveText('2 faces on Box')
  await expect(shelf.locator('[data-tool="push"]')).toHaveAttribute('aria-disabled', 'true')
  await expect(shelf.locator('[data-tool="push"]')).toHaveAttribute('data-tip-body', 'Push and pull takes one face at a time.')
  await expect(shelf.locator('[data-tool="sketch"]')).toHaveAttribute('aria-disabled', 'true')
  expect(await off('shell')).toBeNull()
  await expect(page.getByTestId('model-shelf-next')).toHaveCount(0)
  expect(await shelf.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
})

test('Model ribbon: two objects turn off Cut and Hole, Array stays on', async ({ page }) => {
  await studio(page)
  await command(page, 'Add a box')
  await command(page, 'Add a cylinder')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(2)
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { plate: { id: string }[] }; setState(p: unknown): void } }).__sx
    const ids = sx.getState().plate.map((p) => p.id)
    sx.setState({ selection: ids[0], selectedIds: ids })
  })
  await designTab(page)
  const shelf = page.getByTestId('model-shelf')
  await expect(shelf.locator('[data-tool="cut"]')).toHaveAttribute('data-tip-body', 'Cut one object at a time.')
  await expect(shelf.locator('[data-tool="holefit"]')).toHaveAttribute('aria-disabled', 'true')
  await expect(shelf.locator('[data-tool="array"]')).not.toHaveAttribute('aria-disabled', 'true')
})

test('the Add shape menu opens over the view, and Repair mesh on the Mesh tab adds its step', async ({ page }) => {
  await studio(page)
  const id = await freshBox(page)
  await designTab(page)
  await page.locator('.dtree-name', { hasText: 'Box' }).click()
  // A part with history, so the repair lands as a step in it.
  await pushTop(page, id, 5)
  const ribbon = page.getByTestId('model-shelf')
  await page.getByTestId('ribbon-menu-add').click()
  const menu = page.getByRole('menu', { name: 'Add shape' })
  await expect(menu).toBeVisible()
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveCount(8)
  // Lifted out of the ribbon: below its bottom edge, every item inside the window, and the ribbon not scrolled.
  const s = (await ribbon.boundingBox())!
  const m = (await menu.boundingBox())!
  expect(m.y + m.height).toBeGreaterThan(s.y + s.height)
  for (const item of await items.all()) await expect(item).toBeInViewport({ ratio: 1 })
  expect(await ribbon.locator('.rb-body').evaluate((el) => el.scrollTop + el.scrollLeft)).toBe(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('ribbon-tab-mesh').click()
  await ribbon.locator('[data-tool="repair"]').click()
  await expect(page.getByTestId('model-tree-step').filter({ hasText: 'Repair' })).toHaveCount(1)
})

test('tool footer: Esc closes a tool, and Enter in its field applies and closes', async ({ page }) => {
  await studio(page)
  const id = await freshBox(page)
  await command(page, 'Push or pull a face')
  const panel = toolPanel(page)
  await expect(panel.getByTestId('model-tool-cancel')).toHaveText('Cancel')
  await expect(panel.getByTestId('model-tool-more')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await command(page, 'Push or pull a face')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face is picked')
  await panel.locator('#push-dist').fill('4')
  await expect(panel.getByTestId('model-tool-apply')).toHaveText('Pull out')
  await panel.locator('#push-dist').press('Enter')
  await expect(panel).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => height(page, id)).toBe(24)
})

test('tool footer: Push and pull and Shell say why Apply is off, a push past the limit says so, and Drop to bed answers', async ({ page }) => {
  await studio(page)
  const id = await freshBox(page)
  await command(page, 'Push or pull a face')
  const panel = toolPanel(page)
  const apply = panel.getByTestId('model-tool-apply')
  const reason = panel.getByTestId('model-tool-reason')
  await expect(reason).toHaveText('Pick a flat face to move.')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face is picked')
  await panel.locator('#push-dist').fill('0')
  await expect(apply).toBeDisabled()
  await expect(reason).toHaveText("The distance can't be 0. Type how far to move the face.")
  // past the engine's limit: plain words, no field key, and nothing sent
  await panel.locator('#push-dist').fill('20000')
  await expect(panel.getByTestId('op-preview-error')).toContainText('The distance is too large. The most is 10000 mm.')
  await expect(panel.getByTestId('op-preview-error')).not.toContainText('Mm:')
  await expect(apply).toBeDisabled()
  expect(await height(page, id)).toBe(20)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  // Shell with a wall of 0
  await command(page, 'Shell: hollow with faces left open')
  await panel.locator('#shell-wall').fill('0')
  await expect(panel.getByRole('button', { name: 'Make shell' })).toBeDisabled()
  await expect(reason).toHaveText('The wall must be more than 0 mm.')
  await panel.locator('#shell-wall').fill('2')
  await expect(reason).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  expect((await state(page)).plate[0]!.history?.steps.length ?? 0).toBe(0)
  // the box already stands on the ground: Drop to bed says so and changes nothing
  await page.evaluate((sel) => (window as unknown as { __sx: Sx }).__sx.setState({ selection: sel, selectedIds: [sel] }), id)
  const before = await bounds(page, id)
  await command(page, 'Drop the selected object to the ground')
  await expect(page.getByTestId('toast').filter({ hasText: 'is already on the ground.' })).toBeVisible()
  expect(await bounds(page, id)).toEqual(before)
})

test('tool footer: Apply and repeat rounds an edge and stays open with the same size', async ({ page }) => {
  test.slow()
  await studio(page)
  const id = await freshBox(page)
  await placeAt(page, 100, 100)
  const b = await bounds(page, id)
  await command(page, 'Fillet or chamfer edges')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No edge yet')
  await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
  await expect(panel).toContainText('1 edge')
  await panel.locator('#edge-size').fill('2')
  // Apply and repeat sits in the menu on the primary
  await panel.getByTestId('model-tool-more').click()
  await page.getByTestId('model-tool-repeat').click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Fillet 2 mm', state: 'done' }])
  await expect(panel).toContainText('No edge yet')
  await expect(panel.locator('#edge-size')).toHaveValue('2')
})

// -------------------------------------------------------------------------------------------------------------
// Design to Slice and back
// -------------------------------------------------------------------------------------------------------------

type Handoff = { getState(): { plate: { id: string }[]; modelMode: string; historyEdit: unknown; preview: { layerZ: Float32Array } | null }; setState(p: unknown): void }
const handoff = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Handoff }).__sx.getState())
const topZ = (page: Page) => page.evaluate(() => {
  const z = (window as unknown as { __sx: Handoff }).__sx.getState().preview?.layerZ
  return z && z.length ? z[z.length - 1]! : 0
})

test('a sketch left open waits in Slice through a slice and is finished back in Design', async ({ page }) => {
  test.slow()
  await studio(page)
  await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [20, 20] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  const field = page.getByRole('group', { name: 'Exact size' })
  // the size of the shape after its first point: the boxes on the shape
  const sizes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  await sketchAt(page, 'hover', [20, 20])
  await page.locator('body').press('5')
  await field.getByLabel('X mm').fill('20')
  await field.getByLabel('Y mm').fill('20')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [20, 20])
  await page.locator('body').press('3')
  await sizes.getByLabel('Width mm').fill('30')
  await sizes.getByLabel('Height mm').fill('20')
  await sizes.getByLabel('Height mm').press('Enter')
  await panel.locator('#sk-dist').fill('10')
  await expect(panel.getByRole('button', { name: 'Extrude' })).toBeEnabled({ timeout: 15_000 })

  // Slice: the tool waits as a chip, with a dot on the Design half.
  await tab(page, 'prepare').click()
  const chip = page.getByTestId('parked-chip')
  await expect(chip).toContainText('Sketch in progress')
  await expect(tab(page, 'model')).toHaveAttribute('data-parked', '')
  await expect(panel).toHaveCount(0)
  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
  expect((await handoff(page)).plate.length).toBe(1)

  // Back to Model: the sketch and its distance are as they were.
  await chip.getByRole('button', { name: 'Back to Model' }).click()
  await expect(chip).toHaveCount(0)
  await expect(panel).toContainText('The bed')
  await expect(panel.locator('#sk-dist')).toHaveValue('10')
  const extrude = panel.getByRole('button', { name: 'Extrude' })
  await expect(extrude).toBeEnabled({ timeout: 15_000 })
  await extrude.click()
  await expect.poll(async () => (await handoff(page)).plate.length, { timeout: 30_000 }).toBe(2)
  const body = (await handoff(page)).plate[1]!.id
  expect(await height(page, body)).toBe(10)
})

test('a history step being edited is put back whole before Mod+Enter slices, and opens again after', async ({ page }) => {
  test.slow()
  await studio(page)
  const id = await freshBox(page)
  await placeAt(page, 100, 100)
  await pushTop(page, id, 5)
  await expect.poll(() => height(page, id)).toBe(25)

  // Editing step 1 rolls the part back to before it.
  await clickStepButton(page, 'Pull 5 mm', 'Edit Pull 5 mm')
  const panel = toolPanel(page)
  await expect(panel.getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
  await expect.poll(() => height(page, id)).toBe(20)
  await panel.locator('#push-dist').fill('10')
  await panel.locator('#push-dist').blur()

  // Mod+Enter in Design: Slice opens with the whole part, and the slice reaches its top.
  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect.poll(async () => (await handoff(page)).modelMode).toBe('slice')
  expect((await handoff(page)).historyEdit).toBeNull()
  expect(await height(page, id)).toBe(25)
  await expect(page.getByTestId('parked-chip')).toContainText('Push and pull in progress')
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
  expect(await topZ(page)).toBeGreaterThan(24.5)

  // Back in Design the step opens again with the typed distance, and finishing it replays.
  await tab(page, 'model').click()
  await expect(panel.getByTestId('model-tool-crumb')).toHaveText('Box › Pull 5 mm')
  await expect(panel.locator('#push-dist')).toHaveValue('10')
  await expect.poll(() => height(page, id)).toBe(20)
  await panel.getByRole('button', { name: 'Pull out' }).click()
  await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: 'Pull 10 mm', state: 'done' }])
  await expect.poll(() => height(page, id)).toBe(30)
})

test('Mod+Enter slices while the first step of the only body is being edited', async ({ page }) => {
  test.slow()
  await studio(page)
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(panel).toContainText('The bed')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  const field = page.getByRole('group', { name: 'Exact size' })
  // the size of the shape after its first point: the boxes on the shape
  const sizes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  await sketchAt(page, 'hover', [100, 100])
  await page.locator('body').press('5')
  await field.getByLabel('X mm').fill('100')
  await field.getByLabel('Y mm').fill('100')
  await field.getByLabel('Y mm').press('Enter')
  await sketchAt(page, 'hover', [100, 100])
  await page.locator('body').press('3')
  await sizes.getByLabel('Width mm').fill('20')
  await sizes.getByLabel('Height mm').fill('20')
  await sizes.getByLabel('Height mm').press('Enter')
  await panel.locator('#sk-dist').fill('10')
  await expect(panel.getByRole('button', { name: 'Extrude' })).toBeEnabled({ timeout: 15_000 })
  await panel.getByRole('button', { name: 'Extrude' }).click()
  await expect.poll(async () => (await handoff(page)).plate.length, { timeout: 30_000 }).toBe(1)
  const id = (await handoff(page)).plate[0]!.id
  await page.evaluate(() => (window as unknown as { __sx: Handoff }).__sx.setState({ objectTool: null }))

  // Editing the step that made the body takes the body off the plate while the sketch is open.
  const row = page.locator('.cad-step').first()
  await row.hover()
  await row.getByRole('button', { name: /^Edit / }).click()
  await expect(panel.getByTestId('model-tool-crumb')).toHaveText('Sketch body › Sketch extrude 10 mm')
  await expect.poll(async () => (await handoff(page)).plate.length).toBe(0)
  await page.locator('#sk-dist').blur()

  const before = await sliceCount(page)
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect.poll(async () => (await handoff(page)).modelMode).toBe('slice')
  expect((await handoff(page)).plate.map((p) => p.id)).toEqual([id])
  await expect(sliced(page, before)).toBeVisible({ timeout: 60_000 })
  expect(await topZ(page)).toBeGreaterThan(9.5)
})
// "Measure closes on the way to Slice, so the toolpaths show" is not here: cad-park.test.ts:90 ("closes Measure and
// Array, which have nothing to keep") covers it.

// -------------------------------------------------------------------------------------------------------------
// Push and pull in the view, with a real mouse and keyboard
// -------------------------------------------------------------------------------------------------------------

test.describe('Push and pull in the view', () => {
  test('with the pane shut: the box takes the typed value, the chip names the operation, and Enter pulls the face', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'shut')
    const box = page.getByTestId('push-view-distance')
    // the value is focused and selected, so typing replaces it
    await expect(box).toBeFocused()
    await page.keyboard.type('6')
    await expect(box).toHaveValue('6')
    await expect(page.getByTestId('push-view-op')).toHaveText('Pull out')
    await expect(page.getByTestId('push-arrow')).toBeAttached()
    // the box sits inside the view
    const vp = (await page.locator('.vp').boundingBox())!
    const b = (await page.getByTestId('push-view-box').boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(vp.x)
    expect(b.x + b.width).toBeLessThanOrEqual(vp.x + vp.width)
    await page.keyboard.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 6)
    // applied and closed: no arrow, no tool
    await expect(page.getByTestId('push-in-view')).toHaveCount(0)
    expect((await store(page))['objectTool']).toBeNull()
  })

  test('a negative value turns into Cut, and Enter cuts', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'shut')
    await page.keyboard.type('-4')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    await expect(page.getByTestId('push-view-op')).toHaveAttribute('data-op', 'cut')
    await expect(page.locator('.pp-arrow')).toHaveAttribute('data-tone', 'cut')
    // past the far side it cuts through
    await page.getByTestId('push-view-distance').fill(String(-(h0 + 1)))
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut through')
    await page.getByTestId('push-view-distance').fill('-4')
    await page.getByTestId('push-view-distance').press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 - 4)
  })

  test('Escape closes the tool and leaves the model alone; the face stays picked', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    const before = await bounds(page, id)
    await pickThenPush(page, id, 'shut')
    await page.keyboard.type('9')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('push-in-view')).toHaveCount(0)
    expect((await store(page))['objectTool']).toBeNull()
    expect(await bounds(page, id)).toEqual(before)
    await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  })

  test('with the pane open, the pane field and the box stay in step both ways, and Enter in the view applies', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'open')
    const panel = toolPanel(page)
    const field = panel.locator('#push-dist')
    const box = page.getByTestId('push-view-distance')
    await page.keyboard.type('3')
    await expect(field).toHaveValue('3')
    await field.fill('-2.5')
    await expect(box).toHaveValue('-2.5')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    // the pane's apply names the same operation
    await expect(panel.getByRole('button', { name: 'Cut', exact: true })).toBeVisible()
    await box.fill('7')
    await expect(field).toHaveValue('7')
    await expect(panel.getByRole('button', { name: 'Pull out', exact: true })).toBeVisible()
    await box.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 7)
    await expect(panel).toHaveCount(0)
  })

  test('a drag on the arrow sets the distance, and Enter applies what the drag set', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pickThenPush(page, id, 'shut')
    const tip = (await page.getByTestId('push-arrow-tip').boundingBox())!
    const at = { x: tip.x + tip.width / 2, y: tip.y + tip.height / 2 }
    // the top face's normal points up on screen in the framed view: drag up to pull out
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x, at.y - 60, { steps: 8 })
    const mid = Number(await page.getByTestId('push-view-distance').inputValue())
    expect(mid).toBeGreaterThan(0)
    await expect(page.getByTestId('push-view-op')).toHaveText('Pull out')
    await page.mouse.up()
    const d = Number(await page.getByTestId('push-view-distance').inputValue())
    expect(d).toBeGreaterThan(0)
    // the arrow grew with the distance
    const tip2 = (await page.getByTestId('push-arrow-tip').boundingBox())!
    expect(tip2.y).toBeLessThan(tip.y - 20)
    // and back down past the face: a cut
    await page.mouse.move(tip2.x + tip2.width / 2, tip2.y + tip2.height / 2)
    await page.mouse.down()
    await page.mouse.move(tip2.x + tip2.width / 2, tip2.y + tip2.height / 2 + 140, { steps: 10 })
    await page.mouse.up()
    const cut = Number(await page.getByTestId('push-view-distance').inputValue())
    expect(cut).toBeLessThan(0)
    await expect(page.getByTestId('push-view-op')).toHaveText(/^Cut/)
    // the box has focus back after the drag; Enter applies
    await expect(page.getByTestId('push-view-distance')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBeCloseTo(Math.max(0, h0 + cut), 1)
  })
})

// -------------------------------------------------------------------------------------------------------------
// The operation preview: added material is tinted, removed material a ghost, a failing edit keeps the last good one
// -------------------------------------------------------------------------------------------------------------

/** A click on the top face of the box, then Push and pull. */
async function pushOnTop(page: Page, id: string): Promise<void> {
  const top = await topMiddle(page, id)
  await page.mouse.click(top.x, top.y)
  await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  await command(page, 'Push or pull a face')
  await expect(page.getByTestId('push-view-box')).toBeVisible()
}

test.describe('Operation preview on a desktop', () => {
  test('push and pull: a pull is tinted, a cut is a ghost, and a distance that does not read keeps the last good preview', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    const h0 = await height(page, id)
    await pushOnTop(page, id)
    const box = page.getByTestId('push-view-distance')
    await expect(box).toBeFocused()
    await page.keyboard.type('6')
    await expect.poll(() => shown(page)).toMatchObject({ added: true, removed: false })
    // removed material is fainter than added material, so it reads as a ghost through the part
    const look = (await shown(page)).look
    expect(look.cutFill).toBeLessThan(look.addFill)
    expect(look.add).not.toBe(look.cut)

    await box.press('ControlOrMeta+a')
    await page.keyboard.type('-4')
    await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
    await expect.poll(() => shown(page)).toMatchObject({ added: false, removed: true })
    const tip = (await page.getByTestId('push-arrow-tip').boundingBox())!

    // a distance that does not read: the cut stays on screen, the arrow stays put, and the box says why
    await page.keyboard.type('x')
    await expect(box).toHaveValue('-4x')
    const error = page.getByTestId('push-view-error')
    await expect(error).toHaveText('Type a number, such as 5 or -3. Showing the last good preview.')
    await expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(await shown(page)).toMatchObject({ removed: true })
    const kept = (await page.getByTestId('push-arrow-tip').boundingBox())!
    expect(Math.abs(kept.y - tip.y)).toBeLessThan(2)
    await expect(page.locator('.pp-arrow')).toHaveAttribute('data-tone', 'cut')
    // Enter does nothing while the box does not read
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('push-in-view')).toBeVisible()
    expect(await height(page, id)).toBe(h0)

    // fixed: the error goes, and Enter cuts
    await page.keyboard.press('Backspace')
    await expect(error).toHaveCount(0)
    await expect(box).not.toHaveAttribute('aria-invalid', 'true')
    await page.keyboard.press('Enter')
    await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 - 4)
    await expect.poll(() => shown(page)).toMatchObject({ added: false, removed: false })
  })

  test('push and pull with the pane open: the panel shows the same error and the last good preview stays', async ({ page }) => {
    test.slow()
    await studio(page)
    const id = await framedBox(page)
    await pushOnTop(page, id)
    const panel = toolPanel(page)
    const field = panel.locator('#push-dist')
    await field.fill('3')
    await expect.poll(() => shown(page)).toMatchObject({ added: true })
    await field.fill('3..')
    await expect(panel.getByTestId('op-preview-error')).toContainText('Showing the last good preview.')
    await expect(page.getByTestId('push-view-error')).toContainText('Showing the last good preview.')
    expect(await shown(page)).toMatchObject({ added: true })
    // clearing the box clears the preview and the error
    await field.fill('')
    await expect(panel.getByTestId('op-preview-error')).toHaveCount(0)
    await expect.poll(() => shown(page)).toMatchObject({ added: false, removed: false })
  })

  for (const kind of ['Fillet', 'Chamfer'] as const) {
    test(`${kind.toLowerCase()}: the removed edge is a ghost, and a size the engine refuses keeps the last good preview`, async ({ page }) => {
      test.slow()
      await studio(page)
      const id = await framedBox(page, [100, 100])
      await command(page, 'Fillet or chamfer edges')
      const panel = toolPanel(page)
      await expect(panel).toContainText('No edge yet')
      if (kind === 'Chamfer') await panel.getByRole('radio', { name: 'Chamfer' }).click()
      // the top face beside its +X edge picks that edge (as the fillet test above picks it); sizes are typed on the keyboard
      const b = await bounds(page, id)
      await pick(page, await facePick(page, id, [0, 0, 1], [b.max[0] - 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]]))
      await expect(panel).toContainText('1 edge')
      const size = panel.locator('#edge-size')
      await size.click()
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('2')
      // a convex edge loses material: only the ghost shows
      await expect.poll(() => shown(page), { timeout: 30_000 }).toMatchObject({ removed: true })
      const verb = panel.getByRole('button', { name: kind === 'Fillet' ? 'Round' : 'Bevel', exact: true })
      await expect(verb).toBeEnabled()

      // far bigger than the box: the engine refuses it, and the 2 mm preview stays with the error in the panel
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('50')
      const error = panel.getByTestId('op-preview-error')
      await expect(error).toContainText('Showing the last good preview.', { timeout: 30_000 })
      expect(await shown(page)).toMatchObject({ removed: true })
      await expect(verb).toBeDisabled()

      // a size that does not read says so, and the preview still stays
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('0')
      await expect(error).toHaveText(`Type a ${kind === 'Fillet' ? 'radius' : 'distance'} above 0 mm. Showing the last good preview.`)
      expect(await shown(page)).toMatchObject({ removed: true })

      // a good size again: the error goes and Enter applies it
      await size.press('ControlOrMeta+a')
      await page.keyboard.type('1')
      await expect(error).toHaveCount(0, { timeout: 30_000 })
      await expect(verb).toBeEnabled()
      await size.press('Enter')
      await expect.poll(() => steps(page), { timeout: 30_000 }).toEqual([{ name: `${kind} 1 mm`, state: 'done' }])
    })
  }

  test('the preview takes the light studio colors', async ({ page }) => {
    test.slow()
    await studio(page)
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ scheme: 'light', themeFollowsSystem: false }))
    await expect(page.locator('html[data-scheme="light"]')).toHaveCount(1)
    const id = await framedBox(page)
    await pushOnTop(page, id)
    await page.keyboard.type('-3')
    await expect.poll(() => shown(page)).toMatchObject({ removed: true })
    const light: Shown['look'] = (await shown(page)).look
    expect(light.cut).toBe('#d32f2f')
    expect(light.cutFill).toBeLessThan(light.addFill)
  })
})
