// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone legs of the CAD journeys, on one phone page: push and pull with a finger, the operation preview, the
// dimension boxes on a sketch shape, the sketch sheet at three heights, and the slow 3D view notice. The page is the
// CAD-only studio, as a phone gets it. The desktop legs are in cad-ops.spec.ts and cad-sketch.spec.ts.
import { type Page } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { test as cold } from '../fixtures'
import { bounds, height } from '../cad-helpers'
import {
  boxOf, boxesOverControls, emit, inputOf, labels, loops, phoneBox, phoneStudio, rect, screenOf, settled, shot, shown, size, still, tapView, topMiddle,
  type W,
} from './lib/cad'

test.skip(({ isMobile }) => !isMobile, 'Phone only')

type Sx = { setState(p: unknown): void }

// ---- push and pull in the view, with a finger
test('push and pull in the view: a tap picks the face, the box sits in the view, and a typed value applies with Enter', async ({ page }) => {
  test.slow()
  await phoneStudio(page)
  const id = await phoneBox(page)
  const h0 = await height(page, id)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ objectTool: 'push' }))
  await settled(page)
  const top = await topMiddle(page, id)
  await tapView(page, top.x, top.y)
  const box = page.getByTestId('push-view-box')
  await expect(box).toBeVisible()
  const b = (await box.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(390)
  // the keyboard stays down until the box is tapped; the value is a 44 px target
  const input = page.getByTestId('push-view-distance')
  await expect(input).not.toBeFocused()
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await input.tap()
  await input.fill('4')
  await expect(page.getByTestId('push-view-op')).toHaveText('Pull out')
  await input.press('Enter')
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 + 4)
})

// ---- the operation preview
test('operation preview: a cut typed with a finger is a ghost, and a value that does not read keeps it with the error under the value', async ({ page }) => {
  test.slow()
  await phoneStudio(page)
  const id = await phoneBox(page)
  const h0 = await height(page, id)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ objectTool: 'push' }))
  await settled(page)
  const b = await bounds(page, id)
  const [x, y] = await screenOf(page, [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  await tapView(page, x, y)
  const input = page.getByTestId('push-view-distance')
  await expect(input).toBeVisible()
  await input.tap()
  await input.fill('-3')
  await expect.poll(() => shown(page)).toMatchObject({ removed: true, added: false })
  await input.fill('-3,,')
  const error = page.getByTestId('push-view-error')
  await expect(error).toHaveText('Type a number, such as 5 or -3. Showing the last good preview.')
  expect(await shown(page)).toMatchObject({ removed: true })
  // the box and its error stay inside the phone's view
  const box = (await page.getByTestId('push-view-box').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await input.fill('-3')
  await expect(error).toHaveCount(0)
  await input.press('Enter')
  await expect.poll(() => height(page, id), { timeout: 30_000 }).toBe(h0 - 3)
})

// ---- sketch dimension boxes on the shape
async function sketchOnPlane(page: Page): Promise<void> {
  await phoneStudio(page)
  await page.getByTestId('phone-sketch').tap()
  await expect(page.getByRole('complementary', { name: 'Tool and transform' })).toContainText('Tap an origin plane')
  await page.evaluate(() => (window as unknown as W).__vp.emit('pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' }))
  await expect(page.getByTestId('phone-sketch-bar')).toBeVisible()
  await still(page)
}
const family = (page: Page, name: string) => page.getByTestId('phone-sketch-bar').getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name })
// a tap in the open part of the view, above the sheet: `fx` across and `fy` down the view, as fractions
const tapAt = async (page: Page, fx: number, fy: number) => {
  const r = await page.evaluate(() => (window as unknown as W).__vp.canvas.getBoundingClientRect().toJSON() as DOMRect)
  const sheet = await page.getByRole('complementary', { name: 'Tool and transform' }).boundingBox()
  const bottom = Math.min(r.y + r.height, sheet ? sheet.y : Infinity)
  // clear of the mode pill and the handles along the top
  const top = r.y + 140
  await page.touchscreen.tap(r.x + 40 + (r.width - 120) * fx, top + (bottom - top) * fy)
}
const fitsPhone = async (page: Page, keys: string[]) => {
  const vw = page.viewportSize()!.width
  const boxes = await Promise.all(keys.map((k) => rect(boxOf(page, k))))
  for (const b of boxes) {
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(vw)
  }
  if (boxes.length === 2) expect(boxes[0]!.x + boxes[0]!.width <= boxes[1]!.x || boxes[1]!.x + boxes[1]!.width <= boxes[0]!.x || boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y || boxes[1]!.y + boxes[1]!.height <= boxes[0]!.y).toBe(true)
}

