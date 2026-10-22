// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab on a phone with the on-screen keyboard up, at 390 and 360 px wide: the field being typed in stays in
// view above the keys, whether it is the composer, a size on the waiting sheet's record or a size in the sizes panel,
// and the composer, the record's Confirm and the panel's Done stay in reach. The keyboard is a stand-in that shrinks
// the visual viewport as a phone does (lib/phone-keyboard.ts). With the sizes panel open the view keeps its 42% while
// the keyboard is down and folds away while it is up, so a whole row and its field show; shutting the keyboard brings
// the view back.
import type { Locator, Page } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, noHorizontalScroll, setPilot, setState } from './lib/session'
import { clearOfKeys, keyboard, KEYBOARD_PHONES as PHONES, placeOf, rowsInView } from './lib/phone-keyboard'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true } })

/** The mimir tab from the tab bar, on the scripted replies, with a new conversation and nothing on the plate. */
async function phoneMimir(page: Page): Promise<void> {
  await debugOn(page)
  await goTab(page, 'prepare')
  await setPilot(page, 'scripted')
  await setState(page, { plate: [], selection: null, selectedIds: [], toast: null })
  await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
  const chat = page.getByTestId('mimir-chat')
  await expect(chat).toBeVisible()
  await chat.getByRole('button', { name: 'New conversation' }).click()
}

/** The top bar and the chat's header stay on screen: the keyboard pushes nothing off the top. */
async function nothingPushedOff(page: Page, at: number): Promise<void> {
  for (const [what, el] of [
    ['the top bar', page.locator('.sx-appbar-phone')],
    ["the chat's header", page.locator('.mimir-chat-head')],
  ] as const) {
    const p = await placeOf(el)
    expect(p.top, `${what} at ${at} px`).toBeGreaterThanOrEqual(p.shownTop - 0.5)
    expect(p.bottom, `${what} at ${at} px`).toBeLessThanOrEqual(p.shownBottom + 0.5)
  }
  await noHorizontalScroll(page)
}

/** Focuses a field the way a tap does, with the keyboard down, then opens the keyboard. */
async function typeIn(page: Page, field: Locator, keys: number, panned = 0): Promise<void> {
  await keyboard(page, 0)
  await field.scrollIntoViewIfNeeded()
  await field.focus()
  await keyboard(page, keys, panned)
  await expect(field).toBeFocused()
}

