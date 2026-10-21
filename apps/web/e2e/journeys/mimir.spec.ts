// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir in the browser build, one tab for designing and slicing: the tab and its dimension sheet (scripted, no model
// behind them), slicing and a new project from the chat, the top bar's button, then mimir cloud against a stubbed proxy
// (the notice and switches, files on a message, a refusal with See usage), and the browser build that only models. One
// page serves them all: a test puts mimir in the state it needs (the connection, the notice, a new conversation) through
// the store, and the proxy stub is one route whose answers each test swaps (lib/session.ts). The phone leg is in
// phone-session.spec.ts.
//
// Dropped because a unit test has them:
//  - mimir-attach: a picture and a PDF going out as an image block and a document block (packages/pilot/test/ui-attach.test.tsx:135,
//    packages/pilot/test/attachments.test.ts:46) and a file that is not a picture or a PDF left out with a note
//    (packages/pilot/test/ui-attach.test.tsx:71). The 1568 px downscale stays: it needs a real canvas.
//  - mimir-part-card: the next steps offered only when the toolset can do them, a step under an older reply acting on that
//    reply's part, and a deleted part saying so (packages/pilot/test/ui-part.test.tsx). The tab builds with the design tools,
//    so its card is the one a built design gets after its step rows (the scripted box below).
//  - mimir-sheet: Cancel building nothing (packages/pilot/test/ui-sheet.test.tsx:81 and :97, packages/app/test/mimir-sheet.test.ts:162)
//    and the thermostat backplate's drawing and status (packages/app/test/mimir-sheet.test.ts:146, packages/pilot/test/ui-sheet.test.tsx:27).
//  - mimir-web-walk: the save switch caption (packages/app/test/mimir-web-walk.test.ts:55).
//  - mimir-tab: the two "screenshot, empty" tests, which asserted nothing.
import { type Locator, type Page } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { freshBox } from '../cad-helpers'
import { goTab, test as cold, viewportReady } from '../fixtures'
import {
  answer,
  askTab,
  closeDialogs,
  debugOn,
  emptyMimirTab,
  lastUserBlocks,
  lastUserText,
  setPilot,
  setState,
  shotsDir,
  shotsOn,
  signIn,
  standIn,
  stubProxy,
} from './lib/session'

// a provider with no key: the tab plays its scripts over the real tools
test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'anthropic' }, scheme: 'dark', themeFollowsSystem: false } })
test.skip(({ isMobile }) => isMobile, 'Desktop. The mimir tab on a phone is in phone-session.spec.ts')

type Sx = { setState(p: unknown): void; getState(): Record<string, any> }
type Vp = { camera: { position: { x: number; y: number; z: number } } }
const state = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())
/** The camera looks straight down when this is near 1. */
const topDown = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __vp: Vp }).__vp.camera.position
    return Math.abs(p.y) / Math.hypot(p.x, p.y, p.z)
  })

/** Debug hooks on, and the pilot in the state a test starts from. */
async function ready(page: Page, mode: Parameters<typeof setPilot>[1], opts: { notice?: boolean } = {}): Promise<void> {
  await debugOn(page)
  await setPilot(page, mode, opts)
}

/* ------------------------------------------------------------------ the mimir tab (scripted) */

type Box = { x: number; y: number; width: number; height: number }
const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

/** Waits for the card to settle clear of the timeline's edge tab and the model size pill. */
async function clearOfBottom(page: Page, card: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const c = await card.boundingBox()
      const others = [await page.getByTestId('edge-tab-bottom').boundingBox(), ...(await page.locator('.vp .hud-bl > *').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect().toJSON() as DOMRect)))]
      return !!c && others.every((o) => !o || apart(c, o))
    })
    .toBe(true)
}

