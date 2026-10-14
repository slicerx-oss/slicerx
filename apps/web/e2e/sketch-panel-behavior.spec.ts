// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the sketch panel behaves, beyond how it looks: typed lengths and angles land the committed end where they say,
// the sketch steps back and on with its own undo, the keyboard never gets stuck in the cursor pills and Esc steps
// back one level at a time, Finish sketch and Extrude stay apart (one primary at a time, and a bare Enter finishes
// nothing), every reason Extrude or Revolve is off shows, the footer never covers a setting at 900 px tall or less,
// and Other plane asks before it drops a drawing. On a phone, the folded sheet opens to every control and stays open.
import { type Page } from '@playwright/test'
import { command, facePick, freshBox, openStudio, pick, sketchAt, steps, toolPanel } from './cad-helpers'
import { expect, test } from './fixtures'

type Loop = { start?: [number, number]; segments?: { type: string; to: [number, number] }[]; type?: string }
interface SketchRead {
  tool: string
  profile?: string
  dof?: number | null
  ready?: boolean
  reason?: string | null
  loops?: Loop[]
}

/** The open sketch as app_state's `sketch` is built from it. */
const read = (page: Page) => page.evaluate(() => (window as unknown as { __sketch: () => SketchRead | null }).__sketch())

async function sketchOnTop(page: Page): Promise<string> {
  await openStudio(page)
  const id = await freshBox(page)
  await command(page, 'Sketch on the bed or a face')
  await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(toolPanel(page)).toContainText('A face of')
  return id
}

async function sketchOnBed(page: Page): Promise<void> {
  await openStudio(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Sketch on the bed or a face')
  await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(toolPanel(page)).toContainText('The bed')
}

const DEG = Math.PI / 180
const near = (got: [number, number], want: [number, number]) => {
  expect(got[0]).toBeCloseTo(want[0], 4)
  expect(got[1]).toBeCloseTo(want[1], 4)
}

/** Ctrl/Cmd+Z until the sketch is empty again, one step at a time. */
async function undoAll(page: Page): Promise<void> {
  for (let i = 0; i < 12 && (await read(page))?.profile !== 'none'; i++) {
    const n = JSON.stringify((await read(page))?.loops)
    await page.locator('body').press('ControlOrMeta+z')
    await expect.poll(async () => JSON.stringify((await read(page))?.loops)).not.toBe(n)
  }
  await expect.poll(async () => (await read(page))?.profile).toBe('none')
}

/** Types into the pills from the view: the first key opens the focused pill, Tab goes on to the next. */
async function typeSegment(page: Page, length: string, angle: string): Promise<void> {
  const pills = page.getByTestId('sketch-pills')
  await page.locator('body').press(length[0]!)
  const len = pills.getByRole('textbox', { name: 'Length mm' })
  await expect(len).toBeFocused()
  await len.fill(length)
  await len.press('Tab')
  const ang = pills.getByRole('textbox', { name: 'Angle °' })
  await expect(ang).toBeFocused()
  await ang.fill(angle)
}

test('typed length and angle put the committed end where they say, the next segment starts there, and undo steps the sketch only', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  const id = await sketchOnTop(page)
  const before = (await steps(page)).length
  const pills = page.getByTestId('sketch-pills')
  await sketchAt(page, 'click', [1, 2])
  // the cursor is far from where the numbers say; the numbers win
  await sketchAt(page, 'hover', [-7, 9])
  await typeSegment(page, '12', '30')
  await pills.getByRole('textbox', { name: 'Angle °' }).press('Enter')
  await expect(pills).not.toHaveAttribute('data-typing')
  const first: [number, number] = [1 + 12 * Math.cos(30 * DEG), 2 + 12 * Math.sin(30 * DEG)]
  await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length).toBe(1)
  let s = (await read(page))!
  near(s.loops![0]!.start!, [1, 2])
  near(s.loops![0]!.segments![0]!.to, first)
  // the next segment starts at the typed end: the live length reads from there
  await sketchAt(page, 'hover', [first[0] + 3, first[1] + 4])
  await expect(pills.locator('[data-label="Length"]')).toContainText('5.00')
  // a second typed segment, 5 mm at 120 degrees, measured the same way
  await typeSegment(page, '5', '120')
  await page.keyboard.press('Enter')
  const second: [number, number] = [first[0] + 5 * Math.cos(120 * DEG), first[1] + 5 * Math.sin(120 * DEG)]
  await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length).toBe(2)
  s = (await read(page))!
  near(s.loops![0]!.segments![1]!.to, second)
  // a length of 0 places nothing and says why
  await typeSegment(page, '0', '45')
  await page.keyboard.press('Enter')
  await expect(toolPanel(page)).toContainText('The length must be more than 0 mm.')
  expect((await read(page))!.loops![0]!.segments!.length).toBe(2)
  await pills.getByRole('textbox', { name: 'Angle °' }).press('Escape')
  await pills.getByRole('textbox', { name: 'Angle °' }).press('Escape')
  await page.locator('body').press('Escape')
  // Ctrl/Cmd+Z steps the drawing back one segment at a time and redo brings it again; the model's history is untouched
  await page.locator('body').press('ControlOrMeta+z')
  await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length ?? 0).toBe(1)
  near((await read(page))!.loops![0]!.segments![0]!.to, first)
  await page.locator('body').press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.length).toBe(2)
  expect((await steps(page)).length).toBe(before)
  expect(await page.evaluate((id) => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate.some((e) => e.id === id), id)).toBe(true)
})

