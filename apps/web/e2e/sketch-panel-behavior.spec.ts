// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the sketch panel behaves, beyond how it looks: typed lengths and angles land the committed end where they say,
// the sketch steps back and on with its own undo, the keyboard never gets stuck in the cursor pills and Esc steps
// back one level at a time, Finish sketch and Extrude stay apart (one primary at a time, Finish sketch while drawing
// and Extrude for a valid profile, and a bare Enter finishes nothing), every reason Extrude or Revolve is off shows, the footer never covers a setting at 900 px tall or less,
// and Other plane asks before it drops a drawing. On a phone, the folded sheet opens to every control and stays open.
import { type Page } from '@playwright/test'
import { bounds, command, facePick, freshBox, openStudio, pick, sketchAt, steps, toolPanel } from './cad-helpers'
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

/** A hover with Alt held, so no snap moves the cursor off the exact spot. */
const hoverFree = (page: Page, at: [number, number]) =>
  page.evaluate((at) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind: 'hover', at, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: true }), at)
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
  await hoverFree(page, [first[0] + 3, first[1] + 4])
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

/** Every preview the view is handed from now on, newest last: where the preview's end sits. */
async function watchPreview(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __previews: ([number, number] | null)[]; __vp: { setSketchCursor(c: { at?: [number, number] | null } | null): void } }
    w.__previews = []
    const set = w.__vp.setSketchCursor.bind(w.__vp)
    w.__vp.setSketchCursor = (c) => {
      w.__previews.push(c?.at ?? null)
      set(c)
    }
  })
}
const lastPreview = (page: Page) => page.evaluate(() => (window as unknown as { __previews: ([number, number] | null)[] }).__previews.at(-1) ?? null)
const segments = async (page: Page) => (await read(page))?.loops?.[0]?.segments ?? []
const units = (page: Page, length: 'mm' | 'in') =>
  page.evaluate((length) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ units: { length, mmDigits: 2, inchDigits: 3, inchFraction: 0 } }), length)