test.describe('the mimir tab', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page, 'scripted')
    await emptyMimirTab(page)
  })

  test('comes first, holds the chat at 420 px beside the view, and opens on the top view of the grid', async ({ page }) => {
    await expect(page.locator('.sx-tab[data-mode]')).toHaveText(['mimir', 'Model', 'Slice'])
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.studio[data-model-mode="mimir"]')).toBeVisible()
    const chat = (await page.getByTestId('mimir-chat').boundingBox())!
    const view = (await page.locator('.studio > .vp').boundingBox())!
    const studio = (await page.locator('.studio').boundingBox())!
    expect(chat.width).toBeCloseTo(420, 0)
    expect(chat.x).toBeCloseTo(studio.x, 0)
    // the view takes the rest of the width
    expect(view.x).toBeCloseTo(chat.x + chat.width, 0)
    expect(view.x + view.width).toBeCloseTo(studio.x + studio.width, 0)
    // composer pinned at the chat's bottom
    const composer = (await page.getByTestId('mimir-composer').boundingBox())!
    expect(chat.y + chat.height - (composer.y + composer.height)).toBeLessThan(24)
    // the top view: the camera looks straight down at the ground grid
    await expect(page.getByTestId('mimir-caption')).toHaveText('Top, XY')
    await expect.poll(() => topDown(page)).toBeGreaterThan(0.95)
    // no Slice or Model panes here; Model's timeline is
    await expect(page.locator('.studio > .pane')).toHaveCount(0)
    await expect(page.locator('.plate-tools')).toHaveCount(0)
  })

  test('shares the design with Model: the same plate either side of a switch', async ({ page }) => {
    // the tab starts empty, so give the design a part first
    await goTab(page, 'prepare')
    await freshBox(page)
    await page.getByTestId('tab-mimir').click()
    const before = (await state(page))['plate'].length
    expect(before).toBe(1)
    await page.getByTestId('tab-model').click()
    await expect(page.getByTestId('model-tree')).toBeVisible()
    await page.getByTestId('tab-mimir').click()
    await expect(page.locator('.studio[data-model-mode="mimir"]')).toBeVisible()
    expect((await state(page))['plate'].length).toBe(before)
  })

  test('the chat edge resizes between 340 px and half the window, and the width is kept', async ({ page }) => {
    const sizes = (await state(page))['paneSizes']
    try {
      const edge = page.getByTestId('mimir-split').getByRole('separator')
      const chat = page.getByTestId('mimir-chat')
      const drag = async (dx: number) => {
        const b = (await edge.boundingBox())!
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
        await page.mouse.down()
        await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 })
        await page.mouse.up()
      }
      await drag(80)
      expect((await chat.boundingBox())!.width).toBeCloseTo(500, -1)
      await drag(2000)
      expect((await chat.boundingBox())!.width).toBeCloseTo(720, 0)
      await drag(-2000)
      expect((await chat.boundingBox())!.width).toBeCloseTo(340, 0)
      await drag(100)
      const kept = Math.round((await chat.boundingBox())!.width)
      await page.reload()
      await viewportReady(page)
      await page.getByTestId('tab-mimir').click()
      await expect.poll(async () => Math.round((await chat.boundingBox())!.width)).toBe(kept)
    } finally {
      // the width is remembered, so put it back for the tests after this one
      await setState(page, { paneSizes: sizes })
    }
  })

  test('an image dropped or attached rides on the message; the attach button and the composer stay put', async ({ page }, info) => {
    const attach = page.getByTestId('mimir-attach')
    const before = (await attach.boundingBox())!
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    await page.getByTestId('mimir-composer').locator('input[type="file"]').setInputFiles({ name: 'thermostat.png', mimeType: 'image/png', buffer: png })
    await expect(page.getByTestId('mimir-attachment')).toHaveText('thermostat.png')
    const after = (await attach.boundingBox())!
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5)
    // a file dropped on the chat joins it
    const drop = await page.evaluateHandle((b64) => {
      const dt = new DataTransfer()
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], 'wall.png', { type: 'image/png' }))
      return dt
    }, png.toString('base64'))
    await page.getByTestId('mimir-transcript').dispatchEvent('dragover', { dataTransfer: drop })
    await page.getByTestId('mimir-transcript').dispatchEvent('drop', { dataTransfer: drop })
    await expect(page.getByTestId('mimir-attachment')).toHaveCount(2)
    await page.getByRole('button', { name: 'Remove thermostat.png' }).click()
    await expect(page.getByTestId('mimir-attachment')).toHaveText('wall.png')
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-attach-dark.png` })
    // take the last one off, so the next conversation starts bare
    await page.getByRole('button', { name: 'Remove wall.png' }).click()
    await expect(page.getByTestId('mimir-attachment')).toHaveCount(0)
  })

  test('the battle ravens stand still and faint behind the whole chat, centered and out of the way', async ({ page }) => {
    const ravens = page.getByTestId('mimir-ravens')
    await expect(ravens).toBeVisible()
    // one color at about 4%, so it reads as texture
    const alpha = await ravens.evaluate((e) => {
      const c = document.createElement('canvas').getContext('2d')!
      c.fillStyle = getComputedStyle(e).color
      c.fillRect(0, 0, 1, 1)
      return c.getImageData(0, 0, 1, 1).data[3]! / 255
    })
    expect(alpha).toBeGreaterThan(0.02)
    expect(alpha).toBeLessThan(0.07)
    await expect(ravens).toHaveAttribute('aria-hidden', 'true')
    expect(await ravens.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none')
    // still: nothing in it animates
    expect(await ravens.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0)
    const chat = (await page.getByTestId('mimir-chat').boundingBox())!
    const r = (await ravens.boundingBox())!
    expect(r.width / chat.width).toBeGreaterThan(0.55)
    expect(r.width / chat.width).toBeLessThan(0.75)
    expect(Math.abs(r.x + r.width / 2 - (chat.x + chat.width / 2))).toBeLessThan(1)
    // the composer is still the top thing at its own spot
    const c = (await page.getByTestId('mimir-composer').boundingBox())!
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid]')?.getAttribute('data-testid'), [c.x + c.width / 2, c.y + c.height / 2])
    expect(hit).toBe('mimir-composer')
    // a reply comes in: the ravens stay where they were, as faint and as still, behind the whole conversation
    await askTab(page, 'Hey mimir, I need a wall mount for this thermostat. Can we print it?')
    const choice = page.getByTestId('mimir-choice')
    await expect(choice).toBeVisible({ timeout: 30_000 })
    await expect(ravens).toBeVisible()
    const after = (await ravens.boundingBox())!
    expect(Math.max(Math.abs(after.x - r.x), Math.abs(after.y - r.y), Math.abs(after.width - r.width), Math.abs(after.height - r.height))).toBeLessThanOrEqual(0.5)
    expect(await ravens.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0)
    await expect(ravens).toHaveAttribute('aria-hidden', 'true')
    // scripted replies name no model, and no reply ever shows a model id
    await expect(page.getByTestId('mimir-model-switch')).toHaveCount(0)
    await expect(page.getByTestId('mimir-transcript')).not.toContainText(/gpt-|claude-|for this one\./)
    await choice.getByRole('button', { name: 'A different model' }).click()
  })

  test("the top bar's button opens the tab and keeps its place there; Mod+/ opens it from anywhere", async ({ page }) => {
    await goTab(page, 'prepare')
    const btn = page.locator('.mimir-btn')
    await expect(btn).toBeVisible()
    const box = (await btn.boundingBox())!
    await btn.click()
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('mimir-chat')).toBeVisible()
    // the tab names mimir, so the button hides but keeps its place, and nothing in the bar moves
    await expect(btn).toBeHidden()
    expect((await btn.boundingBox()) ?? box).toEqual(box)
    await page.getByTestId('tab-model').click()
    await expect(btn).toBeVisible()
    await expect(page.getByTestId('mimir-chat')).toBeHidden()
    await page.keyboard.press('ControlOrMeta+/')
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    // and off: no tab, no button
    await setPilot(page, 'off')
    await expect(page.getByTestId('tab-mimir')).toHaveCount(0)
    await expect(btn).toHaveCount(0)
    await setPilot(page, 'scripted')
    await expect(page.getByTestId('tab-mimir')).toBeVisible()
  })

  test('slices the plate and starts a new project from the chat, staying on the tab; the discard question stays with the person', async ({ page }, info) => {
    await goTab(page, 'prepare')
    await freshBox(page)
    await page.getByTestId('tab-mimir').click()
    const chat = page.getByTestId('mimir-chat')
    await askTab(page, 'Slice the plate')
    await expect(chat).toContainText('Sliced. The card shows the print time', { timeout: 60_000 })
    // the slice happened where mimir is: the tab is still open, and the slice waits in Slice
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    expect((await state(page))['slice']?.status).toBe('done')
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-sliced.png` })
    // a new project asks the person first; keeping the open one changes nothing
    await askTab(page, 'Start a new project')
    const unsaved = page.getByRole('dialog', { name: 'Save changes first?' })
    await expect(unsaved).toBeVisible({ timeout: 30_000 })
    await unsaved.getByTestId('unsaved-cancel').click()
    await expect(chat).toContainText('You kept the open project, so nothing changed.')
    expect((await state(page))['plate'].length).toBe(1)
    await askTab(page, 'Start a new project')
    await expect(unsaved).toBeVisible({ timeout: 30_000 })
    await unsaved.getByTestId('unsaved-discard').click()
    await expect(chat).toContainText('The new project is open and empty.')
    expect((await state(page))['plate'].length).toBe(0)
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
  })

  // Past the attention window and the close delay (4.8 s), which is the point of the test, so it runs at night.
  test('scripted mimir asks, shows what it found as a card in the view, and the card closes but stays in the record', { tag: '@nightly' }, async ({ page }, info) => {
    const composer = page.getByTestId('mimir-composer')
    await composer.getByRole('textbox').fill('Hey mimir, I need a wall mount for this thermostat. Can we print it?')
    await composer.getByRole('button', { name: 'Send' }).click()
    const choice = page.getByTestId('mimir-choice')
    await expect(choice).toBeVisible()
    // picking moves nothing: both chips keep their boxes
    const chips = choice.getByRole('button')
    const before = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    await choice.getByRole('button', { name: 'Yes, that one' }).click()
    // the ravens stay behind the whole conversation, and the bubble has no prompt glyph
    await expect(page.getByTestId('mimir-ravens')).toBeVisible()
    await expect(page.locator('.mimir-chat .bubble .pg')).toBeHidden()
    await expect(choice).toHaveAttribute('data-picked', 'same')
    const after = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    after.forEach((a, i) => {
      const b = before[i]!
      expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))).toBeLessThanOrEqual(0.5)
    })
    // The sizes it will build with wait on a sheet, guesses marked, until the person confirms them; the drawing covers
    // the view meanwhile, and the lookup card comes back once the sheet is answered.
    const sheet = page.getByTestId('mimir-sheet-record')
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('[data-dim="thickness"][data-guess]')).toHaveCount(1)
    await page.getByTestId('mimir-sheet-confirm').click()
    await expect(sheet).toContainText('Confirmed as shown')
    const card = page.getByTestId('mimir-lookup-card')
    // The pointer in the band along the view's bottom opens the timeline for a moment. A click on its tab then keeps it
    // open (the person did not open it, so the click means keep it), and the next click closes it.
    const timeline = page.locator('.bpanel-body')
    const tab = page.getByTestId('edge-tab-bottom')
    const press = async () => {
      // A toast moves above the panel a frame after the panel opens, and until then it can lie over the tab (the
      // software-drawn view's "will be slow" notice does on a busy machine). Click once the tab is what lies under the
      // pointer, as a person sees it.
      await expect.poll(() => tab.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
      const t = (await tab.boundingBox())!
      await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2)
      await page.mouse.move(700, 300)
    }
    // (in the band beside the tab: resting on the tab itself opens nothing)
    const view = (await page.locator('.studio > .vp').boundingBox())!
    await page.mouse.move(view.x + view.width / 2 - 160, view.y + view.height - 12)
    await expect(timeline).toBeVisible()
    await press()
    // past the attention window and the close delay
    await page.waitForTimeout(4800)
    await expect(timeline).toBeVisible()
    await expect(card).toBeVisible()
    await expect.poll(async () => (await card.boundingBox())!.y + (await card.boundingBox())!.height <= (await timeline.boundingBox())!.y).toBe(true)
    await clearOfBottom(page, card)
    await press()
    await expect(timeline).toBeHidden()
    await expect(card).toContainText('150.4 x 110.4 mm')
    // both rows it shows fit inside the card
    const rows = await card.locator('dd').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom))
    const cardBottom = await card.evaluate((e) => e.getBoundingClientRect().bottom)
    expect(rows).toHaveLength(2)
    for (const b of rows) expect(b).toBeLessThanOrEqual(cardBottom)
    await expect(card.getByRole('link')).toBeInViewport()
    await expect(card.getByRole('link')).toHaveAttribute('href', /^https:\/\/example\.com\//)
    // the card sits at the view's bottom, left aligned with the caption, at most 96 px tall
    const c = (await card.boundingBox())!
    const cap = (await page.getByTestId('mimir-caption').boundingBox())!
    const vp = (await page.locator('.studio > .vp').boundingBox())!
    expect(Math.abs(c.x - cap.x)).toBeLessThanOrEqual(0.5)
    expect(c.height).toBeLessThanOrEqual(96.5)
    // (it slides back down once the timeline shuts, and stays above the strip that opens the timeline on hover, and
    // above the model size pill)
    await expect.poll(async () => vp.y + vp.height - ((await card.boundingBox())!.y + (await card.boundingBox())!.height)).toBeLessThan(72)
    await page.waitForTimeout(250)
    const settled = (await card.boundingBox())!
    expect(vp.y + vp.height - (settled.y + settled.height)).toBeGreaterThanOrEqual(56)
    await clearOfBottom(page, card)
    // pointing at the card's lower edge opens nothing and moves nothing
    await page.mouse.move(settled.x + 40, settled.y + settled.height - 2, { steps: 4 })
    await page.waitForTimeout(700)
    await expect(timeline).toBeHidden()
    expect(await card.boundingBox()).toEqual(settled)
    await page.mouse.move(700, 300)
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-lookup-dark.png` })
    // the open timeline pushes the card up instead of sitting under it: the pointer comes down onto its tab, rests and
    // clicks, as a person does. Resting on the tab past the band's delay opens nothing and moves nothing, so the click
    // lands on the tab. (One move from above the band, so it never rests in the band beside the tab.)
    await expect(timeline).toBeHidden()
    const t = (await tab.boundingBox())!
    await page.mouse.move(t.x + t.width / 2, t.y - 120)
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
    await page.waitForTimeout(300)
    await expect(timeline).toBeHidden()
    expect(await tab.boundingBox()).toEqual(t)
    await page.mouse.down()
    await page.mouse.up()
    await expect(tab).toHaveAttribute('aria-expanded', 'true')
    await expect(timeline).toBeVisible()
    await expect.poll(async () => (await card.boundingBox())!.y + (await card.boundingBox())!.height <= (await timeline.boundingBox())!.y).toBe(true)
    await clearOfBottom(page, card)
    // opened from its tab, it shuts once the pointer leaves; then by keyboard: Enter on the focused tab opens it with
    // the card still clear, and again shuts it
    await page.mouse.move(700, 300)
    await expect(timeline).toBeHidden()
    await tab.focus()
    await page.keyboard.press('Enter')
    await expect(timeline).toBeVisible()
    await expect.poll(async () => (await card.boundingBox())!.y + (await card.boundingBox())!.height <= (await timeline.boundingBox())!.y).toBe(true)
    await clearOfBottom(page, card)
    await page.keyboard.press('Enter')
    await expect(timeline).toBeHidden()
    await page.getByTestId('mimir-lookup-close').click()
    await expect(card).toHaveCount(0)
    await expect(page.getByTestId('mimir-transcript').locator('[data-lookup-id]')).toHaveCount(1)
    // a second lookup: Escape on the focused card closes it
    await composer.getByRole('textbox').fill('another backplate for the thermostat')
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByTestId('mimir-choice')).toHaveCount(2)
    await page.getByTestId('mimir-choice').last().getByRole('button', { name: 'Yes, that one' }).click()
    await page.getByTestId('mimir-sheet-confirm').click()
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    await card.focus()
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    // Each confirmed sheet builds a backplate. Wait for both builds: the page is shared, and a build still running
    // lands its backplate on the next test's emptied plate.
    const built = async () => ((await page.getByTestId('mimir-transcript').textContent()) ?? '').split('The backplate is on the plate:').length - 1
    await expect.poll(built, { timeout: 30_000 }).toBe(2)
  })

  test('scripted mimir builds on the plate: each step lands in the history Model shows, and undo takes it back', async ({ page }, info) => {
    const composer = page.getByTestId('mimir-composer')
    await composer.getByRole('textbox').fill('Can you make a box with a lid?')
    await composer.getByRole('button', { name: 'Send' }).click()
    // Nothing is built until the person confirms the sizes.
    await page.getByTestId('mimir-sheet-confirm').click()
    const plate = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { name: string; parts: { name: string }[]; history?: { steps: unknown[] } }[] } } }).__sx.getState().plate.map((e) => ({ name: e.name, parts: e.parts.map((p) => p.name), steps: e.history?.steps.length ?? 0 })))
    await expect.poll(plate, { timeout: 30_000 }).toEqual([{ name: 'Box with lid', parts: ['Box', 'Lid'], steps: 4 }])
    // no step failed on the way
    await expect(page.getByTestId('mimir-transcript')).toContainText('Done: the box and its lid')
    await expect(page.getByTestId('mimir-transcript').locator('.trow .st .bad')).toHaveCount(0)
    // the view shows the parts after the extrudes: off the top view
    await expect.poll(() => topDown(page)).toBeGreaterThan(0.2)
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-box-dark.png` })
    // Model shows the same object with its steps, and undo takes the last one back
    await page.getByTestId('tab-model').click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(plate).toEqual([{ name: 'Box with lid', parts: ['Box', 'Lid'], steps: 3 }])
  })

  test("a scripted box's card selects its part in the tab, and Edit opens its newest step in Model", async ({ page }, info) => {
    await askTab(page, 'Can you make a box with a lid?')
    await page.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-transcript')).toContainText('Done: the box and its lid', { timeout: 30_000 })
    // one card for the design the turn built, after its step rows, which stay
    const card = page.getByTestId('mimir-part').last()
    await expect(page.getByTestId('mimir-part')).toHaveCount(1)
    // the reply has finished, so its next steps show under the card
    await expect(page.getByTestId('mimir-transcript')).toContainText('Both parts are in Model with their steps.')
    await expect(page.getByTestId('mimir-transcript').locator('.trow')).not.toHaveCount(0)
    await expect(card).toContainText('Box with lid')
    const id = await card.getAttribute('data-part')
    expect((await state(page))['plate'].map((e: { id: string }) => e.id)).toEqual([id])
    // the build leaves the part selected; clear that, so Select is what selects it
    await setState(page, { selection: null, selectedIds: [] })
    await card.scrollIntoViewIfNeeded()
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/desktop-part-card.png` })
    // Select stays in the tab and selects the part on the plate
    await card.getByRole('button', { name: /^Select the / }).click()
    await expect.poll(async () => (await state(page))['selectedIds']).toEqual([id])
    expect((await state(page))['modelMode']).toBe('mimir')
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/desktop-part-select.png` })
    // Edit goes to Model with the part's newest step open, and the timeline shows it
    await expect(card.getByRole('button', { name: /^Edit the / })).toHaveAttribute('data-tip-title', 'Edit in Model')
    await card.getByRole('button', { name: /^Edit the / }).click()
    await expect.poll(async () => (await state(page))['modelMode']).toBe('design')
    await expect.poll(async () => (await state(page))['historyEdit']?.objectId ?? null).toBe(id)
    await expect(page.getByTestId('tab-model')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator(`[data-testid="model-tree-step"][data-object-id="${id}"][data-editing]`)).toHaveCount(1)
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/desktop-part-edit.png` })
  })

  test('scripted mimir checks a built part against its plan and names the item that is off', async ({ page }) => {
    const composer = page.getByTestId('mimir-composer')
    const say = async (text: string) => {
      await composer.getByRole('textbox').fill(text)
      await composer.getByRole('button', { name: 'Send' }).click()
    }
    await say('a wall mount for my thermostat')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'Yes, that one' }).click()
    await page.getByTestId('mimir-sheet-confirm').click()
    const transcript = page.getByTestId('mimir-transcript')
    await expect(transcript).toContainText('The backplate is on the plate:', { timeout: 30_000 })
    // A scripted plan that wants a 32 mm center hole, where the backplate was built with the sheet's 30 mm: the build
    // is wrong for this plan in that one item.
    const plan = {
      planId: 'e2e-backplate',
      part: 'Thermostat backplate',
      units: 'mm',
      features: [{ name: 'plate with holes', kind: 'extrude', sizes: { width: 150.4, height: 110.4, thickness: 3 } }],
      overall: { x: 150.4, y: 110.4, z: 3 },
      holes: [
        { name: 'center hole', diameter: 32 },
        { name: 'top screw hole', diameter: 4.5 },
        { name: 'bottom screw hole', diameter: 4.5 },
      ],
      assumptions: [],
      questions: [],
    }
    // window.__mimirPlans is there only with localStorage 'slicerx.debug' set, which the journey's page setup does. The
    // plan goes in as one the person made on the card: the scripted check reads card plans only, never a client's
    await page.evaluate((p) => (window as unknown as { __mimirPlans: { put(plan: unknown, design: undefined, origin: 'card'): void } }).__mimirPlans.put(p, undefined, 'card'), plan)
    await say('Check it against the plan')
    await expect(transcript).toContainText('It does not match the plan yet.', { timeout: 30_000 })
    // the reply names the design it checked (the one named as the plan's part)
    await expect(transcript).toContainText('I checked the design Thermostat backplate.')
    await expect(transcript).toContainText(/Center hole: wanted 32 mm diameter, got (29\.9\d|30(\.0\d)?) mm diameter\./)
    // only that item: the screw holes, size, features, closed body and walls pass, and the reply never says done
    await expect(transcript).not.toContainText(/screw hole:|Overall size:|Feature count:|Watertight:|Minimum wall:/)
    await expect(transcript).not.toContainText('It matches the plan')
  })

  test('a finished part brings up the spools under the run, and a click there picks the spool it prints with', async ({ page }, info) => {
    const printer = (await state(page))['printerId']
    try {
      await setState(page, { printerId: 'bay-1' })
      const composer = page.getByTestId('mimir-composer')
      await composer.getByRole('textbox').fill('Can you make a box with a lid?')
      await composer.getByRole('button', { name: 'Send' }).click()
      // no pick while the run waits on the sizes
      await expect(page.getByTestId('mimir-sheet-confirm')).toBeVisible()
      await expect(page.getByTestId('mimir-filament')).toHaveCount(0)
      await page.getByTestId('mimir-sheet-confirm').click()
      await expect(page.getByTestId('mimir-transcript')).toContainText('Done: the box and its lid', { timeout: 30_000 })
      const pick = page.getByTestId('mimir-filament')
      await expect(pick).toBeVisible()
      const spools = pick.getByTestId('slice-filament-slot')
      expect(await spools.count()).toBeGreaterThan(1)
      // the part is selected after the build, so a click moves it; nothing in the card moves
      const slot = Number(await pick.locator('[data-testid="slice-filament-slot"][data-parts="0"]:not([data-empty])').first().getAttribute('data-slot'))
      const free = pick.locator(`[data-testid="slice-filament-slot"][data-slot="${slot}"]`)
      // the click scrolls its target into view; measure after that scroll, before changing the spool
      await free.scrollIntoViewIfNeeded()
      const at = await pick.boundingBox()
      await free.click()
      await expect(free).not.toHaveAttribute('data-parts', '0')
      expect(await pick.boundingBox()).toEqual(at)
      const slots = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { slotOverrides?: Record<string, number>; handle: { parts: { name: string; slot: number }[] } }[] } } }).__sx.getState().plate.flatMap((e) => e.handle.parts.map((p) => e.slotOverrides?.[p.name] ?? p.slot)))
      expect(slots).toContain(slot)
      if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-filament-dark.png` })
    } finally {
      await setState(page, { printerId: printer })
    }
  })
})