test('a finger draws a rectangle, a line and a circle with sizes typed in the boxes on the shape', async ({ page }) => {
  test.slow()
  await sketchOnPlane(page)
  // rectangle: the boxes sit on it from the first tap, the keyboard stays down until a box is tapped
  await family(page, 'Rectangle').tap()
  await tapAt(page, 0.3, 0.3)
  await expect(boxOf(page, 'width')).toBeVisible()
  await expect(inputOf(page, 'width')).not.toBeFocused()
  await fitsPhone(page, ['width', 'height'])
  await boxOf(page, 'width').locator('input').tap()
  await page.keyboard.type('16')
  await inputOf(page, 'height').tap()
  await page.keyboard.type('8')
  await shot(page, test.info(), 'phone-rect-typed.png')
  await page.keyboard.press('Enter')
  // 16 by 8 from the corner tapped (a finger lands on the nearest grid point)
  await expect.poll(async () => size((await loops(page))[0])).toEqual([16, 8])
  await expect.poll(() => labels(page)).toEqual(['16', '8'])

  // line: 15 straight up
  await family(page, 'Line').tap()
  await tapAt(page, 0.7, 0.3)
  await expect(boxOf(page, 'length')).toBeVisible()
  await fitsPhone(page, ['length', 'angle'])
  await inputOf(page, 'length').tap()
  await page.keyboard.type('15')
  await inputOf(page, 'angle').tap()
  await page.keyboard.type('90')
  await page.keyboard.press('Enter')
  await expect.poll(async () => size((await loops(page))[1])).toEqual([0, 15])
  await inputOf(page, 'length').press('Escape')

  // circle: 10 across
  await family(page, 'Circle').tap()
  await tapAt(page, 0.5, 0.15)
  await expect(boxOf(page, 'diameter')).toBeVisible()
  await fitsPhone(page, ['diameter'])
  await inputOf(page, 'diameter').tap()
  await page.keyboard.type('10')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await loops(page))[2]).toMatchObject({ type: 'circle', diameterMm: 10 })
  await shot(page, test.info(), 'phone-drawn.png')
})

test('a box on the shape stays clear of the undo group and the other floating controls', async ({ page }) => {
  test.slow()
  await sketchOnPlane(page)
  await family(page, 'Rectangle').tap()
  // a first tap high and at the right of the view: its Height box would go above the corner, under the undo group
  await tapAt(page, 0.85, 0)
  await expect(boxOf(page, 'width')).toBeVisible()
  await fitsPhone(page, ['width', 'height'])
  const first = await boxesOverControls(page)
  await page.waitForTimeout(1500)
  const r = await boxesOverControls(page)
  expect(r.controls).toBeGreaterThan(0)
  expect(r.over, JSON.stringify({ first, r })).toBe(0)
  await shot(page, test.info(), 'phone-top-right.png')
})

// ---- the sketch sheet
const phoneClick = (page: Page, at: [number, number]) => emit(page, 'sketch', { kind: 'click', at, mmPerPx: 0.2, screen: [200, 300], shift: false, alt: false })

