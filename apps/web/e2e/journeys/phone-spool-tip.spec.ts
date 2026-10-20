// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The spool tips in the mimir chat on a phone. Under a finished part, the Print with row shows the printer's spools, and
// the chat's composer sits just under that row, so a spool's tip opens over the composer. A pointer resting on a spool
// opens its tip (a mouse on a tablet, or a test's mouse left where it last pressed when the page turned to the phone
// layout); the composer taking focus closes it, so the tip never covers what is being typed.
import { journey, expect } from '../journey'
import { goTab } from '../fixtures'
import { askTab, debugOn, setPilot, setState, shotsDir, shotsOn } from './lib/session'

// the scripted replies (a provider with no key), on a page of this file's own
journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'anthropic' }, scheme: 'dark', themeFollowsSystem: false } })

journey.describe('the spool tips in the mimir chat on a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('a spool tip closes when the composer takes focus', async ({ page }, info) => {
    await debugOn(page)
    await goTab(page, 'prepare')
    await setPilot(page, 'scripted')
    const printer = await page.evaluate(() => (window as unknown as { __sx: { getState(): { printerId: string | null } } }).__sx.getState().printerId)
    try {
      await setState(page, { toast: null, plate: [], selection: null, selectedIds: [], printerId: 'bay-1' })
      await page.locator('[data-testid="phone-tabs"] [data-tab="mimir"]').click()
      const chat = page.getByTestId('mimir-chat')
      await expect(chat).toBeVisible()
      const again = chat.getByRole('button', { name: 'New conversation' })
      if (await again.isVisible()) await again.click()
      // a finished part brings up the spools under the run
      await askTab(page, 'Can you make a box with a lid?')
      await page.getByTestId('mimir-sheet-confirm').tap()
      await expect(page.getByTestId('mimir-transcript')).toContainText('Done: the box and its lid', { timeout: 30_000 })
      const pick = page.getByTestId('mimir-filament')
      await expect(pick).toBeVisible()
      const spool = pick.getByTestId('slice-filament-slot').last()
      await spool.scrollIntoViewIfNeeded()
      const id = (await spool.locator('.spool-id').textContent())!
      // nothing has focus, as after a reply comes in, so no focus leaves a control when the composer takes it
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const tip = page.locator('#sx-tip')
      await spool.hover()
      await expect(tip).toBeVisible()
      await expect(tip).toContainText(id)
      const composer = page.getByTestId('mimir-composer')
      if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/phone-spool-tip-open.png` })
      // the composer takes focus from code, with the pointer still resting on the spool
      const text = composer.getByRole('textbox')
      await text.focus()
      await expect(text).toBeFocused()
      await expect(tip).toHaveCount(0)
      // and it stays closed while the person types
      await text.pressSequentially('a lid')
      await expect(tip).toHaveCount(0)
      if (shotsOn()) await page.screenshot({ path: `${shotsDir(info)}/phone-spool-tip-focused.png` })
      await text.fill('')
    } finally {
      await setState(page, { printerId: printer })
    }
  })
})