test('typed numbers move the preview before Enter and land exactly: decimals, a negative angle, inches, inferred level and upright, and bad input refused', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  await watchPreview(page)
  const pills = page.getByTestId('sketch-pills')
  const len = () => pills.getByRole('textbox', { name: /^Length / })
  const ang = () => pills.getByRole('textbox', { name: /^Angle / })
  // the snap is on (a hover without Alt): the typed numbers still win over the grid
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'hover', [5, 5])
  // a decimal length moves the preview at once, along the cursor's direction, before any Enter
  await page.locator('body').press('7')
  await len().fill('7.25')
  await expect.poll(() => lastPreview(page)).not.toBeNull()
  near((await lastPreview(page))!, [7.25 * Math.cos(45 * DEG), 7.25 * Math.sin(45 * DEG)])
  // a negative decimal angle turns it below the axis, still before Enter
  await len().press('Tab')
  await expect(ang()).toBeFocused()
  await ang().fill('-33.5')
  const typedEnd: [number, number] = [7.25 * Math.cos(-33.5 * DEG), 7.25 * Math.sin(-33.5 * DEG)]
  await expect.poll(async () => (await lastPreview(page))?.[1] ?? 0).toBeLessThan(0)
  near((await lastPreview(page))!, typedEnd)
  expect(await segments(page)).toHaveLength(0)
  // Shift+Tab goes back to the length with both numbers kept, and Enter there commits them
  await ang().press('Shift+Tab')
  await expect(len()).toBeFocused()
  await expect(len()).toHaveValue('7.25')
  await expect(ang()).toHaveValue('-33.5')
  await len().press('Enter')
  await expect.poll(async () => (await segments(page)).length).toBe(1)
  near((await segments(page))[0]!.to, typedEnd)
  // the next segment is an ordinary one: a click places it from the typed end
  const free = (kind: 'hover' | 'click', at: [number, number]) =>
    page.evaluate(({ kind, at }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('sketch', { kind, at, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: true }), { kind, at })
  const clicked: [number, number] = [typedEnd[0] + 1.5, typedEnd[1] + 6.5]
  await free('hover', clicked)
  await free('click', clicked)
  await expect.poll(async () => (await segments(page)).length).toBe(2)
  near((await segments(page))[1]!.to, clicked)
  // junk, a negative length and zero change nothing and say why; nothing NaN lands in the sketch
  const before = await segments(page)
  const same = async () => {
    const now = await segments(page)
    expect(now).toHaveLength(before.length)
    now.forEach((g, i) => near(g.to, before[i]!.to))
    for (const g of now) expect(g.to.every(Number.isFinite)).toBe(true)
  }
  for (const [bad, why] of [['abc', 'Type numbers only.'], ['-5', 'The length must be more than 0 mm.'], ['0', 'The length must be more than 0 mm.']] as const) {
    if (!(await len().isVisible())) await page.locator('body').press('1')
    await len().fill(bad)
    await len().press('Enter')
    await expect(toolPanel(page).getByRole('status').filter({ hasText: why })).toBeVisible()
    await same()
  }
  // emptied pills take the cursor, as a click there would
  await len().fill('')
  await free('hover', [clicked[0] + 4, clicked[1] + 1.3])
  await len().press('Enter')
  await expect.poll(async () => (await segments(page)).length).toBe(3)
  near((await segments(page))[2]!.to, [clicked[0] + 4, clicked[1] + 1.3])
  // inches: a bare 1 is 25.4 mm, and a typed unit wins over the setting; the level and upright ends get their constraints
  await units(page, 'in')
  await page.locator('body').press('1')
  await expect(pills.getByRole('textbox', { name: 'Length in' })).toBeFocused()
  await len().fill('1')
  await len().press('Tab')
  await ang().fill('0')
  await ang().press('Enter')
  await expect.poll(async () => (await segments(page)).length).toBe(4)
  const start = (await segments(page))[2]!.to
  near((await segments(page))[3]!.to, [start[0] + 25.4, start[1]])
  await page.locator('body').press('1')
  await len().fill('10mm')
  await len().press('Tab')
  await ang().fill('90')
  await ang().press('Enter')
  await expect.poll(async () => (await segments(page)).length).toBe(5)
  near((await segments(page))[4]!.to, [start[0] + 25.4, start[1] + 10])
  const glyphs = () => page.evaluate(() => (window as unknown as { __vp: { sketchLayer: { scene: { glyphs?: { kind: string }[] } | null } } }).__vp.sketchLayer.scene?.glyphs?.map((g) => g.kind).sort() ?? [])
  await expect.poll(glyphs).toEqual(expect.arrayContaining(['horizontal', 'vertical']))
  await units(page, 'mm')
  // undo steps back the typed point and redo puts it back where it was
  await page.locator('body').press('Escape')
  await page.locator('body').press('ControlOrMeta+z')
  await expect.poll(async () => (await segments(page)).length).toBe(4)
  await page.locator('body').press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await segments(page)).length).toBe(5)
  near((await segments(page))[4]!.to, [start[0] + 25.4, start[1] + 10])
})

test('the keyboard is never stuck in the pills, and Esc steps back one level at a time without closing the sketch', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  const pills = page.getByTestId('sketch-pills')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'hover', [4, 3])
  await typeSegment(page, '10', '90')
  // Tab past the last pill goes on into the panel, the numbers kept; Tab goes on through the panel from there
  await pills.getByRole('textbox', { name: 'Angle °' }).press('Tab')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
  await expect(pills.getByRole('textbox', { name: 'Length mm' })).toHaveValue('10')
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
  // Shift+Tab before the first pill goes back to the view
  await pills.getByRole('textbox', { name: 'Length mm' }).focus()
  await pills.getByRole('textbox', { name: 'Length mm' }).press('Shift+Tab')
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('CANVAS')
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
  // while a line is drawn, Tab in the panel walks the panel's controls; it no longer moves between pills
  await page.locator('body').press('l')
  await expect(page.getByTestId('sketch-drawing').locator('h4')).toHaveText('Drawing · Line')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'hover', [2, 2])
  await expect(pills.locator('[data-label="Length"]')).toHaveAttribute('data-focus', '')
  await panel.locator('#sk-grid').focus()
  await page.keyboard.press('Tab')
  await expect(pills.locator('[data-label="Length"]')).toHaveAttribute('data-focus', '')
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('sk-grid')
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-section="cad-tool"]'))).toBe(true)
})