/* ------------------------------------------------------------------ the dimension sheet (scripted) */

const boxes = (page: Page, ids: string[]) => Promise.all(ids.map(async (id) => (await page.getByTestId(id).boundingBox())!))

function still(before: Box[], after: Box[]): void {
  after.forEach((a, i) => {
    const b = before[i]!
    expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))).toBeLessThanOrEqual(0.5)
  })
}

test.describe('the dimension sheet', () => {
  test.beforeEach(async ({ page }) => {
    await ready(page, 'scripted')
    await emptyMimirTab(page)
  })

  // While a sheet waits, the view is a drawing in four views with numbered callouts, and the sheet's record in the chat is
  // where the sizes are typed. A callout focuses its row and a focused row lights its measurement. A guess stays assumed
  // until a valid value is committed or it is kept with Enter; an empty, partial or out of range entry keeps nothing. A
  // Sizes pill brings the record back once it scrolls away. Nothing builds until Confirm sizes and build. After the build,
  // Edit sizes brings the panel back and a tied row edits its step.
  test('draws the part in four views with callouts, edits on the record, builds on Confirm, then drives the step', async ({ page }, info) => {
    const plate = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState()['plate'].map((e: any) => ({ name: e.name, width: e.history?.steps[0]?.params.spec?.distanceMm ?? null })))
    const composer = page.getByTestId('mimir-composer')
    await composer.getByRole('textbox').fill('Make me a stand for my phone')
    await composer.getByRole('button', { name: 'Send' }).click()
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'An iPhone 15' }).click()
    const drawing = page.getByTestId('mimir-sheet-drawing')
    const rec = page.getByTestId('mimir-sheet-record')
    await expect(drawing).toBeVisible()
    // while it waits the drawing has the whole view; the record in the chat is the editor
    await expect(page.getByTestId('mimir-sheet-panel')).toHaveCount(0)
    await expect(page.locator('.studio > .vp')).toHaveAttribute('data-mimir-sheet', 'drawing')
    await expect(page.getByTestId('mimir-caption')).toHaveText('Drawing, four views')
    await expect(page.getByTestId('mimir-drawing-status')).toContainText('Not built yet')
    await expect(rec.locator('.sheet-rec-n')).toHaveText(['1', '2', '3', '4', '5', '6', '7'])
    await expect(rec.getByTestId('mimir-sheet-confirm')).toHaveText('Confirm sizes and build')
    await expect(drawing.locator('.mimir-drawing-cell')).toHaveCount(4)
    // six of the seven sizes sit on the stand (the phone's width is the phone's): each in one flat view and the iso
    await expect(page.getByTestId('mimir-sheet-callout')).toHaveCount(12)
    // every callout stays in its cell, clear of the others there
    const cells = await drawing.locator('.mimir-drawing-cell').evaluateAll((els) =>
      els.map((cell) => {
        const r = cell.getBoundingClientRect()
        return { r: r.toJSON() as DOMRect, dots: Array.from(cell.querySelectorAll('.mimir-callout circle'), (c) => (c as SVGCircleElement).getBoundingClientRect().toJSON() as DOMRect) }
      }),
    )
    for (const { r, dots } of cells) {
      for (const d of dots) {
        expect(d.left).toBeGreaterThanOrEqual(r.left - 0.5)
        expect(d.right).toBeLessThanOrEqual(r.right + 0.5)
        expect(d.top).toBeGreaterThanOrEqual(r.top - 0.5)
        expect(d.bottom).toBeLessThanOrEqual(r.bottom + 0.5)
      }
      for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) expect(Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y)).toBeGreaterThanOrEqual(19)
    }
    const status = rec.getByTestId('mimir-sheet-status')
    await expect(rec.locator('.sheet-rec-row[data-guess]')).toHaveCount(5)
    await expect(status).toHaveText('5 assumed values: room for a case 1.5 mm, lean angle 70 ° and 3 more')
    await expect(status).toHaveAttribute('data-assumed', '')
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-sheet-dark.png` })

    // a callout focuses its row on the record, and the focused row lights its measurement in the drawing
    const row = rec.locator('.sheet-rec-row[data-dim="case_allowance"]')
    const field = row.locator('input')
    await page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"]').first().click()
    await expect(field).toBeFocused()
    // from here on the record's buttons hold still while its rows and status change
    const fixed = ['mimir-sheet-confirm', 'mimir-sheet-cancel']
    const before = await boxes(page, fixed)
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-on]')).toHaveCount(2)
    await expect(page.locator('.mimir-dim[data-key="case_allowance"][data-on]')).toHaveCount(2)
    // the case room is measured over the part, so its callout sits on a leader
    await expect(page.locator('.mimir-dim[data-key="case_allowance"] > g:not(.mimir-dim-halo) .mimir-dim-leader').first()).toBeAttached()

    // an empty, partial, non-numeric or out of range entry keeps nothing: the guess stays assumed
    for (const typed of ['', '-', '.', '2x', '40']) {
      await field.fill(typed)
      await field.press('Enter')
      await expect(row).toHaveAttribute('data-guess', '')
      await expect(status).toHaveText(/^5 assumed values/)
    }
    await field.fill('-')
    await field.press('Tab')
    await expect(row).toHaveAttribute('data-guess', '')
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-source="guess"]')).toHaveCount(2)
    // a valid value committed clears it, and the row becomes yours
    await field.fill('2')
    await field.press('Enter')
    await expect(row).not.toHaveAttribute('data-guess')
    await expect(row.locator('.sheet-rec-tag')).toHaveText('yours')
    await expect(status).toHaveText(/^4 assumed values/)
    await expect(page.locator('[data-testid="mimir-sheet-callout"][data-key="case_allowance"][data-source="guess"]')).toHaveCount(0)
    // Enter on a guess left as it is keeps it
    const lip = rec.locator('.sheet-rec-row[data-dim="lip_height"]')
    await lip.locator('input').click()
    await lip.locator('input').press('Enter')
    await expect(lip).not.toHaveAttribute('data-guess')
    await expect(lip.locator('.sheet-rec-tag')).toHaveText('kept')
    await expect(status).toHaveText(/^3 assumed values/)
    still(before, await boxes(page, fixed))

    // scrolled away, the Sizes pill brings the record back and puts the cursor in the first assumed size
    const transcript = page.getByTestId('mimir-transcript')
    await transcript.evaluate((el) => (el.scrollTop = 0))
    const pill = page.getByTestId('mimir-sizes-pill')
    await expect(pill).toBeVisible()
    await pill.click()
    await expect(pill).toHaveCount(0)
    await expect(rec.locator('.sheet-rec-row[data-dim="lean"] input')).toBeFocused()
    await expect(rec).toBeInViewport({ ratio: 0.6 })

    // Confirm sends the record's values; the drawing goes and the part is built from them
    await rec.getByTestId('mimir-sheet-confirm').click()
    await expect(drawing).toHaveCount(0)
    await expect(page.locator('.studio > .vp')).not.toHaveAttribute('data-mimir-sheet')
    await expect(rec).toContainText('Confirmed with 1 change')
    await expect(page.getByTestId('mimir-sizes-pill')).toHaveCount(0)
    await expect(page.getByTestId('mimir-transcript')).toContainText('The stand is on the plate', { timeout: 30_000 })
    await expect.poll(plate).toEqual([{ name: 'Phone stand', width: 35 }])

    // Edit sizes brings the panel back; a tied row edits its step, a sketch row says it needs a rebuild
    const panel = page.getByTestId('mimir-sheet-panel')
    await rec.getByTestId('mimir-sheet-open').click()
    await expect(panel).toHaveAttribute('data-mode', 'drive')
    await expect(drawing).toHaveCount(0)
    await expect(page.locator('[data-testid="mimir-sheet-row"][data-key="lean"] input')).toBeDisabled()
    const width = page.locator('[data-testid="mimir-sheet-row"][data-key="stand_width"] input')
    await width.fill('90')
    await width.press('Enter')
    await expect.poll(plate).toEqual([{ name: 'Phone stand', width: 45 }])
    await expect(page.getByTestId('mimir-sheet-hint')).toContainText('Edited step 1')
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-sheet-drive-dark.png` })

    // a toast keeps to the left of the panel, off its rows and Done
    const text = 'Hardware acceleration looks off in this browser, so the 3D view will be slow. Turn it on in the browser settings and reload.'
    await page.evaluate((t) => (window as unknown as { __sx: Sx }).__sx.setState({ toast: { id: Date.now(), text: t, tone: 'info' } }), text)
    const toast = page.getByTestId('toast').filter({ hasText: 'Turn it on in the browser settings' }).last()
    await expect(toast).toBeVisible()
    await expect.poll(async () => (await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => el.getBoundingClientRect().right)))).toBeLessThanOrEqual((await panel.boundingBox())!.x)
    await page.getByTestId('mimir-sheet-close').click()
    await expect(panel).toHaveCount(0)
  })
})

