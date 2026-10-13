// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A SlicerX project with its own start G-code, opened on the person's A1 mini: the slice they start asks first, in one
// plain line, with what the project changes folded under Show differences until they open it. The printer's G-code is
// the default. The project is made here: a cube and a start G-code with an M500 in it.
import { expect, type Page } from '@playwright/test'
import { plateReady, sliceCount, sliced, test } from './fixtures'
import { projectZip } from './project-zip'

const START = 'G28\nM500 ; keep my offsets\nG1 Z5 F3000\n'
const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

async function open(page: Page): Promise<void> {
  await page.addInitScript((a1) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    // The store as window.__sx, for the screenshots' theme switch.
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [a1], printerId: a1.id }))
  }, A1_MINI)
  await page.goto('./')
  await plateReady(page)
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('A1 mini')
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles({ name: 'bracket.sx3mf', mimeType: 'model/3mf', buffer: projectZip({ machine_start_gcode: START }, {}, [90, 90]) })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
}

test("a project's own G-code asks in one line, with the differences folded until opened", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  const before = await sliceCount(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  const dialog = page.getByTestId('project-gcode-dialog')
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText("This project's G-code doesn't match your printer")
  await expect(dialog.locator('.pg-lede')).toHaveText("bracket.sx3mf has its own printer G-code, different from the Bambu Lab A1 mini profile's.")
  await expect(page.getByTestId('project-gcode-use-profile')).toHaveText("Use the printer's G-code")
  await expect(page.getByTestId('project-gcode-use-profile')).toBeFocused()
  await expect(page.getByTestId('project-gcode-use-project')).toHaveText("Use the project's G-code")
  await expect(page.getByTestId('project-gcode-use-project')).toBeEnabled()
  // Folded by default: no per-script counts, flagged lines or diff rows until the person asks.
  const toggle = dialog.getByRole('button', { name: 'Show differences' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog.locator('.pg-change')).toHaveCount(0)
  await expect(dialog).not.toContainText('lines added')
  await shots(page, 'collapsed')
  const at = await toggle.boundingBox()
  await toggle.click()
  const hide = dialog.getByRole('button', { name: 'Hide differences' })
  await expect(hide).toHaveAttribute('aria-expanded', 'true')
  const start = dialog.getByRole('region', { name: 'Hide differences' }).locator('.pg-change', { hasText: 'Start G-code' })
  await expect(start).toBeVisible()
  await expect(start.locator('.pg-flags')).toContainText("M500 writes settings to the printer's memory")
  await expect(start.locator('.pg-row[data-kind="added"]', { hasText: 'M500 ; keep my offsets' })).toBeVisible()
  // The control stays where it was when the list opens below it.
  expect((await hide.boundingBox())?.y).toBe(at?.y)
  await shots(page, 'expanded')
  await page.getByTestId('project-gcode-use-profile').click()
  await expect(dialog).toBeHidden()
  await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
})

/**
 * Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default). The dialog at 1440 and
 * 390 px wide, dark and light; the viewport and theme are put back after.
 */
async function shots(page: Page, name: string): Promise<void> {
  if (!process.env['SX_SHOTS']) return
  const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath('shots')
  const before = page.viewportSize()
  type Sx = { __sx: { getState(): { scheme: string; themeFollowsSystem: boolean }; setState(p: unknown): void } }
  const theme = await page.evaluate(() => {
    const st = (window as unknown as Sx).__sx.getState()
    return { scheme: st.scheme, themeFollowsSystem: st.themeFollowsSystem }
  })
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height })
    for (const scheme of ['dark', 'light'] as const) {
      await page.evaluate((s) => (window as unknown as Sx).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${dir}/project-gcode-${name}-${scheme}-${width}.png` })
    }
  }
  if (before) await page.setViewportSize(before)
  await page.evaluate((t) => (window as unknown as Sx).__sx.setState(t), theme)
}