for (const height of [844, 700, 600]) {
  test(`a phone at 390 by ${height}: the opened sheet reaches every control and stays open while drawing`, async ({ page }) => {
    await phoneStudio(page)
    await page.setViewportSize({ width: 390, height })
    await page.getByTestId('phone-sketch').tap()
    const sheet = page.getByRole('complementary', { name: 'Tool and transform' })
    await expect(sheet).toContainText('Tap an origin plane')
    await emit(page, 'pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' })
    const toggle = page.getByTestId('sketch-sheet-toggle')
    // the first point folds it, and focus on a field the fold hides moves to the sheet's button; the button opens it again
    await sheet.locator('#sk-grid').focus()
    await phoneClick(page, [-10, -10])
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    // no Transform under a sketch on a phone: the sheet is the sketch's
    await expect(sheet.locator('[data-section="transform"]')).toHaveCount(0)
    // folded, the header names the tool once; the bar's tool buttons are icons with names, no second label
    await expect(page.getByTestId('sketch-summary')).toContainText('Line')
    expect(await page.getByTestId('phone-sketch-bar').evaluate((b) => (b.textContent ?? '').includes('Line'))).toBe(false)
    // opening and folding by hand changes nothing drawn or picked
    const drawn = async () => JSON.stringify([(await page.evaluate(() => (window as unknown as { __sketch: () => { loops?: unknown } | null }).__sketch()?.loops)), await page.evaluate(() => (window as unknown as { __sx: { getState(): { selection: unknown; selectedIds: unknown } } }).__sx.getState().selectedIds)])
    const before = await drawn()
    // each tap once the sheet has settled where a finger would find it
    const tapToggle = async (open: boolean) => {
      await expect(toggle).toBeInViewport({ ratio: 1 })
      await toggle.tap()
      await expect(toggle).toHaveAttribute('aria-expanded', String(open))
    }
    await tapToggle(true)
    await tapToggle(false)
    await tapToggle(true)
    expect(await drawn()).toBe(before)
    // a line in progress: the reason Extrude is off is said in a finger's words
    await expect(sheet.getByTestId('model-tool-reason')).toHaveText('End the shape being drawn first (press and hold).')
    // opened, the drawing's controls show whole down to the Show chips, clear of the footer and its fade, and the sheet
    // stays below the top bar
    await expect.poll(() => sheet.evaluate((el) => {
      const body = el.querySelector('.sx-rail-body')!
      const foot = body.querySelector('.cad-footer')!
      const fade = parseFloat(getComputedStyle(foot, '::before').height) || 24
      return body.querySelector('.sketch-show')!.getBoundingClientRect().bottom + body.scrollTop <= foot.getBoundingClientRect().top - fade + 0.5
    })).toBe(true)
    // no chip's word runs past its chip, and no chip passes the panel's right edge (where the Snap menu ends)
    const { chips, room, need } = await sheet.evaluate((el) => {
      const edge = el.querySelector('.sketch-palette')!.getBoundingClientRect().right
      const group = el.querySelector<HTMLElement>('.sketch-show .tp-chips')!
      const all = [...group.querySelectorAll<HTMLElement>('.tp-chip')]
      const widths = all.map((b) => {
        const was = b.style.width
        b.style.width = 'max-content'
        const w = b.getBoundingClientRect().width
        b.style.width = was
        return w
      })
      return {
        chips: all.map((b) => ({ text: b.textContent, over: b.scrollWidth - b.clientWidth, past: b.getBoundingClientRect().right - edge, top: Math.round(b.getBoundingClientRect().top) })),
        room: group.getBoundingClientRect().width,
        need: widths.reduce((a, w) => a + w, 0) + parseFloat(getComputedStyle(group).columnGap) * 3,
      }
    })
    expect(chips).toHaveLength(4)
    for (const c of chips) {
      expect(c.over, `${c.text} at ${height}`).toBeLessThanOrEqual(0)
      expect(c.past, `${c.text} at ${height}`).toBeLessThanOrEqual(0.5)
    }
    // one row only when the four fit the column, as on the desktop (a 390 phone's column fits them)
    expect(new Set(chips.map((c) => c.top)).size).toBe(need <= room ? 1 : 2)
    const top = (await page.locator('.topbar, header').first().boundingBox())!
    expect((await sheet.boundingBox())!.y).toBeGreaterThanOrEqual(top.y + top.height)
    await shot(page, test.info(), `sheet-open-${height}.png`)
    // a closed square, so the solid settings are all there
    await phoneClick(page, [10, -10])
    await phoneClick(page, [10, 10])
    await phoneClick(page, [-10, 10])
    await phoneClick(page, [-10, -10])
    // drawing on does not fold it again
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const bar = (await page.locator('.pbar').boundingBox())!
    const footer = sheet.locator('.cad-footer')
    const body = sheet.locator('.sx-rail-body')
    const ids = ['#sk-grid', '#sk-step', '#sk-section', '#sk-show-profiles', '#sk-show-points', '#sk-show-dimensions', '#sk-show-constraints', '#sk-dist', '#sk-taper', '[data-testid="sketch-flip"]']
    for (const id of ids) {
      const c = sheet.locator(id).first()
      await c.scrollIntoViewIfNeeded()
      const [b, sb, f] = [(await c.boundingBox())!, (await body.boundingBox())!, (await footer.boundingBox())!]
      // inside the sheet's scroll box, above its footer and the bar, on the screen
      expect(b.y, `${id} top at ${height}`).toBeGreaterThanOrEqual(sb.y - 1)
      expect(b.y + b.height, `${id} under the footer at ${height}`).toBeLessThanOrEqual(f.y + 1)
      expect(b.y + b.height, `${id} under the bar at ${height}`).toBeLessThanOrEqual(bar.y + 1)
      expect(b.y).toBeGreaterThanOrEqual(0)
    }
    // the last setting scrolls fully clear of the footer
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight))
    const last = sheet.locator('.tp-note').last()
    const [lb, fb] = [(await last.boundingBox())!, (await footer.boundingBox())!]
    expect(lb.y + lb.height).toBeLessThanOrEqual(fb.y + 1)
    await shot(page, test.info(), `phone-sheet-${height}.png`)
    // a chip at a finger's size
    expect((await sheet.locator('#sk-show-points').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // the opened sheet leaves the view above it to the finger: a real tap there reaches the view, and the sheet stays open
    // a spot of open view between the top bar and the sheet, clear of the view's own buttons
    const spot = await page.evaluate(() => {
      const top = document.querySelector('.topbar, header')!.getBoundingClientRect().bottom
      const sheetTop = document.querySelector('[data-testid="sketch-sheet-toggle"]')!.closest('.pane')!.getBoundingClientRect().top
      for (let y = top + 8; y < sheetTop - 8; y += 8)
        for (let x = 40; x < innerWidth - 40; x += 8) if (document.elementFromPoint(x, y)?.tagName === 'CANVAS') return [x, y] as [number, number]
      return null
    })
    expect(spot, `open view above the sheet at ${height}`).not.toBeNull()
    // the view hears the tap (as a pick or a sketch click, by where the plane lies in the view)
    await page.evaluate(() => {
      const w = window as unknown as { __taps: string[]; __vp: { on(e: string, f: (p: { kind?: string }) => void): void } }
      w.__taps = []
      w.__vp.on('sketch', (p) => w.__taps.push(`sketch:${p.kind}`))
      w.__vp.on('pick', () => w.__taps.push('pick'))
    })
    await page.touchscreen.tap(...spot!)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __taps: string[] }).__taps.filter((t) => t === 'pick' || t === 'sketch:click').length)).toBeGreaterThan(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.locator('body').press('Escape')
    // the Show chips are named toggles a finger can flip and flip back
    for (const id of ['#sk-show-profiles', '#sk-show-points', '#sk-show-dimensions', '#sk-show-constraints']) {
      const chip = sheet.locator(id)
      await expect(chip).toHaveAccessibleName(/^Show /)
      const was = await chip.getAttribute('aria-pressed')
      expect(was === 'true' || was === 'false', id).toBe(true)
      await chip.tap()
      await expect(chip).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true')
      await chip.tap()
      await expect(chip).toHaveAttribute('aria-pressed', was!)
    }
  })
}