test('Finish sketch and Extrude stay apart: one primary, Ctrl/Cmd+Enter finishes, a bare Enter does not', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  const panel = toolPanel(page)
  const finish = page.getByTestId('sketch-finish')
  const extrude = panel.getByTestId('model-tool-apply')
  // while drawing, Finish sketch is the primary and Extrude is off with its reason, in the plain look
  await expect(finish).not.toHaveAttribute('aria-disabled', 'true')
  await expect(finish).toHaveAttribute('data-variant', 'primary')
  await expect(extrude).toBeDisabled()
  await expect(extrude).not.toHaveAttribute('data-variant', 'primary')
  await expect(panel.getByTestId('model-tool-reason')).toHaveText('Draw a closed outline to make a solid.')
  await expect(finish).toHaveAttribute('data-tip-key', /Enter$/)
  // a closed rectangle: Extrude takes the primary and Finish sketch goes plain, with exactly one primary in every
  // painted frame on the way (never both, never neither)
  await page.evaluate(() => {
    const w = window as unknown as { __off: number; __frames: number; __watch: boolean }
    w.__off = 0
    w.__frames = 0
    w.__watch = true
    const tick = () => {
      const n = document.querySelectorAll('[data-testid="sketch-finish"][data-variant="primary"], [data-section="cad-tool"] [data-testid="model-tool-apply"][data-variant="primary"]').length
      w.__frames++
      if (n !== 1) w.__off++
      if (w.__watch) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(extrude).toBeEnabled()
  await expect(extrude).toHaveAttribute('data-variant', 'primary')
  await expect(finish).not.toHaveAttribute('data-variant', 'primary')
  await page.waitForTimeout(300)
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __off: number; __frames: number; __watch: boolean }
    w.__watch = false
    return { off: w.__off, frames: w.__frames }
  })
  expect(frames.frames).toBeGreaterThan(0)
  expect(frames.off).toBe(0)
  await expect(panel.getByTestId('model-tool-reason')).toHaveCount(0)
  // a bare Enter in the view, twice, neither finishes nor extrudes
  const bodies = () => page.evaluate(() => JSON.stringify((window as unknown as { __sx: { getState(): { plate: { id: string; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.map((e) => [e.id, e.parts.map((p) => Array.from(p.positions).reduce((a, v) => a + v, 0).toFixed(3))])))
  const model = await bodies()
  const timeline = await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)
  await page.locator('body').press('Enter')
  await page.locator('body').press('Enter')
  await expect(panel).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)).toBe(timeline)
  // Ctrl/Cmd+Enter is Finish sketch: the sketch goes in the timeline with no solid
  await page.locator('body').press('ControlOrMeta+Enter')
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('toast').filter({ hasText: 'is in the timeline' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)).toBe(timeline + 1)
  // Finish sketch made no solid: the same bodies with the same geometry
  expect(await bodies()).toBe(model)
})

test('Cancel backs out of the sketch: the drawing goes, the model and its timeline stay', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  const id = await sketchOnTop(page)
  const panel = toolPanel(page)
  const box = await bounds(page, id)
  const timeline = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)
  const was = await timeline()
  const stepsWere = (await steps(page)).length
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect(panel.getByTestId('model-tool-apply')).toBeEnabled()
  // Cancel is its own button, apart from Finish sketch and Extrude, and says what it does
  const cancel = panel.getByTestId('model-tool-cancel')
  await expect(cancel).toHaveText('Cancel')
  await expect(cancel).toHaveAttribute('data-tip-title', 'Close the tool')
  await cancel.click()
  await expect(panel).toHaveCount(0)
  expect(await timeline()).toBe(was)
  expect((await steps(page)).length).toBe(stepsWere)
  expect(await bounds(page, id)).toEqual(box)
  expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
})