/* ------------------------------------------------------------------ mimir cloud before the first chat */

/** Presses a control and checks that it and the others named stay where they were. */
async function pressStill(target: Locator, others: Locator[]): Promise<void> {
  const all = [target, ...others]
  // in view first, so the click's own scroll is not taken for a shift
  await target.scrollIntoViewIfNeeded()
  const before = await Promise.all(all.map((l) => l.boundingBox()))
  await target.click()
  const after = await Promise.all(all.map((l) => l.boundingBox()))
  expect(after).toEqual(before)
}

// mimir cloud before the first chat: the one-time notice in the mimir tab (what is sent, what is kept, the share switch)
// and Settings > mimir's share switch and delete control. The web build has no cloud shell, so a test stands one in through
// the debug hook. Controls stay put when pressed.
test.describe('mimir cloud', () => {
  test('the mimir tab shows the notice once before the first chat', async ({ page }, info) => {
    await ready(page, 'unset', { notice: false })
    await standIn(page)
    await emptyMimirTab(page)
    const notice = page.getByTestId('mimir-cloud-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText(/mimir in \S+ runs on a cloud model provider\. Your messages, photos and the parts mimir works on go to the provider/)
    await expect(notice).toContainText(/During alpha we save free mimir chats for 30 days to improve it/)
    await expect(page.locator('.mimir-empty')).toHaveCount(0)
    if (shotsOn()) await page.getByTestId('mimir-chat').screenshot({ path: `${shotsDir(info)}/mimir-cloud-notice.png` })

    const share = page.getByTestId('mimir-notice-share')
    const start = page.getByTestId('mimir-notice-ok')
    // Save my chats starts on, since free chats are saved during alpha
    await expect(share).toHaveAttribute('aria-checked', 'true')
    await pressStill(share, [start, page.getByTestId('mimir-composer')])
    await expect(share).toHaveAttribute('aria-checked', 'false')
    expect((await state(page))['mimirShare']).toBe(false)

    await start.click()
    await expect(notice).toHaveCount(0)
    // the stand-in shell has no proxy behind it, so no model answers and the chat offers the setup
    await expect(page.locator('.mimir-empty').or(page.getByTestId('mimir-connect'))).toBeVisible()
    expect((await state(page))['mimirNotice']).toBe(2)

    // read once: it stays gone after a reload
    await page.reload()
    await viewportReady(page)
    await standIn(page)
    await page.getByTestId('tab-mimir').click()
    await expect(page.getByTestId('mimir-chat')).toBeVisible()
    await expect(page.getByTestId('mimir-cloud-notice')).toHaveCount(0)
    expect((await state(page))['mimirShare']).toBe(false)
  })

  test('Settings, mimir: Save my chats is on by default, and delete asks first and says what it deleted', async ({ page }, info) => {
    await ready(page, 'unset', { notice: false })
    await standIn(page)
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ settingsOpen: true, settingsSection: 'pilot' }))
    const share = page.getByTestId('mimir-share')
    const forget = page.getByTestId('danger-mimir-forget')
    await expect(share).toHaveAttribute('aria-checked', 'true')
    await pressStill(share, [forget])
    await expect(share).toHaveAttribute('aria-checked', 'false')
    expect((await state(page))['mimirShare']).toBe(false)
    await pressStill(share, [forget])
    expect((await state(page))['mimirShare']).toBe(true)
    if (shotsOn()) await page.locator('.pc-cloud-share').first().screenshot({ path: `${shotsDir(info)}/mimir-save-switch.png` })
    // delete asks first, cancel keeps everything, and the row never changes height
    const row = page.locator('.pc-forget').first()
    const h = (await row.boundingBox())!.height
    const forgets = () => page.evaluate(() => (window as unknown as { __forgets?: number }).__forgets ?? 0)
    await forget.click()
    await expect(page.getByText("Delete all saved chats? This can't be undone.")).toBeVisible()
    expect((await row.boundingBox())!.height).toBe(h)
    await page.getByRole('alertdialog', { name: 'Confirm delete' }).getByRole('button', { name: 'Cancel' }).click()
    await expect(forget).toBeVisible()
    expect(await forgets()).toBe(0)
    await forget.click()
    await page.getByTestId('danger-mimir-forget-confirm').click()
    await expect(page.getByRole('status').filter({ hasText: 'Deleted 3 saved chats.' })).toBeVisible()
    expect(await forgets()).toBe(1)
    expect((await row.boundingBox())!.height).toBe(h)
    await closeDialogs(page)
  })
})