// ---- the slow 3D view notice
test('on a phone the slow view notice is one bar icon with a finger-sized target', async ({ page }) => {
  await phoneStudio(page)
  await emit(page, 'degrade', { message: 'The 3D view will be slow here.', details: 'Hardware acceleration looks off in this browser.' })
  const icon = page.getByTestId('phone-view-notice')
  await expect(icon).toBeVisible()
  await expect(icon).toHaveAccessibleName('3D view is slow')
  // the hit area measured on the element a tap lands on, at least 44 by 44, and its corners still hit it
  const b = (await icon.boundingBox())!
  expect(b.width).toBeGreaterThanOrEqual(44)
  expect(b.height).toBeGreaterThanOrEqual(44)
  for (const [x, y] of [[b.x + 2, b.y + b.height / 2], [b.x + b.width - 2, b.y + b.height / 2], [b.x + b.width / 2, b.y + 2], [b.x + b.width / 2, b.y + b.height - 2]])
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-testid="phone-view-notice"]'), [x, y])).toBe(true)
  // it sits in the top bar, not over the view
  const bar = (await page.locator('.topbar, header').first().boundingBox())!
  expect(b.y).toBeGreaterThanOrEqual(bar.y - 0.5)
  expect(b.y + b.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5)
  await icon.tap()
  // the details say what to do, on the screen, and Esc puts them away
  const text = page.getByTestId('phone-view-notice-text')
  await expect(text).toBeVisible()
  await expect(text).toContainText('Hardware acceleration looks off in this browser.')
  await expect(icon).toHaveAttribute('aria-expanded', 'true')
  const tb = (await text.boundingBox())!
  expect(tb.x).toBeGreaterThanOrEqual(0)
  expect(tb.x + tb.width).toBeLessThanOrEqual(390)
  await expect(page.getByTestId('toast').filter({ hasText: 'The 3D view will be slow here.' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(text).toHaveCount(0)
  await expect(icon).toHaveAttribute('aria-expanded', 'false')
})

// ---- the on-screen keyboard and safe-area insets need the app to start with a fake visual viewport, so this keeps a page of its own
/** Model on a phone, CAD only, with the view ready. */
async function openPhoneModel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.e2e.cadOnly', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
}

cold('a phone with the keyboard up and safe-area insets: every solid field scrolls clear of the footer and the keyboard', async ({ page }) => {
  // the notch and home bar of a phone, as env(safe-area-inset-*) reads them
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as Parameters<typeof cdp.send>[0], { insets: { top: 47, bottom: 34, left: 12, right: 12 } } as never)
  // the on-screen keyboard: the visual viewport loses its height while the layout viewport keeps it, as on a phone
  await page.addInitScript(() => {
    const real = window.visualViewport
    if (!real) return
    const w = window as unknown as { __kb: number; __kbView: EventTarget }
    w.__kb = 0
    const fake = new EventTarget()
    for (const k of ['width', 'offsetLeft', 'pageLeft', 'pageTop', 'scale'] as const) Object.defineProperty(fake, k, { get: () => real[k] })
    Object.defineProperty(fake, 'height', { get: () => window.innerHeight - w.__kb })
    Object.defineProperty(fake, 'offsetTop', { get: () => 0 })
    w.__kbView = fake
    Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true })
  })
  await openPhoneModel(page)
  await page.getByTestId('phone-sketch').tap()
  const sheet = page.getByRole('complementary', { name: 'Tool and transform' })
  await expect(sheet).toContainText('Tap an origin plane')
  await emit(page, 'pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' })
  const toggle = page.getByTestId('sketch-sheet-toggle')
  for (const p of [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]] as [number, number][]) await phoneClick(page, p)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.tap()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  // the sheet keeps clear of the side insets
  const sb = (await sheet.boundingBox())!
  expect(sb.x).toBeGreaterThanOrEqual(12)
  expect(sb.x + sb.width).toBeLessThanOrEqual(390 - 12)
  // the keyboard comes up (300 px) as a field takes focus
  await page.evaluate(() => {
    const w = window as unknown as { __kb: number; __kbView: EventTarget }
    w.__kb = 300
    w.__kbView.dispatchEvent(new Event('resize'))
  })
  const kbTop = (await page.evaluate(() => window.innerHeight)) - 300
  const top = (await page.locator('.topbar, header').first().boundingBox())!
  const footer = sheet.locator('.cad-footer')
  for (const id of ['#sk-dist', '#sk-taper', '[data-testid="sketch-flip"]']) {
    const c = sheet.locator(id).first()
    await c.focus()
    await page.evaluate(() => (window as unknown as { __kbView: EventTarget }).__kbView.dispatchEvent(new Event('resize')))
    await c.scrollIntoViewIfNeeded()
    const [b, f, s] = [(await c.boundingBox())!, (await footer.boundingBox())!, (await sheet.boundingBox())!]
    // the footer above the keyboard, the field above the footer, and the sheet under the top bar
    expect(f.y + f.height, `footer over the keyboard, ${id}`).toBeLessThanOrEqual(kbTop + 1)
    expect(b.y + b.height, `${id} under the footer`).toBeLessThanOrEqual(f.y + 1)
    expect(b.y, `${id} under the top bar`).toBeGreaterThanOrEqual(top.y + top.height - 1)
    expect(s.y, `sheet under the top bar, ${id}`).toBeGreaterThanOrEqual(top.y + top.height - 1)
  }
  // the last setting still scrolls fully clear of the footer
  await sheet.locator('.sx-rail-body').evaluate((el) => (el.scrollTop = el.scrollHeight))
  const [lb, fb] = [(await sheet.locator('.tp-note').last().boundingBox())!, (await footer.boundingBox())!]
  expect(lb.y + lb.height).toBeLessThanOrEqual(fb.y + 1)
  await shot(page, test.info(), 'phone-keyboard.png')
})