test('Extrude makes what the panel says: a cut of the typed depth and size into the face, kept as an editable step', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.slow()
  const id = await sketchOnTop(page)
  const panel = toolPanel(page)
  const box = await bounds(page, id)
  // the corners the body has at a height, on the bed, as their extent: [width, depth], or null with none there
  const at = (z: number) =>
    page.evaluate(({ id, z }) => {
      const e = (window as unknown as { __sx: { getState(): { plate: { id: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }[] } } }).__sx.getState().plate.find((p) => p.id === id)!
      const m = e.transform
      const xs: number[] = []
      const ys: number[] = []
      for (const part of e.parts)
        for (let i = 0; i < part.positions.length; i += 3) {
          const [x, y, w] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
          if (Math.abs(m[2]! * x + m[6]! * y + m[10]! * w + m[14]! - z) > 0.01) continue
          xs.push(m[0]! * x + m[4]! * y + m[8]! * w + m[12]!)
          ys.push(m[1]! * x + m[5]! * y + m[9]! * w + m[13]!)
        }
      return xs.length ? [Math.round((Math.max(...xs) - Math.min(...xs)) * 1000) / 1000, Math.round((Math.max(...ys) - Math.min(...ys)) * 1000) / 1000] : null
    }, { id, z })
  const floor = box.max[2] - 5
  expect(await at(floor)).toBeNull()
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  const result = panel.getByRole('radiogroup', { name: 'Result' })
  await result.getByRole('radio', { name: 'Cut' }).click()
  await expect(result.getByRole('radio', { name: 'Cut' })).toHaveAttribute('aria-checked', 'true')
  await panel.locator('#sk-dist').fill('5')
  await panel.getByTestId('model-tool-apply').click()
  await expect(panel).toHaveCount(0, { timeout: 30_000 })
  // the box keeps its outside; the pocket's floor is a 6 by 6 square, 5 mm under the top, and nothing goes deeper
  await expect.poll(() => at(floor), { timeout: 30_000 }).toEqual([6, 6])
  expect((await bounds(page, id)).min).toEqual(box.min)
  expect((await bounds(page, id)).max).toEqual(box.max)
  expect(await at(floor - 1)).toBeNull()
  // the step is in the history and opens again with what was typed
  await page.getByRole('button', { name: /^Edit / }).first().click()
  const again = toolPanel(page)
  await expect(again).toBeVisible()
  await expect(again.locator('#sk-dist')).toHaveValue('5')
  await expect(again.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' })).toHaveAttribute('aria-checked', 'true')
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
  // the button itself carries the reason, is not the primary, and Finish sketch is there to press, as the primary
  const finish = page.getByTestId('sketch-finish')
  await expect(apply).toHaveAccessibleDescription('Close the outline to make a solid.')
  await expect(apply).not.toHaveAttribute('data-variant', 'primary')
  await expect(finish).not.toHaveAttribute('aria-disabled', 'true')
  await expect(finish).toHaveAttribute('data-variant', 'primary')
  // undo back to nothing, then a bow tie: closed, but it crosses itself
  await undoAll(page)
  for (const p of [[20, 0], [30, 10], [30, 0], [20, 10], [20, 0]] as [number, number][]) await sketchAt(page, 'click', p)
  await expect.poll(async () => (await read(page))?.profile).toBe('invalid')
  await expect(apply).toBeDisabled()
  await expect(reason).toBeVisible()
  expect((await reason.textContent())!.length).toBeGreaterThan(5)
  expect((await read(page))!.ready).toBe(false)
  // no false success: Extrude is not the primary (Finish sketch still is), the reason is its description, and the
  // read-back gives the same reason
  await expect(apply).not.toHaveAttribute('data-variant', 'primary')
  await expect(finish).toHaveAttribute('data-variant', 'primary')
  await expect(apply).toHaveAccessibleDescription((await reason.textContent())!)
  expect((await read(page))!.reason).toBe(await reason.textContent())
  // undo the bow tie, draw a square: valid, and the read-back agrees
  await undoAll(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [0, 0])
  await sketchAt(page, 'click', [10, 10])
  await expect.poll(async () => (await read(page))?.profile).toBe('valid')
  await expect(apply).toBeEnabled()
  expect((await read(page))!.reason).toBeNull()
  await expect(apply).toHaveAttribute('data-variant', 'primary')
  await expect(finish).not.toHaveAttribute('data-variant', 'primary')
  // on the bed there is no body: Join and Cut say why they are off
  await expect(panel.getByTestId('sketch-result-reason')).toBeVisible()
  await expect(panel.getByRole('radiogroup', { name: 'Result' }).getByRole('radio', { name: 'Cut' })).toBeDisabled()
  // Revolve with no axis picked
  await page.getByTestId('sketch-solid').getByRole('radiogroup', { name: 'Finish with' }).getByRole('radio', { name: 'Revolve' }).click()
  await expect(apply).toBeDisabled()
  await expect(reason).toHaveText('Pick a straight line of the sketch as the axis.')
})

