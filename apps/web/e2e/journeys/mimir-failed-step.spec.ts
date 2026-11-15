// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that fails in the mimir tab reads in plain words in the working loop's list. The scripted "failed block step"
// (the e2e build only) starts a block and sends the fillet step with no edges and no radius, which its tool turns down
// on its arguments, in words with the field keys. The list shows the catch-all sentence for that step, and
// nothing on the page carries a field key, a tool's name or a command line. The opened list is saved as a picture.
// The same step and line run on the real tools in packages/app/test/mimir-failed-block-step.test.ts.
import { journey, expect } from '../journey'
import { askTab, debugOn, emptyMimirTab, setPilot, shotsDir } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'anthropic' }, scheme: 'dark', themeFollowsSystem: false } })
journey.skip(({ isMobile }) => isMobile, 'Desktop. The phone chat has its own rows (editions/slicerx/apps/mobile)')

const NOT_MADE = 'That step could not be made, so the part is unchanged. Try asking for it another way.'

journey.describe('a failed step in the mimir tab', () => {
  journey("the working loop's list shows the catch-all sentence, with no field key, tool name or command line on the page", async ({ page }, info) => {
    await debugOn(page)
    await setPilot(page, 'scripted')
    await emptyMimirTab(page)
    await askTab(page, 'Run a failed block step')
    const transcript = page.getByTestId('mimir-transcript')
    await expect(transcript).toContainText('That step did not go through, so the block is unchanged.', { timeout: 30_000 })
    // each line mimir says starts a working loop of its own: the block's start, then the rounding step that failed
    await expect(page.getByTestId('mimir-loop')).toHaveCount(2)
    const loop = page.locator('[data-testid="mimir-loop"][data-failed]')
    await expect(loop).toHaveCount(1)
    // the loop folds to one line when its work is done; opening it lists the steps
    await loop.getByTestId('mimir-loop-line').click()
    const failed = loop.locator('.wl-sub li.failed')
    await expect(failed).toHaveCount(1)
    await expect(failed.locator('.wl-why')).toHaveText(NOT_MADE)
    await loop.scrollIntoViewIfNeeded()
    await loop.screenshot({ path: `${shotsDir(info)}/workloop-failed-step-after.png` })
    const text = (await transcript.innerText()).replace(/\s+/g, ' ')
    expect(text).not.toMatch(/\b[a-z_]+: /)
    expect(text).not.toMatch(/\b(?:geom|design|app|parts)(?:\.|__)[a-z_]+/)
    expect(text).not.toContain('$ ')
    expect(text).not.toContain('radius_mm')
  })
})