test('the keyboard is never stuck in the pills, and Esc steps back one level at a time without closing the sketch', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  const pills = page.getByTestId('sketch-pills')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'hover', [4, 3])
  await typeSegment(page, '10', '90')
  // Tab past the last pill leaves them for the view, the numbers kept; the next Tab goes on through the page
  await pills.getByRole('textbox', { name: 'Angle °' }).press('Tab')
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('CANVAS')
  await expect(pills.getByRole('textbox', { name: 'Length mm' })).toHaveValue('10')
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="sketch-pills"]'))).toBe(false)
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('CANVAS')
  // Shift+Tab before the first pill leaves too
  await pills.getByRole('textbox', { name: 'Length mm' }).focus()
  await pills.getByRole('textbox', { name: 'Length mm' }).press('Shift+Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="sketch-pills"]'))).toBe(false)
  // Enter back in the view places the kept numbers
  await page.locator('canvas.vp-canvas').focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await read(page))?.loops?.[0]?.segments?.[0]?.to?.[1]).toBeCloseTo(10, 4)
  // Esc ladder: typed value, typing, the pending segment, the tool, and the sketch stays open
  await typeSegment(page, '4', '0')
  const angle = pills.getByRole('textbox', { name: 'Angle °' })
  await angle.press('Escape')
  await expect(angle).toHaveValue('')
  await angle.press('Escape')
  await expect(pills).not.toHaveAttribute('data-typing')
  await page.locator('body').press('Escape')
  await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
  await page.locator('body').press('Escape')
  await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Select')
  await page.locator('body').press('Escape')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('A face of')
  // Tab from the view walks the page; it no longer moves between pills
  await page.locator('body').press('l')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'hover', [2, 2])
  await page.locator('canvas.vp-canvas').focus()
  await page.keyboard.press('Tab')
  await expect(pills.locator('[data-label="Length"]')).toHaveAttribute('data-focus', '')
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('CANVAS')
})

test('Finish sketch and Extrude stay apart: one primary, Ctrl/Cmd+Enter finishes, a bare Enter does not', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  const finish = page.getByTestId('sketch-finish')
  const extrude = panel.getByTestId('model-tool-apply')
  // while drawing, Finish sketch is the primary and Extrude is off with its reason
  await expect(finish).toHaveAttribute('data-variant', 'primary')
  await expect(extrude).toBeDisabled()
  await expect(extrude).not.toHaveAttribute('data-variant', 'primary')
  await expect(panel.getByTestId('model-tool-reason')).toHaveText('Draw a closed outline to make a solid.')
  await expect(finish).toHaveAttribute('data-tip-key', /Enter$/)
  // a closed rectangle: Extrude takes the primary, Finish sketch steps back
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(extrude).toBeEnabled()
  await expect(extrude).toHaveAttribute('data-variant', 'primary')
  await expect(finish).not.toHaveAttribute('data-variant', 'primary')
  await expect(panel.getByTestId('model-tool-reason')).toHaveCount(0)
  // a bare Enter in the view, twice, neither finishes nor extrudes
  const timeline = await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline?: unknown[] } } }).__sx.getState().timeline?.length ?? 0)
  await page.locator('body').press('Enter')
  await page.locator('body').press('Enter')
  await expect(panel).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline?: unknown[] } } }).__sx.getState().timeline?.length ?? 0)).toBe(timeline)
  // Ctrl/Cmd+Enter is Finish sketch: the sketch goes in the timeline with no solid
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('toast').filter({ hasText: 'is in the timeline' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline?: unknown[] } } }).__sx.getState().timeline?.length ?? 0)).toBe(timeline + 1)
})