for (const [width, height] of [[1440, 900], [1440, 760], [1440, 640], [1440, 560], [1100, 900], [1100, 700]] as const) {
  test(`at ${width} by ${height} the footer never covers a setting`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Modeling tools are desktop only')
    await page.setViewportSize({ width, height })
    await openStudio(page)
    const id = await freshBox(page)
    await command(page, 'Sketch on the bed or a face')
    // at 1100 the side panes start folded
    const open = page.getByRole('button', { name: 'Open Tool and transform' })
    if (await open.isVisible()) await open.click()
    await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(toolPanel(page)).toContainText('A face of')
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

test('the solid card lines its controls up on one right edge', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  await sketchOnTop(page)
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  const solid = page.getByTestId('sketch-solid')
  await expect(solid).not.toHaveAttribute('data-muted')
  const edges = await solid.locator('.tp-card-body').evaluate((body) => {
    const right = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight)
    const out: { what: string; gap: number }[] = []
    for (const el of body.querySelectorAll<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]), select, [role="radiogroup"], .sx-seg')) {
      const r = el.getBoundingClientRect()
      if (!r.width) continue
      // a segmented control is measured by its frame, not its last button inside the frame's padding
      out.push({ what: el.getAttribute('aria-label') ?? el.id, gap: Math.round((right - r.right) * 10) / 10 })
    }
    return out
  })
  expect(edges.length).toBeGreaterThan(2)
  for (const e of edges) expect(Math.abs(e.gap), e.what).toBeLessThanOrEqual(1)
})

for (const width of [1100, 1440]) {
  test(`at ${width} the drawing card's header says its state whole, for every tool`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Modeling tools are desktop only')
    await page.setViewportSize({ width, height: 900 })
    await openStudio(page)
    const id = await freshBox(page)
    await command(page, 'Sketch on the bed or a face')
    // at 1100 the side panes start folded
    const open = page.getByRole('button', { name: 'Open Tool and transform' })
    if (await open.isVisible()) await open.click()
    await expect(toolPanel(page)).toContainText('the bed or a flat face to sketch on')
    await pick(page, await facePick(page, id, [0, 0, 1]))
    await expect(toolPanel(page)).toContainText('A face of')
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    const dof = page.getByTestId('sketch-dof')
    await expect(dof).toHaveText('4 DOF left')
    await expect(dof).toHaveAttribute('data-tip-title', '4 degrees of freedom left')
    const head = page.getByTestId('sketch-drawing').locator('.tp-card-h')
    const families = toolPanel(page).getByRole('radiogroup', { name: 'Drawing tool' })
    for (const name of ['Line', 'Rectangle', 'Circle', 'Arc', 'Polygon', 'Slot', 'Trim', 'Dimension']) {
      await families.getByRole('radio', { name }).click()
      const cut = await head.evaluate((h) => [...h.querySelectorAll<HTMLElement>('h4, .tp-card-state')].filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent))
      expect(cut, `${name} at ${width}`).toEqual([])
      // and the two never overlap
      const [t, st] = await head.evaluate((h) => [h.querySelector('h4')!.getBoundingClientRect().right, h.querySelector('.tp-card-state')!.getBoundingClientRect().left])
      expect(t!, `${name} at ${width}`).toBeLessThanOrEqual(st! + 0.5)
    }
  })
}

