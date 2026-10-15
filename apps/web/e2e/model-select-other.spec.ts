// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's Select Other with a real mouse and a real finger: holding the pointer still on a spot for half a second opens
// a list of everything under it (what a click picks first, then the faces front to back, then the bodies), a row
// under the pointer shows what it picks and choosing it picks it; the list takes arrow keys and Enter, Alt+S opens it
// at the pointer and Escape closes it, giving focus back to the view; a plain click on the same spot again steps to the
// next thing under it and around. On a phone a finger held still opens the list with 44 px rows, ending with More
// actions for the ring. Two boxes, one behind the other, put several things under one spot.
import type { CDPSession, Page } from '@playwright/test'
import { bounds, command, freshBox, openStudio } from './cad-helpers'
import { expect, test } from './fixtures'

type Sx = { getState(): { plate: { id: string; name: string; transform: number[] }[]; subPicks: { kind: string; objectId: string }[]; selection: string | null; selectedIds: string[] }; setState(p: unknown): void }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

/**
 * A second box right behind the first and three times as tall, so a ray through the first one's top reaches the
 * second one's front face. Returns both ids, front first.
 */
async function twoBoxes(page: Page, add: () => Promise<void>): Promise<{ front: string; back: string }> {
  await add()
  await expect.poll(async () => (await state(page)).plate.length).toBe(2)
  const [front, back] = (await state(page)).plate.map((p) => p.id) as [string, string]
  const b = await bounds(page, front)
  await page.evaluate(
    ({ front, back, depth }) => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      const plate = sx.getState().plate
      const t = [...plate.find((p) => p.id === front)!.transform]
      t[13] = t[13]! + depth
      for (const k of [8, 9, 10]) t[k] = t[k]! * 3
      sx.setState({ plate: plate.map((p) => (p.id === back ? { ...p, transform: t } : p)), selection: null, selectedIds: [], subPicks: [] })
    },
    { front, back, depth: b.max[1] - b.min[1] + 2 },
  )
  return { front, back }
}

/** Waits until the view draws both boxes and its camera has stopped, then frames them. */
async function settled(page: Page, ids: string[]): Promise<void> {
  await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id)), ids)).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  const at = () => page.evaluate(() => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf([0, 0, 0]).map((v) => Math.round(v)).join(','))
  let last = ''
  let still = 0
  await expect
    .poll(async () => {
      const now = await at()
      still = now === last ? still + 1 : 0
      last = now
      return still >= 4
    }, { intervals: [250], timeout: 15_000 })
    .toBe(true)
}

/** A spot whose nearest thing is the front box's top face, well clear of its edges, with the back box behind it. */
async function stackedSpot(page: Page, front: string, back: string): Promise<{ x: number; y: number }> {
  const spot = await page.evaluate(
    ({ front, back }) => {
      type Hit = { objectId: string; normal: number[] }
      const vp = (window as unknown as { __vp: { pickAll(x: number, y: number): Hit[]; canvas: HTMLCanvasElement } }).__vp
      const r = vp.canvas.getBoundingClientRect()
      const ok = (x: number, y: number) => {
        const h = vp.pickAll(x, y)
        return h[0]?.objectId === front && (h[0]?.normal[2] ?? 0) > 0.9 && h.some((k) => k.objectId === back)
      }
      // the spot and a ring 14 px around it all on the same stack: well inside the face, away from its edges
      for (let y = r.top + 8; y < r.bottom - 8; y += 6)
        for (let x = r.left + 8; x < r.right - 8; x += 6) if (ok(x, y) && [[14, 0], [-14, 0], [0, 14], [0, -14]].every(([dx, dy]) => ok(x + dx!, y + dy!))) return { x, y }
      return null
    },
    { front, back },
  )
  expect(spot, 'a spot on the front box with the back box behind it').not.toBeNull()
  return spot!
}

const list = (page: Page) => page.getByTestId('select-other')
const rows = (page: Page) => page.getByTestId('select-other-row')
const readout = (page: Page) => page.getByTestId('model-select-readout')

