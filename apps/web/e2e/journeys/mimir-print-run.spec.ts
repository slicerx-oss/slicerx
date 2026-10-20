// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A whole print run from one mimir chat: the part, its slice, the send card with the bed tick, the progress card and
// the line when the print ends. The web build's demo printers are the printers (Bay 2, a P1S, idle with green PLA in
// A2; Bay 6, an H2C, idle with green PLA in A4; Bay 3, an MK4S, paused mid print), so a picker has a choice and a busy
// printer is there. The demo fleet ticks once a second on the page's own clock; `simClock` takes that tick, so a print
// finishes in a few seconds. The runout runs on a PrusaLink mock behind a real sx-link (bridge-hub.ts), since the
// demo fleet has no faults.
//
// Two ways in: the scripted print-run script (a message like "print this on my Bay 6"), and mimir cloud against the
// stubbed proxy (lib/session.ts), whose tool calls are the ones a model makes (run.target, slice, printer.queue), on a
// box put on the plate first. The send card's own rules (stale, busy, the tick) are the same either way.
//
// Dropped because a unit test has them: the A1's Developer Mode steps on the send card (packages/app/test, the send
// card tests).
import { writeFileSync } from 'node:fs'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { bridgeOn, ctl, hub, useBridge } from '../bridge-hub'
import { freshBox } from '../cad-helpers'
import { goTab, viewportReady } from '../fixtures'
import { answer, askTab, debugOn, emptyMimirTab, lastUserText, setPilot, shotsDir, shotsOn, setState, signIn, stubProxy, type Block, type ProxyBody } from './lib/session'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, pilot: { mode: 'on', provider: 'anthropic' }, scheme: 'dark', themeFollowsSystem: false } })
test.skip(({ isMobile }) => isMobile, 'Desktop. The phone width is in the screenshots, from the same page')

type Sx = { setState(p: unknown): void; getState(): Record<string, any> }
type W = { __sx: Sx; __sxSimTicks?: (() => void)[] }

/* ------------------------------------------------------------------ the demo fleet's clock */

/**
 * Keeps the demo fleet's one second tick (apps/web/src/host/printers.ts) where a test can call it, so a print moves on
 * at once instead of in real time. The page loads again once for it; later loads keep it.
 */
async function simClock(page: Page): Promise<void> {
  const has = () => page.evaluate(() => ((window as unknown as W).__sxSimTicks ?? []).length)
  if ((await has()) > 0) return
  await page.addInitScript(() => {
    const w = window as unknown as W
    if (w.__sxSimTicks) return
    w.__sxSimTicks = []
    const real = window.setInterval.bind(window)
    window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms === 1000 && typeof fn === 'function' && /\.tick\((?:1e3|1000)\)/.test(String(fn))) w.__sxSimTicks!.push(fn as () => void)
      return real(fn, ms, ...rest)
    }) as typeof window.setInterval
  })
  await goTab(page, 'prepare')
  await page.reload()
  await viewportReady(page)
  await expect.poll(has).toBe(1)
}

/** Runs the demo fleet `seconds` on, a minute at a time, until `done` holds or the time is used up. */
async function advance(page: Page, seconds: number, done: () => Promise<boolean>): Promise<void> {
  for (let left = seconds; left > 0 && !(await done()); left -= 60) {
    await page.evaluate((n) => {
      const ticks = (window as unknown as W).__sxSimTicks ?? []
      for (let i = 0; i < n; i++) for (const t of ticks) t()
    }, Math.min(60, left))
  }
}

/* ------------------------------------------------------------------ the chat */

const transcript = (page: Page) => page.getByTestId('mimir-transcript')
const sendCard = (page: Page) => page.getByTestId('mimir-send').last()

/** The tool calls a stubbed reply makes, one per round, with ids of their own. */
let seq = 0
const call = (name: string, input: unknown): Block[] => [{ type: 'tool_use', id: `tu_${++seq}`, name, input }]

/**
 * A stubbed model that plays `steps` in order, then says it is done. A step is played once the conversation holds the
 * calls of every step before it (their ids are its own), so a note the runtime adds or a chat that carries on from an
 * earlier one does not throw the order off.
 */