test('Other plane asks before it drops a drawing: Keep and Esc keep all of it, Drop changes plane only when chosen', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  const id = await sketchOnTop(page)
  const panel = toolPanel(page)
  const head = page.getByTestId('sketch-drawing').locator('h4')
  await page.locator('body').press('r')
  await sketchAt(page, 'click', [-3, -3])
  await sketchAt(page, 'click', [3, 3])
  await expect.poll(async () => (await read(page))?.loops?.length).toBe(1)
  const drawn = JSON.stringify((await read(page))?.loops)
  const plane = await page.evaluate(() => JSON.stringify((window as unknown as { __sketch: () => { on?: string; label?: string } | null }).__sketch()?.label))
  expect(plane).toContain('face')
  const other = panel.getByTestId('sketch-other-plane')
  const ask = panel.getByTestId('sketch-plane-ask')
  await expect(page.getByTestId('sketch-solid')).not.toHaveAttribute('data-muted')
  await expect(other).toHaveAttribute('aria-expanded', 'false')
  // asked from the keyboard: the question shows and is announced, focus stays on Other plane (expanded), Tab reaches it
  await other.focus()
  await page.keyboard.press('Enter')
  await expect(ask).toBeVisible()
  await expect(ask.getByRole('status')).toHaveText(/this drawing goes/)
  await expect(other).toBeFocused()
  await expect(other).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Tab')
  await expect(panel.getByTestId('sketch-plane-keep')).toBeFocused()
  // Keep drawing: the question goes, the drawing, the tool and the plane stay as they were
  await page.keyboard.press('Enter')
  await expect(ask).toHaveCount(0)
  expect(JSON.stringify((await read(page))?.loops)).toBe(drawn)
  await expect(head).toHaveText('Drawing · Rectangle')
  expect(await page.evaluate(() => JSON.stringify((window as unknown as { __sketch: () => { label?: string } | null }).__sketch()?.label))).toBe(plane)
  // Esc answers it the same way and gives focus back to Other plane
  await other.click()
  await expect(ask).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)
  await expect(other).toBeFocused()
  await expect(head).toHaveText('Drawing · Rectangle')
  expect(JSON.stringify((await read(page))?.loops)).toBe(drawn)
  // Drop it and pick a plane: only now does the plane go, and the drawing with it, never into the timeline
  const timeline = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { timeline: { items: unknown[] } } } }).__sx.getState().timeline.items.length)
  const was = await timeline()
  await other.click()
  await panel.getByTestId('sketch-plane-drop').click()
  await expect(panel).toContainText('Click an origin plane')
  expect(await timeline()).toBe(was)
  // a dropped drawing has no undo: the next sketch starts empty, and its undo does not reach the model
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await expect.poll(async () => (await read(page))?.profile).toBe('none')
  await page.locator('body').press('ControlOrMeta+z')
  await page.waitForTimeout(300)
  expect((await read(page))?.profile).toBe('none')
  expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
})