/* ------------------------------------------------------------------ what mimir remembers */

// A reply in the mimir tab that asks to keep a note shows the chip, not the approval card. Remember saves it (the chip keeps its size),
// and Settings > Memory lists it under its kind and clears it after asking. Not now, edit, delete and export are unit
// tests (packages/app/test/memory-section.test.ts).
test.describe('what mimir remembers', () => {
  const NOTE = 'Has a Bambu Lab A1 with the 0.4 mm nozzle'

  test('the chip saves a note on Remember, and Settings, Memory lists it and clears it after asking', async ({ page }, info) => {
    await ready(page, 'cloud')
    await stubProxy(page, (body) => (lastUserText(body).includes('tool_result') ? answer('Noted.') : [{ type: 'tool_use', id: 'tu_mem', name: 'memory.remember', input: { kind: 'printer', text: NOTE } }]))
    await signIn(page)
    await emptyMimirTab(page)
    await askTab(page, 'Remember that I have a Bambu Lab A1')
    const chat = page.getByTestId('mimir-chat')
    const chip = chat.getByTestId('mimir-remember')
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toContainText(NOTE)
    await expect(chat).not.toContainText('needs your approval')
    if (shotsOn()) await chip.screenshot({ path: `${shotsDir(info)}/mimir-remember-chip.png` })
    const before = (await chip.boundingBox())!
    await chip.getByTestId('mimir-remember-yes').click()
    await expect(chip).toHaveAttribute('data-done', 'saved')
    await expect(chat).toContainText('Noted.', { timeout: 30_000 })
    expect((await chip.boundingBox())!.height).toBe(before.height)

    await chip.getByRole('button', { name: 'See all notes' }).click()
    const memory = page.locator('.mem-sec')
    await expect(memory.getByRole('list', { name: 'Printers' })).toContainText(NOTE)
    await page.getByTestId('danger-memory-clear').click()
    const ask = page.getByRole('dialog', { name: 'Clear all notes' })
    await expect(ask).toContainText("Clear all 1 note? This can't be undone.")
    await ask.getByTestId('danger-memory-clear-confirm').click()
    await expect(memory).toContainText('No notes yet.')
    await closeDialogs(page)
  })
})