test('Extrude and Revolve say why they are off: open, crossing, no axis, no body to cut', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnBed(page)
  const panel = toolPanel(page)
  const reason = panel.getByTestId('model-tool-reason')
  const apply = panel.getByTestId('model-tool-apply')
  // an open line
  for (const p of [[0, 0], [10, 0], [10, 10]] as [number, number][]) await sketchAt(page, 'click', p)
  await expect(reason).toHaveText('End the shape being drawn first (Esc or a right click).')
  await page.locator('body').press('Escape')
  await expect(reason).toHaveText('Close the outline to make a solid.')
  await expect.poll(async () => (await read(page))?.profile).toBe('open')
  // undo back to nothing, then a bow tie: closed, but it crosses itself
  await undoAll(page)
  for (const p of [[20, 0], [30, 10], [30, 0], [20, 10], [20, 0]] as [number, number][]) await sketchAt(page, 'click', p)
  await expect.poll(async () => (await read(page))?.profile).toBe('invalid')
  await expect(apply).toBeDisabled()
  await expect(reason).toBeVisible()
  expect((await reason.textContent())!.length).toBeGreaterThan(5)
  expect((await read(page))!.ready).toBe(false)
  // undo the bow tie, draw a square: valid, and the read-back agrees
  await undoAll(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'click', [10, 10])
  await expect.poll(async () => (await read(page))?.profile).toBe('valid')
  await expect(apply).toBeEnabled()
  expect((await read(page))!.reason).toBeNull()
  // on the bed there is no body: Join and Cut say why they are off
  await expect(panel.getByTestId('sketch-result-reason')).toBeVisible()
  await expect(panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' })).toBeDisabled()
  // Revolve with no axis picked
  await page.getByTestId('sketch-solid').getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Revolve' }).click()
  await expect(apply).toBeDisabled()
  await expect(reason).toHaveText('Pick a straight line of the sketch as the axis.')
})

for (const height of [900, 760, 640, 560]) {
  test(`at 1440 by ${height} the footer never covers a setting`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Modeling tools are desktop only')
    await page.setViewportSize({ width: 1440, height })
    await sketchOnTop(page)
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    const solid = page.getByTestId('sketch-solid')
    await expect(solid).not.toHaveAttribute('data-muted')
    const panel = toolPanel(page)
    const footer = panel.locator('.cad-footer')
    // every control of the solid card, focused in turn as Tab would, sits clear of the footer
    const controls = solid.locator('input, button, select, [role="radio"]')
    const n = await controls.count()
    expect(n).toBeGreaterThan(5)
    for (let i = 0; i < n; i++) {
      const c = controls.nth(i)
      if (!(await c.isVisible()) || (await c.isDisabled())) continue
      await c.focus()
      const [b, f] = [(await c.boundingBox())!, (await footer.boundingBox())!]
      expect(b.y + b.height, `control ${i} at ${height}`).toBeLessThanOrEqual(f.y + 1)
      expect(b.y, `control ${i} at ${height}`).toBeGreaterThanOrEqual(0)
    }
    // scrolled to the end, the last setting ends above the footer
    await panel.evaluate((el) => {
      const s = el.closest('.sx-rail-body')
      if (s) s.scrollTop = s.scrollHeight
    })
    const last = solid.locator('.tp-card-body > :last-child')
    const [lb, fb] = [(await last.boundingBox())!, (await footer.boundingBox())!]
    expect(lb.y + lb.height).toBeLessThanOrEqual(fb.y + 1)
    await page.screenshot({ path: test.info().outputPath(`footer-${height}.png`) })
  })
}

test('Other plane asks before it drops a drawing', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await panel.getByTestId('sketch-other-plane').click()
  await expect(panel.getByTestId('sketch-plane-ask')).toBeVisible()
  await panel.getByTestId('sketch-plane-keep').click()
  await expect(panel.getByTestId('sketch-plane-ask')).toHaveCount(0)
  await expect.poll(async () => (await read(page))?.loops?.length).toBe(1)
  await panel.getByTestId('sketch-other-plane').click()
  await panel.getByTestId('sketch-plane-drop').click()
  await expect(panel).toContainText('Click an origin plane')
})
