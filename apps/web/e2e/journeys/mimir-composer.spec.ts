// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's message box under fast typing and while a card waits, and the part card's Change size: every key typed at full
// speed lands in order, a paste lands as pasted, words sent while a dimension sheet waits reach mimir (the sheet is set
// aside and says so) instead of sitting in the box, Change size opens its size row on the first click, and with no
// model connected Enter keeps the message and says where to connect one. Scripted, no model behind it.
import type { Page } from '@playwright/test'
import { journey as test, expect } from '../journey'
import { debugOn, emptyMimirTab, setPilot } from './lib/session'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'anthropic' }, scheme: 'dark', themeFollowsSystem: false } })
test.skip(({ isMobile }) => isMobile, 'Desktop. The phone composer is in phone-mimir-keyboard.spec.ts')

const PI = 'Design a Raspberry Pi 5 case: a base with four standoffs for the board, port cutouts for USB-C, two micro HDMI, the USB ports and Ethernet, vents in the side walls, and a snap-fit lid that prints flat next to it.'
const TWEAK = 'I want to tweak it so the lid opens out flat, with the vents a bit wider and 2 mm more room above the board.'

async function fresh(page: Page): Promise<void> {
  await debugOn(page)
  await setPilot(page, 'scripted')
  await emptyMimirTab(page)
  // the page lives across tests, and the box keeps a draft through a new conversation
  await page.getByTestId('mimir-composer').getByRole('textbox').fill('')
}

test.describe('the message box', () => {
  test.beforeEach(async ({ page }) => fresh(page))

  // A person (or a tool) typing faster than the page draws: no key is lost, doubled or moved.
  test('keeps every key of a long message typed at full speed', async ({ page }) => {
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    await box.click()
    await page.keyboard.type(PI, { delay: 0 })
    await expect(box).toHaveValue(PI)
    await box.fill('')
    await page.keyboard.type(TWEAK, { delay: 0 })
    await expect(box).toHaveValue(TWEAK)
  })

  // A paste is one insert at the caret, with nothing typed before it left behind.
  test('takes a pasted message as pasted', async ({ page }) => {
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    await box.click()
    await page.keyboard.insertText('Lay the lid flat beside the base, roof down.')
    await expect(box).toHaveValue('Lay the lid flat beside the base, roof down.')
  })

  // While a dimension sheet waits, Return still does something: the words go to mimir, the sheet is set aside, and its
  // record says so. Nothing sits in the box with no answer.
  test('sends words written while a sheet waits, and sets the sheet aside', async ({ page }) => {
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    await box.fill('Make me a box with a lid')
    await box.press('Enter')
    const rec = page.getByTestId('mimir-sheet-record')
    await expect(rec.getByTestId('mimir-sheet-confirm')).toBeVisible()
    await expect(page.getByTestId('mimir-composer')).toHaveAttribute('data-answers', 'sheet')
    await box.click()
    await page.keyboard.type('make it 10 mm taller', { delay: 0 })
    await box.press('Enter')
    await expect(box).toHaveValue('')
    await expect(rec.getByTestId('mimir-sheet-status')).toContainText('Set aside')
    await expect(rec.getByTestId('mimir-sheet-said')).toHaveText('make it 10 mm taller')
    await expect(rec.getByTestId('mimir-sheet-confirm')).toHaveCount(0)
    await expect(page.getByTestId('mimir-sheet-drawing')).toHaveCount(0)
  })
})

test.describe('the part card', () => {
  test.beforeEach(async ({ page }) => fresh(page))

  // Change size opens its size row on the first click, with the first axis ready to type in.
  test('Change size opens the size row on the first click', async ({ page }) => {
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    await box.fill('Make me a box with a lid')
    await box.press('Enter')
    await page.getByTestId('mimir-sheet-confirm').click()
    const card = page.getByTestId('mimir-part').last()
    await expect(card).toBeVisible({ timeout: 60_000 })
    // the run is done: the box is back to Send
    await expect(page.getByTestId('mimir-composer').getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 60_000 })
    // the box still has focus from sending, as it would for a person who typed the request
    await box.focus()
    const resize = page.getByTestId('mimir-follow').filter({ hasText: 'Change size' }).last()
    await resize.click()
    await expect(resize).toHaveAttribute('aria-expanded', 'true')
    const row = page.getByRole('group', { name: 'Change size' }).last()
    await expect(row).toBeVisible()
    await expect(row).toBeInViewport()
    await expect(row.locator('input').first()).toBeFocused()
  })
})

test.describe('with no model connected', () => {
  test.beforeEach(async ({ page }) => fresh(page))

  // Enter keeps the message and says where to connect, instead of doing nothing; connecting or emptying the box clears it.
  test('says to connect a model above on Enter, keeping the message', async ({ page }) => {
    await setPilot(page, 'unset')
    await expect(page.getByTestId('mimir-connect')).toBeVisible()
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    const note = page.getByTestId('mimir-composer-off-note')
    await box.fill('Make me a box with a lid')
    await expect(note).toHaveCount(0)
    await box.press('Enter')
    await expect(box).toHaveValue('Make me a box with a lid')
    await expect(note).toHaveText('Connect a model above to send this.')
    await expect(note).toHaveAttribute('role', 'status')
    // an empty box says nothing
    await box.fill('')
    await expect(note).toHaveCount(0)
    await box.fill('Make me a box with a lid')
    await box.press('Enter')
    await expect(note).toBeVisible()
    // once a model is connected the line goes and the message is still there to send
    await setPilot(page, 'scripted')
    await expect(note).toHaveCount(0)
    await expect(box).toHaveValue('Make me a box with a lid')
  })

  // With turns in the chat the connect card is not shown, so the line points at Settings.
  test('says to connect a model in Settings once the chat has turns', async ({ page }) => {
    const box = page.getByTestId('mimir-composer').getByRole('textbox')
    await box.fill('Make me a box with a lid')
    await box.press('Enter')
    await page.getByTestId('mimir-sheet-confirm').click()
    await expect(page.getByTestId('mimir-part').last()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('mimir-composer').getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 60_000 })
    await setPilot(page, 'unset')
    await expect(page.getByTestId('mimir-connect')).toHaveCount(0)
    await box.fill('Make it 10 mm taller')
    await box.press('Enter')
    await expect(box).toHaveValue('Make it 10 mm taller')
    await expect(page.getByTestId('mimir-composer-off-note')).toHaveText('Connect a model in Settings to send this.')
    await setPilot(page, 'scripted')
    await expect(page.getByTestId('mimir-composer-off-note')).toHaveCount(0)
  })
})

