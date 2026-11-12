// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When mimir's reply would end with the plan approved in the same run unfinished, it goes on once and the chat shows one
// plain line that says so. The scripted mounting plate plays that out: at its default size its sheet and plan go ahead
// with nobody asked, the
// plate is built, and the reply stops to ask whether to add the screw holes the plan already has. The line shows once,
// in the reply, and the run goes on to build the holes and check the part. On the desktop at 1440 px and on a phone at
// 390 px; with SX_SHOTS set, each takes the line in light and dark.
import type { Page } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, emptyMimirTab, setPilot, setState, shotsDir, shotsOn } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, pilot: { mode: 'on', provider: 'anthropic' } } })

/** The line mimir's chat shows when it goes on to the screw holes the approved plan still needs. */
const PLAN_LEFT_LINE = 'mimir went on to the parts the plan still needs: Screw holes.'

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

journey.describe('mimir goes on with an approved plan it has not finished', () => {
  journey('one line says it went on to the screw holes the plan still needs, and the run builds them', async ({ page, isMobile }, info) => {
    await mimirTab(page, isMobile)
    await askTab(page, 'Make a mounting plate')
    // a mounting plate at its default size goes ahead with nobody asked: its sheet reads confirmed and its plan card
    // approved, with no Go, and one line on how to change it after
    const sheet = page.getByTestId('mimir-sheet-record').first()
    await expect(sheet).toHaveAttribute('data-auto', '', { timeout: 30_000 })
    await expect(sheet.getByTestId('mimir-sheet-status')).toHaveText('Confirmed as shown')
    await expect(sheet.getByTestId('mimir-sheet-confirm')).toHaveCount(0)
    const card = page.getByTestId('mimir-plan-card')
    await expect(card).toHaveAttribute('data-auto', 'true', { timeout: 30_000 })
    await expect(card.getByTestId('mimir-plan-go')).toHaveCount(0)
    await expect(card.getByTestId('mimir-plan-auto')).toHaveText('Built at its default size; ask to resize or change it.')
    await expect(page.getByTestId('mimir-plan-status')).toHaveText('Approved as shown')
    const transcript = page.getByTestId('mimir-transcript')
    // the reply that stopped to ask, then the line, then the holes and the check after it
    await expect(transcript).toContainText('The plate is built. Should I add the screw holes next?', { timeout: 30_000 })
    await expect(transcript).toContainText('Done: the mounting plate, 80 x 50 x 4 mm with four 4.5 mm screw holes. It matches the plan.', { timeout: 30_000 })
    const line = page.getByTestId('mimir-plan-left')
    await expect(line).toHaveCount(1)
    await expect(line).toHaveText(PLAN_LEFT_LINE)
    await expect(line).toBeVisible()
    // a plain line, never an error block with the alert icon
    await expect(transcript.locator('[role="alert"]')).toHaveCount(0)
    // the part on the plate has both planned steps
    const plate = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { name: string; history?: { steps: unknown[] } }[] } } }).__sx.getState().plate.map((e) => ({ name: e.name, steps: e.history?.steps.length ?? 0 })))
    await expect.poll(plate).toEqual([{ name: 'Mounting plate', steps: 2 }])
    if (!shotsOn()) return
    const width = isMobile ? 390 : 1440
    for (const scheme of ['light', 'dark'] as const) {
      await setState(page, { scheme, themeFollowsSystem: false })
      await line.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.mouse.move(0, 0)
      // the theme's colors settle before the shot
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${shotsDir(info)}/mimir-plan-left-${width}-${scheme}.png` })
    }
  })
})