for (const scheme of ['dark', 'light'] as const) {
  test(`in ${scheme}: every panel control and pill shows its focus, has a name, and no text is cut off`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Modeling tools are desktop only')
    await sketchOnTop(page)
    await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
    await expect(page.locator(`html[data-scheme="${scheme}"]`)).toHaveCount(1)
    const panel = toolPanel(page)
    // an open outline first: Extrude is off, and its reason is its description
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'click', [5, 0])
    await page.locator('body').press('Escape')
    const apply = panel.getByTestId('model-tool-apply')
    await expect(apply).toBeDisabled()
    await expect(apply).toHaveAccessibleDescription('Close the outline to make a solid.')
    await page.locator('body').press('ControlOrMeta+z')
    await expect.poll(async () => (await read(page))?.profile).toBe('none')
    // then a closed square, so the solid card's controls are all there
    await page.locator('body').press('r')
    await sketchAt(page, 'click', [-3, -3])
    await sketchAt(page, 'click', [3, 3])
    await expect(apply).toBeEnabled()
    // the focus mark on each control the keyboard reaches: there, and at least 3:1 against the panel (a non-text contrast)
    const focusMark = () =>
      page.evaluate(() => {
        const lum = (c: string) => {
          const m = c.match(/[\d.]+/g)!.map(Number)
          const [r, g, b] = (c.startsWith('color(') ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3)).map((v) => {
            const x = v / 255
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
        }
        const alpha = (c: string) => {
          const m = c.match(/[\d.]+/g)!.map(Number)
          return c.startsWith('color(') ? (m[3] ?? 1) : c.startsWith('rgba') ? m[3]! : 1
        }
        const a = document.activeElement as HTMLElement
        let bg = 'rgb(0, 0, 0)'
        for (let e: HTMLElement | null = a.parentElement; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor
          if (alpha(c) > 0.9) {
            bg = c
            break
          }
        }
        const cs = getComputedStyle(a)
        const mark = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1 ? cs.outlineColor : cs.borderColor
        const [l1, l2] = [lum(mark), lum(bg)]
        return {
          name: a.getAttribute('aria-label') ?? a.id ?? a.textContent,
          inPanel: !!a.closest('[data-section="cad-tool"]'),
          visible: a.matches(':focus-visible') && (cs.outlineStyle !== 'none' || cs.boxShadow !== 'none'),
          ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
        }
      })
    await panel.getByTestId('sketch-other-plane').focus()
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      const f = await focusMark()
      if (!f.inPanel) break
      seen.add(f.name ?? '')
      expect(f.visible, `${f.name} in ${scheme}`).toBe(true)
      // read once the field's border has eased to the accent
      await expect.poll(async () => (await focusMark()).ratio, { message: `${f.name} in ${scheme}`, timeout: 2000 }).toBeGreaterThanOrEqual(3)
    }
    expect(seen.size).toBeGreaterThan(8)
    // names, values and states: every control has a name, every radio says whether it is on
    const unnamed = await panel.evaluate((p) =>
      [...p.querySelectorAll<HTMLElement>('button, input, select, [role="radio"]')]
        .filter((e) => e.getClientRects().length && !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e.id && p.querySelector(`label[for="${e.id}"]`)) || (e.textContent ?? '').trim() || e.closest('label')))
        .map((e) => e.outerHTML.slice(0, 80)),
    )
    expect(unnamed).toEqual([])
    for (const r of await panel.getByRole('radio').all()) expect(['true', 'false']).toContain(await r.getAttribute('aria-checked'))
    // nothing cut off in the panel
    const cut = (root: string) =>
      page.evaluate((root) => [...document.querySelectorAll<HTMLElement>(`${root} *`)].filter((e) => e.getClientRects().length && e.children.length === 0 && (e.textContent ?? '').trim() && e.scrollWidth > e.clientWidth + 0.5 && getComputedStyle(e).overflowX !== 'visible').map((e) => e.textContent), root)
    expect(await cut('[data-section="cad-tool"]')).toEqual([])
    // the pills while typing: their field shows the focus ring, and their text fits
    await page.locator('body').press('l')
    await sketchAt(page, 'click', [8, 8])
    await sketchAt(page, 'hover', [12, 11])
    await page.locator('body').press('2')
    const len = page.getByTestId('sketch-pills').getByRole('textbox', { name: 'Length mm' })
    await expect(len).toBeFocused()
    await len.fill('123.456')
    const pill = await focusMark()
    expect(pill.visible || (await len.evaluate((e) => getComputedStyle(e.closest('.sketch-pill')!).outlineStyle !== 'none' || getComputedStyle(e.closest('.sketch-pill')!).boxShadow !== 'none'))).toBe(true)
    expect(await cut('[data-testid="sketch-pills"]')).toEqual([])
    expect(await len.evaluate((e: HTMLInputElement) => e.scrollWidth <= e.clientWidth + 0.5)).toBe(true)
  })
}

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

const emit = (page: Page, e: string, p: unknown) => page.evaluate(({ e, p }) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit(e, p), { e, p })
const phoneClick = (page: Page, at: [number, number]) => emit(page, 'sketch', { kind: 'click', at, mmPerPx: 0.2, screen: [200, 300], shift: false, alt: false })

