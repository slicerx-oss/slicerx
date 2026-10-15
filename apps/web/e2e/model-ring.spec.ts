// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's ring menu in the 3D view: a right click opens it at the pointer for what is under it, a part, a face, an
// edge or empty space; the menu key opens it for what is picked; a touch held still opens it too. Arrows go round,
// Enter runs, Escape closes, the middle opens the full list (Delete is only there), and nothing around it moves.
import { type Page } from '@playwright/test'
import { facePick, freshBox, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'
import { pressable } from './canvas-press'

type Hit = { objectId: string | null; partIndex: number | null; triangle: number | null; point: [number, number, number] | null }

/** The view's menu event, as a right click on that spot sends it. */
async function contextAt(page: Page, hit: Hit, screen: [number, number] = [640, 400]): Promise<void> {
  await page.evaluate(({ hit, screen }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('contextpick', { ...hit, screen }), { hit, screen })
}

const ring = (page: Page) => page.getByTestId('model-ring')
const slots = (page: Page) => ring(page).locator('.sx-ring-slot').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))

test.describe('Model ring menu', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop Model')

  test('a part, a face, an edge and empty space each get their ring', async ({ page }) => {
    await openStudio(page)
    const id = await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.getByTestId('model-shelf')).toBeVisible()
    const shelfBefore = await page.getByTestId('model-shelf').boundingBox()
    // Model starts on Face; Body picks whole objects
    await page.mouse.move(700, 450)
    await page.keyboard.press('Alt+1')

    // a part: the object is selected and its ring opens at the pointer
    const top = await facePick(page, id, [0, 0, 1])
    await contextAt(page, top, [700, 380])
    await expect(ring(page)).toHaveAttribute('data-target', 'object')
    expect(await slots(page)).toEqual(['model-ring-cut', 'model-ring-array', 'model-ring-duplicate', 'model-ring-drop', 'model-ring-rename', 'model-ring-lock'])
    const box = (await ring(page).boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - 700)).toBeLessThan(2)
    expect(Math.abs(box.y + box.height / 2 - 380)).toBeLessThan(2)
    // nothing around it moved
    expect(await page.getByTestId('model-shelf').boundingBox()).toEqual(shelfBefore)
    // keys: the first verb has focus, the arrows go round, Escape closes
    await expect(page.getByTestId('model-ring-cut')).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('model-ring-array')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)

    // More: the full list, with Delete there and nowhere on the ring
    await contextAt(page, top)
    await expect(page.getByTestId('danger-model-ring-delete')).toHaveCount(0)
    await page.getByTestId('model-ring-more').click()
    await expect(page.getByTestId('model-ring-list')).toBeVisible()
    await expect(page.getByTestId('danger-model-ring-delete')).toBeVisible()
    await page.keyboard.press('Escape')

    // a face: with Faces in the pick filter, the right click picks the face and opens the face ring
    await page.keyboard.press('Alt+2')
    await contextAt(page, top)
    await expect(ring(page)).toHaveAttribute('data-target', 'face')
    expect(await slots(page)).toEqual(['model-ring-push', 'model-ring-sketch', 'model-ring-shell', 'model-ring-lay', 'model-ring-text', 'model-ring-measure'])
    // the picked face shows as an outline over a light fill, not a solid one
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)
    await contextAt(page, top)
    expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { subPicks: { kind: string }[] } } }).__sx.getState().subPicks.map((p) => p.kind))).toEqual(['face'])
    // a click runs the verb: Push and pull opens with the face
    await page.getByTestId('model-ring-push').click()
    await expect(ring(page)).toHaveCount(0)
    await expect(page.locator('[data-section="cad-tool"]')).toContainText('Push')
    await page.getByTestId('model-tool-cancel').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { objectTool: string | null } } }).__sx.getState().objectTool)).toBeNull()

    // an edge
    await page.keyboard.press('Alt+3')
    await contextAt(page, top)
    await expect(ring(page)).toHaveAttribute('data-target', 'edge')
    expect(await slots(page)).toEqual(['model-ring-fillet', 'model-ring-chamfer', 'model-ring-measure'])
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)

    // empty space
    await page.keyboard.press('Alt+1')
    await contextAt(page, { objectId: null, partIndex: null, triangle: null, point: null })
    await expect(ring(page)).toHaveAttribute('data-target', 'empty')
    expect(await slots(page)).toEqual(['model-ring-shape', 'model-ring-model', 'model-ring-arrange', 'model-ring-fit', 'model-ring-all', 'model-ring-paste'])
    // Add shape opens the list with the shapes
    await page.getByTestId('model-ring-shape').click()
    await expect(page.getByTestId('model-ring-list-shape-box')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('a real right click on the model, the menu key, and a touch held still', async ({ page }) => {
    await openStudio(page)
    await freshBox(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    const canvas = page.locator('canvas.vp-canvas').first()
    await expect(canvas).toBeVisible()
    const c = (await canvas.boundingBox())!
    // a touch held still for half a second, as the touch screen sends it
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const point = { x: c.x + c.width / 2, y: c.y + c.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await page.waitForTimeout(700)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await expect(ring(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(ring(page)).toHaveCount(0)
    // right click in the middle of the view, where the box is
    await pressable(page, { x: c.x + c.width / 2, y: c.y + c.height / 2 })
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2, { button: 'right' })
    await expect(ring(page)).toBeVisible()
    await page.keyboard.press('Escape')
    // the menu key with the view focused: the ring for what is selected, in the middle of the view
    await canvas.focus()
    await page.keyboard.press('Shift+F10')
    await expect(ring(page)).toBeVisible()
    await page.keyboard.press('Escape')
  })
})