const playbook =
  (steps: Block[][]) =>
  (body: ProxyBody): Block[] => {
    const seen = JSON.stringify(body.messages)
    const ids = (step: Block[]) => step.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []))
    const next = steps.find((step) => !ids(step).length || ids(step).some((id) => !seen.includes(`"${id}"`)))
    return next ?? answer('That is all from me for now.')
  }

/**
 * What a model does once the part is on the plate: the printer and spool, the slice, then the send. The slice is the
 * slicing tool's, which keeps the plate for printer.queue (the app's own app.slice does not, see the Task 9 tests).
 */
const printSteps = (target: { printer?: string; filaments?: { material?: string; color?: string }[] }, printerId: string, last = 'The print is up to you now.'): Block[][] => [
  call('run.target', target),
  call('slice', {}),
  call('printer.queue', { printerId, plate: 1 }),
  answer(last),
]

/** The print profile the app loads for each demo printer the tests print on (Bay 2 a P1S, Bay 3 an MK4S, Bay 6 an H2C). */
const PROFILE: Record<string, string> = { 'bay-2': 'bambu-p1s', 'bay-3': 'prusa-mk4s', 'bay-6': 'bambu-h2c' }

/**
 * mimir cloud on the stubbed proxy, signed in, in an empty mimir tab with one 20 mm box on the plate, as a part the
 * chat made would be. With `printerId`, the box is placed on that printer's bed, the one the chat prints on, so it keeps
 * clear of the bed's excluded areas there. The page is the one the last test left (journey.ts), and a box placed for
 * another printer's bed can sit in such an area: the slice then refuses it and no send card follows. Returns the
 * requests the stub gets.
 */
async function boxInTab(page: Page, steps: Block[][], printerId?: string): Promise<ProxyBody[]> {
  await debugOn(page)
  await setPilot(page, 'cloud')
  const bodies = await stubProxy(page, playbook(steps))
  await signIn(page)
  await emptyMimirTab(page)
  await goTab(page, 'prepare')
  if (printerId) {
    await setState(page, { printerId })
    // the printer's profile, its bed and its excluded areas load a moment after the printer changes
    await expect.poll(() => page.evaluate(() => ((window as unknown as W).__sx.getState()['profile'] as { printerId?: string } | null)?.printerId ?? null)).toBe(PROFILE[printerId])
  }
  await freshBox(page)
  await page.getByTestId('tab-mimir').click()
  await expect(page.getByTestId('mimir-chat')).toBeVisible()
  // signing in makes the runtime again on mimir cloud; the scripted replies' chip goes once it is there. A page that
  // just paired with a hub is still making its runtime again for the new printers, so it signs in once more if needed.
  await expect(async () => {
    if ((await page.locator('.mimir-chat-scripted').count()) > 0) await signIn(page)
    await expect(page.locator('.mimir-chat-scripted')).toHaveCount(0, { timeout: 5_000 })
  }).toPass({ timeout: 30_000 })
  return bodies
}

/** The scripted stub in an empty mimir tab: the print-run script makes the part itself. */
async function scriptedTab(page: Page): Promise<void> {
  await debugOn(page)
  await setPilot(page, 'scripted')
  await emptyMimirTab(page)
}

/** Confirms the print-run script's Clip sizes sheet as it is: 30 x 12 x 8 mm, all guesses. */
async function confirmClip(page: Page): Promise<void> {
  const sheet = page.getByTestId('mimir-sheet-record').last()
  await expect(sheet).toBeVisible({ timeout: 30_000 })
  await expect(sheet).toContainText('Clip sizes')
  await sheet.getByTestId('mimir-sheet-confirm').click()
  await expect(sheet).toContainText('Confirmed as shown')
}

/** Waits until the send card has checked the printer as it is now. */
async function checked(card: Locator): Promise<void> {
  await expect(card.getByTestId('mimir-send-status')).not.toHaveText(/^Checking /, { timeout: 30_000 })
}

/** Moves every object on the plate 15 mm along X, as a drag in the view does. */
async function movePlate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sx = (window as unknown as W).__sx
    const plate = sx.getState()['plate'] as { transform: ArrayLike<number> }[]
    sx.setState({ plate: plate.map((e) => ({ ...e, transform: Array.from(e.transform, (v, i) => (i === 12 ? v + 15 : v)) })) })
  })
}