for (const height of [844, 700, 600]) {
  test(`a phone at 390 by ${height}: the opened sheet reaches every control and stays open while drawing`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Phone sheet')
    await page.setViewportSize({ width: 390, height })
    await openPhoneModel(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
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
    await page.screenshot({ path: test.info().outputPath(`sheet-open-${height}.png`) })
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
    await page.screenshot({ path: test.info().outputPath(`phone-sheet-${height}.png`) })
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

test('a phone with the keyboard up and safe-area insets: every solid field scrolls clear of the footer and the keyboard', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone sheet')
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
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
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
  await page.screenshot({ path: test.info().outputPath('phone-keyboard.png') })
})

test.describe('the slow 3D view notice', () => {
  // a touch screen at desktop width (a tablet): the desktop's toast, with a coarse pointer
  test.use({ hasTouch: true })
  test('one toast: Details opens in place, the close mark takes a finger-sized tap, and closed it stays closed', async ({ page, isMobile }) => {
    test.skip(isMobile, 'A phone keeps the notice in its top bar')
    await sketchOnTop(page)
    const reason = 'Hardware acceleration looks off in this browser. Turn it on in the browser settings and reload.'
    const degrade = () => page.evaluate((r) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('degrade', { message: 'The 3D view will be slow here.', details: r }), reason)
    // the view may have said it as it started (this browser draws without a GPU); said again, it is still one card
    await degrade()
    await degrade()
    const notices = page.getByTestId('toast').filter({ hasText: 'The 3D view will be slow here.' })
    await expect(notices).toHaveCount(1)
    const t = notices.first()
    await t.getByTestId('toast-details').click()
    // Details opens the same card: still one notice, the reason under the line
    await expect(notices).toHaveCount(1)
    await expect(t.locator('.sx-toast-more')).toBeVisible()
    // it keeps clear of the tool panel and its footer
    const [tb, pb] = [(await t.boundingBox())!, (await toolPanel(page).boundingBox())!]
    const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height
    expect(apart(tb, pb)).toBe(true)
    // and of the pills at the cursor while drawing: a press on a pill reaches the pill, not the notice
    await page.locator('body').press('l')
    await sketchAt(page, 'click', [0, 0])
    await sketchAt(page, 'hover', [4, 3])
    const pills = page.getByTestId('sketch-pills')
    await expect(pills).toBeVisible()
    const pl = (await pills.boundingBox())!
    expect(apart((await t.boundingBox())!, pl)).toBe(true)
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-testid="toast"]'), [pl.x + pl.width / 2, pl.y + pl.height / 2])).toBe(false)
    // nor over the panel's footer, where the primary is
    expect(apart((await t.boundingBox())!, (await toolPanel(page).getByTestId('model-tool-apply').boundingBox())!)).toBe(true)
    await page.locator('body').press('Escape')
    // the close mark: small to see, 44 px to a finger, and its reach ends before Details
    const close = t.getByTestId('toast-close')
    await expect(close).toHaveAccessibleName('Dismiss')
    // the mark itself is at least the desktop's 28 px; a coarse pointer gets the larger target around it
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(28)
    const hit = await close.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const b = getComputedStyle(el, '::before')
      const inset = parseFloat(b.top)
      const d = el.parentElement!.querySelector('[data-testid="toast-details"]')!.getBoundingClientRect()
      return { w: r.width - 2 * inset, h: r.height - 2 * inset, mark: r.height, reachLeft: r.left + inset, detailsRight: d.right, coarse: matchMedia('(pointer: coarse)').matches }
    })
    expect(hit.coarse).toBe(true)
    expect(hit.w).toBeGreaterThanOrEqual(44)
    expect(hit.h).toBeGreaterThanOrEqual(44)
    expect(hit.mark).toBeLessThanOrEqual(32)
    expect(hit.reachLeft).toBeGreaterThanOrEqual(hit.detailsRight)
    await page.screenshot({ path: test.info().outputPath('notice-open.png') })
    await close.click()
    await expect(notices).toHaveCount(0)
    // the view says it again (a new view starting): it stays closed
    await degrade()
    await page.waitForTimeout(500)
    await expect(notices).toHaveCount(0)
    // closed is kept for the visit: a reload starts a new one, which may say it once more
    await page.reload()
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    await degrade()
    await degrade()
    await expect(notices).toHaveCount(1)
  })
})

test('on a phone the slow view notice is one bar icon with a finger-sized target', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Phone only')
  await openPhoneModel(page)
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