// Signed in, where the edition offers it, Settings > Memory has Sync with my account under Save notes without asking;
// it starts off and turns on in place. The build's stand-in account answers with no network.
test.describe('memory sync with the account', () => {
  test('Settings, Memory shows Sync with my account to a signed-in person, and it turns on in place', async ({ page }, info) => {
    await ready(page, 'cloud')
    await page.evaluate(() => sessionStorage.setItem('sx-e2e-memory-sync', 'stand-in-session'))
    await page.reload()
    await viewportReady(page)
    await page.evaluate(() => (window as unknown as { __sx: { setState(s: Record<string, unknown>): void } }).__sx.setState({ settingsOpen: true, settingsSection: 'memory', mimirMemorySync: false }))
    const memory = page.locator('.mem-sec')
    const sync = memory.getByTestId('memory-sync')
    await expect(sync).toBeVisible({ timeout: 30_000 })
    await expect(memory).toContainText('Sync with my account')
    await expect(sync).toHaveAttribute('aria-checked', 'false')
    const before = (await sync.boundingBox())!
    await sync.click()
    await expect(sync).toHaveAttribute('aria-checked', 'true')
    await expect(memory).toContainText('They stay on this computer and in your account.')
    // a static control: turning it on moves nothing
    expect((await sync.boundingBox())!).toEqual(before)
    if (shotsOn()) {
      await memory.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shotsDir(info)}/memory-sync-desktop.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(sync).toBeVisible()
      await sync.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${shotsDir(info)}/memory-sync-390.png` })
    }
    await page.evaluate(() => sessionStorage.removeItem('sx-e2e-memory-sync'))
    await closeDialogs(page)
  })
})

/* ------------------------------------------------------------------ the tab against a stubbed proxy */

// A 1 by 1 PNG and a one page PDF
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test.describe('files on a message in the tab', () => {
  // A big picture is scaled down to 1568 px before it is sent. (A picture and a PDF going out as blocks, and a file that
  // is not one of them being left out, are unit tests: see the header.)
  test('a big picture is scaled down to 1568 px before it is sent', async ({ page }) => {
    await ready(page, 'cloud')
    const bodies = await stubProxy(page, () => answer('I can see the sketch and the drawing.'))
    await signIn(page)
    await emptyMimirTab(page)
    // signing in makes the runtime again on mimir cloud; the scripted replies' chip goes once it is there
    await expect(page.locator('.mimir-chat-scripted')).toHaveCount(0)
    const big = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 3000
      c.height = 2000
      const g = c.getContext('2d')!
      g.fillStyle = '#3a6'
      g.fillRect(0, 0, 3000, 2000)
      g.fillStyle = '#fff'
      g.fillRect(400, 400, 1200, 800)
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    const composer = page.getByTestId('mimir-composer')
    await composer.locator('input[type="file"]').setInputFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(big) }])
    await expect(page.getByTestId('mimir-attachment')).toHaveCount(1)
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0)
    const img = lastUserBlocks(bodies[0]!).find((b) => b.type === 'image')!
    expect(img.source!.media_type).toBe('image/jpeg')
    const size = await page.evaluate(async (data) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob())
      return [bmp.width, bmp.height]
    }, img.source!.data)
    expect(size).toEqual([1568, 1045])
  })
})

/* ------------------------------------------------------------------ See usage on a refusal */

// See usage on a mimir cloud refusal, against a stubbed proxy: a used-up day (day_used), the edition's day
// (edition_day_used) or the per-minute limit (slow_down) puts See usage on the chat's error line, and pressing it opens
// Settings at Account with the Usage section in view. Other refusals show no link. The proxy's own codes are tested in
// supabase/functions/mimir.
test.describe('See usage on a mimir cloud refusal', () => {
  const MESSAGES: Record<string, [number, string]> = {
    day_used: [429, "You've used today's free mimir. It resets in 5 h 12 min."],
    edition_day_used: [429, 'Free mimir is busy for today. It resets in 5 h 12 min.'],
    slow_down: [429, 'Slow down a moment, then try again.'],
    paused: [503, 'Free mimir is paused right now. We know and are fixing it. Your own key or a local model still works.'],
  }

  /** Opens the tab on mimir cloud, signed in through the build's browser host pointed at the stub, and asks once. */
  async function askAndRefuse(page: Page, code: keyof typeof MESSAGES): Promise<void> {
    const [status, message] = MESSAGES[code]!
    await ready(page, 'cloud', { notice: false })
    // the quota reports today used up
    const now = Date.now()
    const v2 = {
      day: { used: 1, resetsAt: new Date(now + (5 * 60 + 12) * 60_000 + 30_000).toISOString() },
      hourly: [...Array(20).fill(0), 0.3, 0.4, 0.2, 0.1],
      daily: [0.2, 0, 0.5, 0.9, 0.3, 0.1, 1],
      perMinute: { limit: 10 },
    }
    await stubProxy(page, () => ({ status, json: { type: 'error', error: { type: status === 429 ? 'mimir_limit' : 'overloaded_error', code, message } } }), {
      quota: { edition: 'slicerx-web', day: '2026-10-13', install_used: 250000, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true, v2 },
    })
    await signIn(page)
    await emptyMimirTab(page)
    // the question waits for the notice
    await setState(page, { pilotPrompt: 'a 20 mm cube' })
    await page.getByTestId('mimir-chat').getByTestId('mimir-notice-ok').click()
    const line = page.getByTestId('mimir-chat').getByTestId('mimir-limit')
    await expect(line).toHaveAttribute('data-code', code, { timeout: 30_000 })
    await expect(line).toContainText(MESSAGES[code]![1])
  }

  test('a used-up day links to Settings > Account with Usage in view', async ({ page }, info) => {
    await askAndRefuse(page, 'day_used')
    const link = page.getByTestId('mimir-chat').getByTestId('mimir-see-usage')
    await expect(link).toHaveText('See usage')
    if (shotsOn()) await page.getByTestId('mimir-chat').screenshot({ path: `${shotsDir(info)}/mimir-see-usage-line.png` })
    await link.click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByRole('heading', { name: 'Account' })).toBeVisible()
    // the account above loads after the section draws; Usage stays at the top of the pane with the used-up line in full view
    await expect(dialog.getByText('You have no API tokens.')).toBeAttached()
    await expect(dialog.getByRole('heading', { name: 'Usage' })).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('mu-today-left')).toHaveText('0%')
    await expect(page.getByTestId('mu-today-out')).toBeInViewport({ ratio: 1 })
    // only the section's own pane scrolls: the nav stays put, with Account shown as the current section
    const account = dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Account' })
    await expect(account).toHaveAttribute('aria-current', 'true')
    await expect(account).toBeInViewport({ ratio: 1 })
    const nav = await dialog.getByRole('navigation', { name: 'Settings sections' }).boundingBox()
    const body = await dialog.locator('.sx-dialog-body').first().boundingBox()
    expect(nav!.y).toBeGreaterThanOrEqual(body!.y - 1)
    if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/mimir-see-usage-account.png` })
    await closeDialogs(page)
  })

  for (const code of ['edition_day_used', 'slow_down'] as const) {
    test(`${code} links to usage too`, async ({ page }) => {
      await askAndRefuse(page, code)
      await page.getByTestId('mimir-chat').getByTestId('mimir-see-usage').click()
      await expect(page.getByTestId('mu-today-out')).toBeInViewport({ ratio: 1 })
      await closeDialogs(page)
    })
  }

  test('a pause has no usage link', async ({ page }) => {
    await askAndRefuse(page, 'paused')
    await expect(page.getByTestId('mimir-chat').getByTestId('mimir-see-usage')).toHaveCount(0)
  })
})