/**
 * The same page as a 390 by 844 touch screen (Chromium's device emulation), so the app takes its phone layout (a coarse
 * pointer at that width) with this chat, then back to the desktop. `during` runs in the phone layout with a capture
 * that goes through the same session, since Playwright's own screenshot puts its desktop size back first.
 */
async function asPhone(page: Page, during?: (capture: (path: string, card?: Locator) => Promise<void>) => Promise<void>): Promise<void> {
  const chat = page.getByTestId('mimir-chat')
  const phoneTab = page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]')
  const size = page.viewportSize()!
  const cdp = await page.context().newCDPSession(page)
  const capture = async (path: string, card?: Locator) => {
    const box = card ? await card.boundingBox() : null
    const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png', ...(box ? { clip: { ...box, scale: 1 } } : {}) })) as { data: string }
    writeFileSync(path, Buffer.from(data, 'base64'))
  }
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await expect(page.getByTestId('phone-tabs')).toBeVisible()
    if (!(await chat.isVisible())) await phoneTab.click()
    await expect(chat).toBeVisible()
    await during?.(capture)
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await cdp.detach()
    await page.setViewportSize(size)
    await expect(page.getByTestId('phone-tabs')).toHaveCount(0)
    if (!(await chat.isVisible())) await page.getByTestId('tab-mimir').click()
    await expect(chat).toBeVisible()
  }
}

/**
 * Desktop and phone shots of the chat, when shots are on. A send card still waiting for an answer gets `phone` false,
 * so the tests that check a waiting card across layout changes decide themselves when the layout changes.
 */
