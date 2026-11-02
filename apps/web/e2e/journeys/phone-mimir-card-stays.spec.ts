// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A question card stays where it is on screen when it is answered, on a phone at 390 px and on the desktop at 1440 px:
// pressing Cancel or a chip ends the wait, and on a phone the view comes back from its folded strip, which makes the
// chat shorter from the top. The card and the button just pressed must not move out from under the finger, in the
// frames while that happens or once the chat has settled. Each reading is of one frame in the page, taken once two
// reads a frame apart agree.
import type { Locator, Page } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, emptyMimirTab, setPilot, setState } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, pilot: { mode: 'on', provider: 'anthropic' } } })

/** The mimir tab on the scripted replies, with a new conversation and nothing on the plate. */
async function mimirTab(page: Page, phone: boolean): Promise<void> {
  await debugOn(page)
  await setPilot(page, 'scripted')
  if (!phone) return emptyMimirTab(page)
  await goTab(page, 'prepare')
  await setState(page, { plate: [], selection: null, selectedIds: [], toast: null })
  await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
  const chat = page.getByTestId('mimir-chat')
  await expect(chat).toBeVisible()
  await chat.getByRole('button', { name: 'New conversation' }).click()
}

/** The card's top on screen, read in one frame once two reads a frame apart agree. */
async function settled(card: Locator): Promise<number> {
  const at = () => card.evaluate((el) => new Promise<number>((done) => requestAnimationFrame(() => done(el.getBoundingClientRect().top))))
  let last = await at()
  for (let now = await at(); now !== last; now = await at()) last = now
  return last
}

/** Starts noting the card's top in every frame; the returned call stops and hands back every reading. */
async function everyFrame(card: Locator): Promise<() => Promise<number[]>> {
  await card.evaluate((el) => {
    const w = window as unknown as { __cardTops: number[]; __cardTopsOn: boolean }
    w.__cardTops = []
    w.__cardTopsOn = true
    const tick = () => {
      if (!w.__cardTopsOn) return
      w.__cardTops.push(el.getBoundingClientRect().top)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  return () =>
    card.evaluate(() => {
      const w = window as unknown as { __cardTops: number[]; __cardTopsOn: boolean }
      w.__cardTopsOn = false
      return w.__cardTops
    })
}

/** A question card waiting, then answered by `press`; its top stays put to 1 px through the answer and after. */
async function staysPut(page: Page, phone: boolean, press: (card: Locator) => Locator, shows: RegExp): Promise<void> {
  await mimirTab(page, phone)
  await askTab(page, 'Make a backplate for my thermostat')
  const card = page.getByTestId('mimir-choice')
  await expect(card.getByTestId('mimir-choice-cancel')).toBeEnabled({ timeout: 30_000 })
  const chat = page.getByTestId('mimir-chat')
  if (phone) await expect(chat).toHaveAttribute('data-card-waits', 'true')
  const before = await settled(card)
  const frames = await everyFrame(card)
  const target = press(card)
  await (phone ? target.tap() : target.click())
  await expect(card.getByTestId('mimir-choice-state')).toHaveText(shows)
  // on a phone the view is back once the card is answered
  if (phone) await expect(chat).not.toHaveAttribute('data-card-waits')
  const after = await settled(card)
  const tops = await frames()
  expect(Math.abs(after - before), `card top ${before} before, ${after} after`).toBeLessThanOrEqual(1)
  expect(Math.max(...tops.map((t) => Math.abs(t - before))), `card tops by frame: ${tops.join(', ')}`).toBeLessThanOrEqual(1)
}

journey.describe('a mimir question card stays under the finger when it is answered', () => {
  journey('Cancel leaves the card where it was', async ({ page, isMobile }) => {
    await staysPut(page, isMobile, (card) => card.getByTestId('mimir-choice-cancel'), /^Canceled$/)
    await expect(page.getByTestId('mimir-transcript')).toContainText('Okay, I will leave it for now.', { timeout: 30_000 })
  })

  journey('a chip leaves the card where it was', async ({ page, isMobile }) => {
    await staysPut(page, isMobile, (card) => card.getByRole('button', { name: 'A different model' }), /A different model/)
    await expect(page.getByTestId('mimir-transcript')).toContainText('Send me the model name', { timeout: 30_000 })
  })
})