/* ------------------------------------------------------------------ the browser build that only models (cold) */

// mimir cloud in the browser build that only models, against a stubbed proxy: the mimir and Model tabs and no Slice, a
// parts note and no printer plugins, the answer above a folded sources line, and a reply even when the model ends
// silent. This build is chosen at the start (slicerx.e2e.cadOnly), so it has a page of its own.
cold.describe('mimir in the browser build that only models', () => {
  cold.skip(({ isMobile }) => isMobile, 'Desktop. The phone leg of mimir is in phone-session.spec.ts')

  cold('offers parts, answers above a folded sources line, and never ends silent', async ({ page }, info) => {
    const bodies = await stubProxy(page, (body) => {
      const asked = lastUserText(body)
      if (body.tool_choice?.type === 'none') return answer('I could not build it in one go. Which wall should the ports go in?')
      if (asked.includes('tool_result')) return answer('Use 0.2 mm for a strong bracket, per the layer height guide in the knowledge base.')
      if (asked.includes('layer height')) return [{ type: 'tool_use', id: 'tu_1', name: 'kb__search', input: { query: 'layer height strength' } }]
      if (asked.includes('silent')) return []
      return answer('A 20 mm cube, coming up.')
    })
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.e2e.cadOnly', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'mimir-cloud' }, mimirNotice: 2 }))
    })
    await page.goto('./')
    await viewportReady(page)
    await signIn(page)
    await expect(page.locator('.sx-tab[data-mode]')).toHaveText(['mimir', 'Model'])
    await page.getByTestId('tab-mimir').click()
    const chat = page.getByTestId('mimir-chat')
    await expect(chat).toBeVisible()
    // a parts note, nothing about slicing or printers
    await expect(chat.locator('.mimir-empty')).toContainText('Describe a part')
    await expect(chat.locator('.mimir-empty')).not.toContainText(/slice|printer/i)
    await expect(page.getByTestId('mimir-composer').getByRole('textbox')).toHaveAttribute('placeholder', 'Ask mimir')
    if (shotsOn()) await chat.screenshot({ path: `${shotsDir(info)}/web-tab-empty.png` })

    await askTab(page, 'What layer height for a strong bracket?')
    await expect(chat).toContainText('Use 0.2 mm for a strong bracket', { timeout: 30_000 })
    // no plugins, and the prompt is about parts in the browser, built with the design tools
    expect(bodies[0]?.system?.map((s) => s.text).join(' ')).toMatch(/in the browser, where people design parts/)
    expect(bodies[0]?.tools?.some((t) => t.name.startsWith('printer'))).toBe(false)
    expect(bodies[0]?.tools?.some((t) => t.name === 'text_to_part')).toBe(false)
    expect(bodies[0]?.tools?.some((t) => t.name.startsWith('design'))).toBe(true)
    // sources fold to one line under the answer, which stays in view
    const head = chat.getByRole('button', { name: /^Sources \(\d\)$/ })
    await expect(head).toBeVisible()
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(chat.getByText('Use 0.2 mm for a strong bracket')).toBeInViewport()
    if (shotsOn()) await chat.screenshot({ path: `${shotsDir(info)}/web-tab-answer.png` })

    // a model that ends with nothing is asked once more, with no tools, and its reply shows
    await askTab(page, 'Pi case, stay silent')
    await expect(chat).toContainText('Which wall should the ports go in?', { timeout: 30_000 })
    expect(bodies.at(-1)?.tool_choice?.type).toBe('none')
    // and the next message carries the conversation as context; New conversation forgets it
    await askTab(page, 'a 20 mm cube')
    await expect(chat).toContainText('A 20 mm cube, coming up.', { timeout: 30_000 })
    expect(JSON.stringify(bodies.at(-1)?.messages)).toContain('What layer height for a strong bracket?')
    await chat.getByRole('button', { name: 'New conversation' }).click()
    await expect(chat).not.toContainText('A 20 mm cube, coming up.')
  })
})