journey.describe('the mimir tab with the keyboard up on a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('the composer stays above the keys while typing, at one line and at three', async ({ page }) => {
    await phoneMimir(page)
    const composer = page.getByTestId('mimir-composer')
    const box = composer.getByRole('textbox')
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      await typeIn(page, box, phone.keys)
      await box.pressSequentially('A wall plate')
      await clearOfKeys(box, `the message box at ${phone.width} px`)
      await clearOfKeys(composer.getByRole('button', { name: 'Send' }), `Send at ${phone.width} px`)
      await box.fill('A wall plate 120 by 80 mm and 3 mm thick, with two screw holes 60 mm apart and a slot for the cable')
      await clearOfKeys(box, `three lines at ${phone.width} px`)
      await clearOfKeys(composer.getByRole('button', { name: 'Send' }), `Send under three lines at ${phone.width} px`)
      await nothingPushedOff(page, phone.width)
      // Safari pans what shows down to the field: the tab follows, so the top bar stays in view
      await keyboard(page, phone.keys, 60)
      await clearOfKeys(box, `the message box, panned, at ${phone.width} px`)
      await nothingPushedOff(page, phone.width)
      // the keyboard goes: the composer is back on the tab bar
      await keyboard(page, 0)
      const tabs = (await page.getByTestId('phone-tabs').boundingBox())!
      const c = (await composer.boundingBox())!
      expect(c.y + c.height, `the composer on the tab bar at ${phone.width} px`).toBeLessThanOrEqual(tabs.y + 0.5)
      expect(c.y + c.height).toBeGreaterThanOrEqual(tabs.y - 24)
      await box.fill('')
    }
  })

  journey("a size on the waiting sheet's record stays above the keys, and Confirm stays in reach", async ({ page }) => {
    journey.slow()
    await phoneMimir(page)
    await askTab(page, 'Make a backplate for my thermostat')
    const yes = page.getByRole('button', { name: 'Yes, that one' })
    await expect(yes).toBeVisible({ timeout: 30_000 })
    await yes.click()
    const rec = page.getByTestId('mimir-sheet-record').last()
    await expect(rec.getByTestId('mimir-sheet-confirm')).toBeVisible({ timeout: 30_000 })
    const fields = rec.locator('.sheet-rec-field input')
    expect(await fields.count()).toBeGreaterThan(1)
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      for (const field of [fields.first(), fields.last()]) {
        await typeIn(page, field, phone.keys)
        await clearOfKeys(field, `a record size at ${phone.width} px`)
        await clearOfKeys(page.getByTestId('mimir-composer'), `the composer at ${phone.width} px`)
        // a size being typed in keeps the record in view, so the pill that brings it back covers nothing
        await expect(page.getByTestId('mimir-sizes-pill'), `the Sizes pill at ${phone.width} px`).toBeHidden()
        await nothingPushedOff(page, phone.width)
      }
      // Confirm is a scroll away inside the chat, never under the keys
      const confirm = rec.getByTestId('mimir-sheet-confirm')
      await confirm.scrollIntoViewIfNeeded()
      await clearOfKeys(confirm, `Confirm at ${phone.width} px`)
      await expect(fields.last()).toBeFocused()
      await keyboard(page, 0)
    }
  })

  journey('a size in the sizes panel stays above the keys with a whole row, the view folds while typing and comes back', async ({ page }) => {
    journey.slow()
    await phoneMimir(page)
    await askTab(page, 'Make me a stand for my phone')
    await page.getByTestId('mimir-choice').getByRole('button', { name: 'An iPhone 15' }).click()
    const rec = page.getByTestId('mimir-sheet-record').last()
    await expect(rec.getByTestId('mimir-sheet-confirm')).toBeVisible({ timeout: 30_000 })
    await rec.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-transcript')).toContainText('The stand is on the plate', { timeout: 60_000 })
    await expect(page.getByTestId('mimir-filament')).toBeVisible({ timeout: 30_000 })
    const panel = page.getByTestId('mimir-sheet-panel')
    const view = page.locator('.studio > .vp')
    const studio = page.locator('.studio[data-model-mode="mimir"]')
    await rec.getByTestId('mimir-sheet-open').scrollIntoViewIfNeeded()
    await rec.getByTestId('mimir-sheet-open').tap()
    await expect(panel).toHaveAttribute('data-mode', 'drive')
    // the sizes tied to a step take a value; the stand's width is one
    const fields = panel.locator('[data-testid="mimir-sheet-row"] input:enabled')
    expect(await fields.count()).toBeGreaterThanOrEqual(1)
    for (const phone of PHONES) {
      await page.setViewportSize(phone)
      await keyboard(page, 0)
      // keyboard down: the view keeps its 42%, so the part shows changing while a size is edited
      const share = async () => (await view.boundingBox())!.height / (await studio.boundingBox())!.height
      expect(await share(), `the view's share at ${phone.width} px`).toBeCloseTo(0.42, 2)
      for (const field of [fields.first(), fields.last()]) {
        await typeIn(page, field, phone.keys)
        // keyboard up: the view folds, and a whole row with its field shows above the keys
        await expect(view).toHaveJSProperty('offsetHeight', 0)
        const rows = await rowsInView(panel)
        expect(rows.whole, `whole rows in view at ${phone.width} px`).toBeGreaterThanOrEqual(1)
        await clearOfKeys(field.locator('xpath=ancestor::li[1]'), `the edited row at ${phone.width} px`)
        await clearOfKeys(field, `the edited size at ${phone.width} px`)
        await clearOfKeys(page.getByTestId('mimir-sheet-close'), `Done at ${phone.width} px`)
        await clearOfKeys(page.getByTestId('mimir-composer'), `the composer at ${phone.width} px`)
        await nothingPushedOff(page, phone.width)
      }
      // the keyboard goes: the view is back at its 42% and the panel is still open
      await keyboard(page, 0)
      expect(await share(), `the view back at ${phone.width} px`).toBeCloseTo(0.42, 2)
      await expect(panel).toBeVisible()
    }
  })
})