async function shots(page: Page, info: TestInfo, name: string, card?: Locator, phone = true): Promise<void> {
  if (!shotsOn()) return
  const dir = shotsDir(info)
  await card?.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${dir}/desktop-${name}.png` })
  if (card) await card.screenshot({ path: `${dir}/desktop-${name}-card.png` })
  if (!phone) return
  await asPhone(page, async (capture) => {
    await card?.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await capture(`${dir}/phone-${name}.png`)
    if (card) await capture(`${dir}/phone-${name}-card.png`, card)
  })
}

/**
 * Whether the view shows every part on the plate: the view draws it and the corners of its box land inside the view.
 * (A pick through its middle would depend on the view's mode, since the view picks only in Prepare.)
 */
async function partsInView(page: Page): Promise<boolean> {
  type Vp = { drawnObjects(): string[]; screenOf(p: number[]): [number, number]; canvas: HTMLCanvasElement }
  return page.evaluate(() => {
    const w = window as unknown as W & { __vp: Vp }
    const vp = w.__vp
    const plate = w.__sx.getState()['plate'] as { id: string; transform: ArrayLike<number>; parts: { positions: ArrayLike<number> }[] }[]
    const r = vp.canvas.getBoundingClientRect()
    return (
      plate.length > 0 &&
      plate.every((e) => {
        if (!vp.drawnObjects().includes(e.id)) return false
        const t = e.transform
        const lo = [Infinity, Infinity, Infinity]
        const hi = [-Infinity, -Infinity, -Infinity]
        for (const p of e.parts) {
          for (let i = 0; i < p.positions.length; i += 3) {
            const [x, y, z] = [p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!]
            const at = [0, 1, 2].map((k) => t[k]! * x + t[4 + k]! * y + t[8 + k]! * z + t[12 + k]!)
            at.forEach((v, k) => ((lo[k] = Math.min(lo[k]!, v)), (hi[k] = Math.max(hi[k]!, v))))
          }
        }
        const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => vp.screenOf([n & 1 ? hi[0]! : lo[0]!, n & 2 ? hi[1]! : lo[1]!, n & 4 ? hi[2]! : lo[2]!]))
        return corners.every(([x, y]) => x > r.left && x < r.right && y > r.top && y < r.bottom)
      })
    )
  })
}

/* ------------------------------------------------------------------ the run */

// with shots on, the page as a failed test left it, for the review
test.afterEach(async ({ page }, info) => {
  if (shotsOn() && info.status !== info.expectedStatus) await page.screenshot({ path: `${shotsDir(info)}/failed-${info.title.replace(/\W+/g, '-')}.png` })
})

test.describe('a print run in the mimir chat', () => {
  test('designs, slices, sends and finishes in one chat', async ({ page }, info) => {
    test.slow()
    await simClock(page)
    await scriptedTab(page)
    await askTab(page, 'Print this on my Bay 6 in green PLA')
    // the sizes first, guesses for the person to confirm
    await confirmClip(page)
    // the part: the 30 x 12 x 8 mm clip, as a card after its step rows
    const part = page.getByTestId('mimir-part').last()
    await expect(part).toBeVisible({ timeout: 60_000 })
    await expect(part).toContainText('30 x 12 x 8 mm')
    // the words settled the printer and spool: no picker
    await expect(page.getByTestId('mimir-target')).toHaveCount(0)
    const slice = page.getByTestId('mimir-slice').last()
    await expect(slice).toBeVisible({ timeout: 120_000 })
    await expect(slice).not.toHaveAttribute('data-stale')
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.locator('[data-row="Printer"]')).toContainText('Bay 6')
    await expect(card.locator('[data-row^="Filament "]')).toContainText('slot A4, PLA')
    await checked(card)
    await shots(page, info, 'run-send', card, false)
    await card.getByTestId('mimir-send-bed').check()
    await expect(card.getByTestId('danger-mimir-send-print')).toBeEnabled()
    await card.getByTestId('danger-mimir-send-print').click()
    const progress = page.getByTestId('mimir-progress').last()
    await expect(progress).toBeVisible({ timeout: 30_000 })
    await expect(progress).toContainText('Printing on Bay 6')
    await shots(page, info, 'run-printing', progress)
    await advance(page, 8000, async () => (await progress.getAttribute('data-state')) === 'finished')
    await expect(progress).toHaveAttribute('data-state', 'finished')
    await expect(progress).toContainText('Finished on Bay 6')
    await expect(transcript(page)).toContainText(/ finished on Bay 6\./)
    await shots(page, info, 'run-finished', progress)
  })

  test('the picker shows only when the words do not settle it', async ({ page }, info) => {
    test.slow()
    await scriptedTab(page)
    // a printer by name and a spool it has: straight on to the send card
    await askTab(page, 'Print this on my Bay 6 in green PLA')
    await confirmClip(page)
    await expect(sendCard(page)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('mimir-target')).toHaveCount(0)
    await sendCard(page).getByTestId('mimir-send-cancel').click()
    await expect(sendCard(page)).toHaveAttribute('data-state', 'closed')
    // no printer it knows, and a spool two printers hold (green PLA is in Bay 2 and Bay 6): the person picks
    await page.getByTestId('mimir-chat').getByRole('button', { name: 'New conversation' }).click()
    await askTab(page, 'Print it on my printer in green PLA')
    await confirmClip(page)
    const picker = page.getByTestId('mimir-target')
    await expect(picker).toBeVisible({ timeout: 60_000 })
    await expect(picker.locator('.target-rec-printer')).not.toHaveCount(1)
    await expect(picker).toContainText('Bay 2')
    await expect(picker).toContainText('Bay 6')
    // the offline printer is left out
    await expect(picker).not.toContainText('Bay 5')
    await shots(page, info, 'picker', picker)
    await picker.getByRole('button', { name: 'Bay 6, slot A4: PLA Green' }).click()
    await expect(picker).toHaveAttribute('data-picked', 'pick:bay-6:A4')
    await expect(sendCard(page)).toBeVisible({ timeout: 120_000 })
    await expect(sendCard(page).locator('[data-row="Printer"]')).toContainText('Bay 6')
    await sendCard(page).getByTestId('mimir-send-cancel').click()
    await expect(sendCard(page)).toHaveAttribute('data-state', 'closed')
    // No printer named, and only one printer online holds the spool asked for (white ASA is in Bay 2 alone): no picker.
    // The script always names a printer ("on my ..."), so a model on the stubbed proxy asks for the spool alone.
    const bodies = await boxInTab(page, [call('run.target', { filaments: [{ material: 'ASA', color: 'white' }] }), answer('Bay 2 has white ASA.')])
    await askTab(page, 'Print it in white ASA')
    await expect(transcript(page)).toContainText('Bay 2 has white ASA.', { timeout: 30_000 })
    await expect(page.getByTestId('mimir-target')).toHaveCount(0)
    expect(lastUserText(bodies.at(-1)!)).toContain('Printing on Bay 2 from slot A3')
  })

  test('a scripted part slices where it lands', async ({ page }, info) => {
    test.slow()
    await scriptedTab(page)
    // the part is made for the H2C's bed, then the words move the print to the P1S, whose bed keeps a corner clear
    await setState(page, { printerId: 'bay-6' })
    await askTab(page, 'Print this on my Bay 2 in green PLA')
    await confirmClip(page)
    const slice = page.getByTestId('mimir-slice').last()
    await expect(slice).toBeVisible({ timeout: 120_000 })
    await expect(slice).not.toHaveAttribute('data-stale')
    // sliced on the first try: one slice, no refusal about where the part sits, in the chat or a toast
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.locator('[data-row="Printer"]')).toContainText('Bay 2')
    await expect(page.getByTestId('mimir-slice')).toHaveCount(1)
    // the slice preflight's refusal and the words for a part left off the bed
    const where = /printable area|excluded bed area|outside the (?:bed|plate)|safety preflight|off the bed|no room for/i
    await expect(transcript(page)).not.toContainText(where)
    await expect(page.getByTestId('toast').filter({ hasText: where })).toHaveCount(0)
    // the part shows in the view beside the cards: the view stayed on it when the bed changed to the P1S's
    await expect.poll(() => partsInView(page), { timeout: 10_000 }).toBe(true)
    await shots(page, info, 'placed', slice, false)
    await card.getByTestId('mimir-send-cancel').click()
    await expect(card).toHaveAttribute('data-state', 'closed')
  })

  test('Print stays off until the bed is ticked', async ({ page }, info) => {
    test.slow()
    const bodies = await boxInTab(page, printSteps({ printer: 'Bay 2', filaments: [{ material: 'PLA', color: 'green' }] }, 'bay-2', 'Tick the bed check when the plate is clear.'), 'bay-2')
    await askTab(page, 'Print it on Bay 2 in green PLA')
    // the printer tools went to the model
    await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0)
    // (the wire names spell a dot as two underscores)
    expect(bodies[0]!.tools?.map((t) => t.name.replaceAll('__', '.'))).toEqual(expect.arrayContaining(['run.target', 'slice', 'printer.queue']))
    // the words named the printer and a spool it has: no picker
    await expect(page.getByTestId('mimir-slice').last()).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('mimir-target')).toHaveCount(0)
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.locator('[data-row="Printer"]')).toContainText('Bay 2')
    // the box's filament moved to the green spool's slot, so it is filament 2 on this plate
    await expect(card.locator('[data-row^="Filament "]')).toContainText('slot A2, PLA, Green')
    await checked(card)
    const print = card.getByTestId('danger-mimir-send-print')
    const bed = card.getByTestId('mimir-send-bed')
    // everything else passes: only the tick keeps Print off
    await expect(card.getByTestId('mimir-send-errors')).toHaveCount(0)
    await expect(bed).not.toBeChecked()
    await expect(print).toBeDisabled()
    await expect(card).toHaveAttribute('data-state', 'off')
    await expect(card.getByTestId('mimir-send-status')).toContainText('Tick the bed check to print.')
    await shots(page, info, 'bed-unticked', card, false)
    // ticked, Print turns on; unticked again, off; the button keeps its box either way
    const before = await print.boundingBox()
    await bed.check()
    await expect(print).toBeEnabled()
    await expect(card).toHaveAttribute('data-state', 'ready')
    expect(await print.boundingBox()).toEqual(before)
    await bed.uncheck()
    await expect(print).toBeDisabled()
    // the layout goes to the phone and back while the card waits; the card can still be answered
    await asPhone(page)
    await expect(card).toHaveAttribute('data-state', 'off')
    // Not now sends nothing, and no print starts
    await card.getByTestId('mimir-send-cancel').click()
    await expect(card).toHaveAttribute('data-state', 'closed')
    await expect(card.getByTestId('mimir-send-status')).toHaveText('Not sent')
    await expect(card).not.toContainText('No pending approval')
    await expect(transcript(page)).toContainText('Tick the bed check when the plate is clear.', { timeout: 30_000 })
    await expect(page.getByTestId('mimir-progress')).toHaveCount(0)
    await shots(page, info, 'not-sent', card)
  })

  // each trip to the phone layout and back makes the tab's runtime again; the card still answers after two
  test('a waiting send card still answers after the layout changes twice', async ({ page }) => {
    test.slow()
    await boxInTab(page, printSteps({ printer: 'Bay 2', filaments: [{ material: 'PLA', color: 'green' }] }, 'bay-2', 'Not sent, then.'), 'bay-2')
    await askTab(page, 'Print it on Bay 2 in green PLA')
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 120_000 })
    await checked(card)
    // to the phone and back, twice, while the card waits
    await asPhone(page)
    await asPhone(page)
    await card.getByTestId('mimir-send-cancel').click()
    await expect(card).toHaveAttribute('data-state', 'closed')
    await expect(card.getByTestId('mimir-send-status')).toHaveText('Not sent')
    await expect(transcript(page)).toContainText('Not sent, then.', { timeout: 30_000 })
  })

  test('a stale slice cannot be sent', async ({ page }, info) => {
    test.slow()
    const bodies = await boxInTab(page, printSteps({ printer: 'Bay 2', filaments: [{ material: 'PLA', color: 'green' }] }, 'bay-2'), 'bay-2')
    await askTab(page, 'Print it on Bay 2 in green PLA')
    const slice = page.getByTestId('mimir-slice').last()
    await expect(slice).toBeVisible({ timeout: 120_000 })
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await checked(card)
    const print = card.getByTestId('danger-mimir-send-print')
    await card.getByTestId('mimir-send-bed').check()
    await expect(print).toBeEnabled()
    // the part moves after slicing: Print goes off and the card says to slice again
    await movePlate(page)
    await expect(print).toBeDisabled()
    await expect(card.getByTestId('mimir-send-errors')).toContainText('The plate changed after this slice. Slice it again.')
    await expect(card.getByTestId('mimir-send-status')).toContainText('Print stays off.')
    await expect(slice).toHaveAttribute('data-stale', 'true')
    await expect(slice.getByRole('status')).toHaveText('The plate changed after this slice. Slice it again.')
    await shots(page, info, 'stale', card, false)
    await card.getByTestId('mimir-send-cancel').click()
    await expect(card).toHaveAttribute('data-state', 'closed')
    // asked to send it anyway, printer.queue refuses before any card
    expect(bodies.length).toBeGreaterThan(0)
    const again = await stubProxy(page, playbook([call('printer.queue', { printerId: 'bay-2', plate: 1 }), answer('I did not send it.')]))
    await askTab(page, 'Send it anyway')
    await expect(transcript(page)).toContainText('I did not send it.', { timeout: 30_000 })
    // the tool's answer the model got back is the slice-again refusal
    expect(lastUserText(again.at(-1)!)).toContain('The plate changed after')
    await expect(page.getByTestId('mimir-send')).toHaveCount(1)
    await expect(page.getByTestId('mimir-progress')).toHaveCount(0)
  })

  test('a busy printer keeps Print off and offers another', async ({ page }, info) => {
    test.slow()
    // Bay 3 is paused mid print, 31% in, so the demo clock never ends its job
    await boxInTab(page, printSteps({ printer: 'Bay 3' }, 'bay-3'), 'bay-3')
    await askTab(page, 'Print it on Bay 3')
    await expect(page.getByTestId('mimir-slice').last()).toBeVisible({ timeout: 120_000 })
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.locator('[data-row="Printer"]')).toContainText('Bay 3')
    await checked(card)
    // the busy line names the state and the time left, and points to another printer
    await expect(card.getByTestId('mimir-send-errors')).toContainText(/Bay 3 is paused, about .+ left\. Pick another printer or wait until it finishes\./)
    await expect(card.getByTestId('mimir-send-status')).toContainText('Print stays off.')
    // the tick does not turn it on
    await card.getByTestId('mimir-send-bed').check()
    await expect(card.getByTestId('danger-mimir-send-print')).toBeDisabled()
    await expect(card).toHaveAttribute('data-state', 'off')
    await shots(page, info, 'busy', card, false)
    await card.getByTestId('mimir-send-cancel').click()
    await expect(card).toHaveAttribute('data-state', 'closed')
  })

  test('one card, not two', async ({ page }, info) => {
    test.slow()
    await simClock(page)
    // the box is placed for Bay 3's MK4S bed, where it sits in the P1S's excluded corner; when the chat moves the print
    // to Bay 2, the box lands again on the P1S bed, so the first slice goes through and the send card follows
    await boxInTab(page, printSteps({ printer: 'Bay 2', filaments: [{ material: 'PLA', color: 'green' }] }, 'bay-2', 'It is printing on Bay 2.'), 'bay-3')
    const placed = () => page.evaluate(() => ((window as unknown as W).__sx.getState()['plate'] as { transform: number[] }[]).map((e) => e.transform.join(',')))
    const before = await placed()
    await askTab(page, 'Print it on my Bay 2 instead, in green PLA')
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 120_000 })
    expect(await placed()).not.toEqual(before)
    await checked(card)
    await card.getByTestId('mimir-send-bed').check()
    await card.getByTestId('danger-mimir-send-print').click()
    // the click is the approval: the printer guard's own card never opens, and no second send card follows
    const progress = page.getByTestId('mimir-progress').last()
    await expect(progress).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-state', 'approved')
    await expect(card.getByTestId('mimir-send-status')).toContainText('Print approved by you at')
    await expect(transcript(page)).toContainText('It is printing on Bay 2.', { timeout: 30_000 })
    await expect(page.locator('dialog.approve-dialog[open]')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('mimir-send')).toHaveCount(1)
    await shots(page, info, 'printing', progress)
    // the print runs to its end on the demo clock: one finished line, and the printer free for the next run
    await advance(page, 8000, async () => (await progress.getAttribute('data-state')) === 'finished')
    await expect(progress).toHaveAttribute('data-state', 'finished')
    await expect(progress).toContainText('Finished on Bay 2')
    await expect(transcript(page).getByText(/ finished on Bay 2\./)).toHaveCount(1)
    await expect(page.locator('dialog.approve-dialog[open]')).toHaveCount(0)
    await shots(page, info, 'finished', progress)
  })
})

/* ------------------------------------------------------------------ a runout, on a mock behind sx-link */

test.describe('a runout on the PrusaLink mock', () => {
  useBridge(['prusalink'], async () => {
    await hub.admin.addPrinter({ id: 'mk4s', name: 'MK4S', plugin: 'prusalink', host: '127.0.0.1', port: hub.ports['prusalink'] ?? 0 }, { vendor: 'Prusa Research', model: 'MK4S' })
  })

  test('a runout posts the stopped line', async ({ page }, info) => {
    test.slow()
    // The build reads this file's hub port as the page loads (bridge-hub.ts), so the page loads once first. Then mimir
    // signs in and the page pairs where it is, with no load, so the chat keeps its signed-in runtime. Paired, the page
    // lists the hub's printers in place of the demo fleet.
    await goTab(page, 'prepare')
    await page.reload()
    await viewportReady(page)
    await boxInTab(page, printSteps({ printer: 'MK4S' }, 'mk4s', 'It is printing on the MK4S.'))
    await bridgeOn(page)
    await page.keyboard.press('Escape')
    await page.getByTestId('tab-mimir').click()
    await expect(page.getByTestId('mimir-chat')).toBeVisible()
    await expect(page.locator('.mimir-chat-scripted')).toHaveCount(0)
    await askTab(page, 'Print it on the MK4S')
    const card = sendCard(page)
    await expect(card).toBeVisible({ timeout: 120_000 })
    await checked(card)
    await card.getByTestId('mimir-send-bed').check()
    await card.getByTestId('danger-mimir-send-print').click()
    const progress = page.getByTestId('mimir-progress').last()
    await expect(progress).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => ((await ctl('/state'))['prusalink'] as { state?: string }).state, { timeout: 30_000 }).toBe('printing')
    await ctl('/tick', { mock: 'prusalink', seconds: 60 })
    await expect(progress).toHaveAttribute('data-state', 'printing', { timeout: 30_000 })
    try {
      // the runout sensor trips: the printer stops the print and says why
      await ctl('/fault', { mock: 'prusalink', kind: 'runout' })
      // the print waits on the person, so the line says it paused and why, once
      await expect(transcript(page).getByText('MK4S paused: Filament runout.')).toHaveCount(1, { timeout: 30_000 })
      await expect(progress).toHaveAttribute('data-state', 'paused')
      await expect(progress).toContainText('Paused on MK4S')
      await shots(page, info, 'runout', progress)
    } finally {
      if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/desktop-runout-end.png` })
      await ctl('/fault', { mock: 'prusalink', kind: 'clear' })
    }
  })
})