test.describe('Select Other with a mouse and keys', () => {
  test.skip(({ isMobile }) => isMobile, 'Needs a pointer and a keyboard')

  async function setup(page: Page) {
    await openStudio(page)
    await freshBox(page)
    const ids = await twoBoxes(page, () => command(page, 'Add a box'))
    // the front box picked already: Model frames the view on a new pick, and the spot must stay put
    await page.evaluate((id) => (window as unknown as { __sx: Sx }).__sx.setState({ selection: id, selectedIds: [id] }), ids.front)
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.locator('[data-testid="model-select-filter"][data-kind="face"]')).toHaveAttribute('aria-pressed', 'true')
    await settled(page, [ids.front, ids.back])
    return { ...ids, spot: await stackedSpot(page, ids.front, ids.back) }
  }

  test('holding the pointer still opens the list of everything under it, front to back; a row picks it', async ({ page }) => {
    test.slow()
    const { back, spot } = await setup(page)
    await page.mouse.move(spot.x, spot.y)
    await page.mouse.down()
    await page.waitForTimeout(800)
    await expect(list(page)).toBeVisible()
    // the top face, the back box's face behind it, then both bodies
    await expect.poll(async () => (await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).join(',')).toBe('face,face,body,body')
    await expect(rows(page).first()).toHaveAccessibleName(/^Top face on /)
    await page.mouse.up()
    // the press was a hold, not a click: the list stays and nothing is picked
    await expect(list(page)).toBeVisible()
    expect((await state(page)).subPicks).toEqual([])
    // a row under the pointer shows what it would pick in the view
    await rows(page).nth(1).hover()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { pickedFaces: unknown[] } }).__vp.pickedFaces.length)).toBeGreaterThan(0)
    await rows(page).nth(3).click()
    await expect(list(page)).toBeHidden()
    const s = await state(page)
    expect(s.selectedIds).toEqual([back])
    expect(s.subPicks).toEqual([])
    await expect(readout(page)).toHaveText(s.plate.find((p) => p.id === back)!.name)
  })

  test('the list takes arrow keys and Enter; Alt+S opens it at the pointer and Escape closes it, focus back in the view', async ({ page }) => {
    test.slow()
    const { back, spot } = await setup(page)
    await page.mouse.move(spot.x - 30, spot.y - 30)
    await page.mouse.move(spot.x, spot.y, { steps: 4 })
    await page.locator('canvas.vp-canvas').focus()
    await page.keyboard.press('Alt+S')
    await expect(list(page)).toBeVisible()
    await expect(rows(page).first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(rows(page).nth(1)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(list(page)).toBeHidden()
    await expect.poll(async () => (await state(page)).subPicks.map((p) => `${p.kind} ${p.objectId}`)).toEqual([`face ${back}`])
    await expect(readout(page)).toHaveText(/^1 face on /)
    // Escape closes it, picks nothing and gives focus back to the view
    await page.keyboard.press('Alt+S')
    await expect(list(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeHidden()
    await expect(page.locator('canvas.vp-canvas')).toBeFocused()
    expect((await state(page)).subPicks.map((p) => `${p.kind} ${p.objectId}`)).toEqual([`face ${back}`])
  })

  test('clicking the same spot again steps to the next thing under it, and around', async ({ page }) => {
    test.slow()
    const { front, back, spot } = await setup(page)
    const tag = page.getByTestId('select-other-tag')
    const names = Object.fromEntries((await state(page)).plate.map((p) => [p.id, p.name]))
    await page.mouse.click(spot.x, spot.y)
    await expect(tag).toContainText('1 of 4')
    await expect(readout(page)).toHaveText(`1 face on ${names[front]}`)
    const want = [
      ['2 of 4', `1 face on ${names[back]}`],
      ['3 of 4', names[front]!],
      ['4 of 4', names[back]!],
      ['1 of 4', `1 face on ${names[front]}`],
    ]
    for (const [n, words] of want) {
      // slower than a double click
      await page.waitForTimeout(400)
      await page.mouse.click(spot.x, spot.y)
      await expect(tag).toContainText(n!)
      await expect(readout(page)).toHaveText(words!)
    }
    // a click elsewhere starts over, and the tag goes when the pointer moves away
    await page.mouse.move(spot.x + 200, spot.y + 200, { steps: 4 })
    await expect(tag).toBeHidden()
  })
})

/** One finger: down, held for `hold` ms, then up where it went down. */
async function hold(cdp: CDPSession, at: { x: number; y: number }, ms: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] })
  await new Promise((r) => setTimeout(r, ms))
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test.describe('Select Other on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone only')

  test('a finger held still opens the list with 44 px rows; a row picks it, More actions opens the ring', async ({ page }) => {
    test.slow()
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.e2e.cadOnly', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    const addBox = async () => {
      await page.getByTestId('phone-add').tap()
      await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().tap()
    }
    await addBox()
    await expect.poll(async () => (await state(page)).plate.length).toBe(1)
    const { front, back } = await twoBoxes(page, addBox)
    await settled(page, [front, back])
    const spot = await stackedSpot(page, front, back)
    const cdp = await page.context().newCDPSession(page)
    await hold(cdp, spot, 800)
    await expect(list(page)).toBeVisible()
    await expect.poll(() => rows(page).count()).toBe(4)
    for (const h of await rows(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44)
    const more = page.getByTestId('select-other-more')
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // the held finger picked nothing; a row does
    expect((await state(page)).subPicks).toEqual([])
    await rows(page).nth(1).tap()
    await expect(list(page)).toBeHidden()
    await expect.poll(async () => (await state(page)).subPicks.map((p) => `${p.kind} ${p.objectId}`)).toEqual([`face ${back}`])
    // More actions: the ring a held finger opened before
    await hold(cdp, spot, 800)
    await expect(list(page)).toBeVisible()
    await more.tap()
    await expect(list(page)).toBeHidden()
    await expect(page.getByTestId('model-ring')).toBeVisible()
  })
})
