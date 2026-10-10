// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-run setup on a fresh install: the theme, the printer scan, the slicer question, what the plate opens in, then
// setting up mimir. Also setup opening again for a profile from an earlier onboarding.
import { type Page } from '@playwright/test'
import { expect, expectTabLabel, test } from './fixtures'

async function fresh(page: Page): Promise<void> {
  // A fresh install: nothing stored, so setup opens by itself on the theme.
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  // Five steps: the theme, the printer, the slicer you use now, what the plate tab opens in, and mimir (until mimir is turned on or off).
  await expect(page.locator('#fr-step-label')).toHaveText('Step 1 of 5')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Find your printer' })).toBeVisible()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 2 of 5')
}

async function noHorizontalScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

test('the scan finds the printer, the connection tests itself, then the slicer question', async ({ page }) => {
  await fresh(page)
  await noHorizontalScroll(page)

  // Nothing is searched until asked; then the scan lists what the demo network announces, with what each printer reported.
  await expect(page.getByRole('radiogroup', { name: 'Printers found' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Search my network' }).click()
  const found = page.getByRole('radiogroup', { name: 'Printers found' }).getByRole('radio')
  await expect(found).toHaveCount(6)
  const x1 = found.filter({ hasText: 'X1 Carbon' })
  await expect(x1).toContainText('AMS')
  await expect(x1).toContainText('192.0.2.11')
  await x1.click()
  await expect(x1).toHaveAttribute('aria-checked', 'true')

  // Bambu LAN asks for the serial number and the access code; the test starts once both are in.
  await page.getByRole('textbox', { name: /Serial number/ }).fill('01S00A987654321')
  const code = page.getByRole('textbox', { name: /Access code/ })
  await code.fill('12345678')
  // The access code is read off a screen, not a password: shown as typed.
  await expect(code).toHaveAttribute('type', 'text')
  await expect(page.locator('.fr-found-ok')).toContainText('Found it.')
  await expect(page.locator('.fr-test .fr-ok')).toContainText('Connected')
  // A test past 1.2 s lands the ravens on a trail of three rows instead of the list of four steps (a slower runner
  // gets the trail): either way, every row passed.
  const rows = page.locator('.fr-checks li, .fr-trail li')
  await expect(rows.first()).toBeVisible()
  await expect(rows).toHaveCount((await page.locator('.fr-trail').count()) > 0 ? 3 : 4)
  await expect(page.locator('.fr-checks li:not([data-state="ok"]), .fr-trail li:not([data-state="ok"])')).toHaveCount(0)
  await expect(page.locator('.fr-read')).toContainText('X1 Carbon')
  await expect(page.locator('.fr-read')).toContainText('AMS')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Continue' }).click()

  // Which slicer: four cards, "something else" preselected, the pick applied live.
  await expect(page.locator('#fr-step-label')).toHaveText('Step 3 of 5')
  await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
  const cards = page.getByRole('radiogroup', { name: 'Slicer you use now' }).getByRole('radio')
  await expect(cards).toHaveCount(4)
  await expect(cards.nth(0)).toContainText('Bambu Studio')
  await expect(cards.nth(1)).toContainText('OrcaSlicer')
  await expect(cards.nth(2)).toContainText('PrusaSlicer')
  await expect(cards.nth(3)).toHaveAttribute('aria-checked', 'true')
  await cards.nth(0).click()
  await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'bambu-studio')
  await expect(page.getByText('Bring your Bambu Studio presets')).toBeVisible()
  await expect(page.getByText('SlicerX is not affiliated with them.', { exact: false })).toBeVisible()
  // Arrow keys move the selection.
  await cards.nth(0).press('ArrowDown')
  await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true')
  await cards.nth(1).press('ArrowUp')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'bambu-studio')
  // The settings mode, prefilled: a fresh install starts in Simple.
  await expect(page.getByTestId('setup-mode-simple')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Change it any time from the chip at the top of the Slice sidebar.')).toBeVisible()
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()

  // Then what the plate tab opens in: Slicing stays chosen.
  await expect(page.locator('#fr-step-label')).toHaveText('Step 4 of 5')
  await expect(page.getByRole('heading', { name: /What do you want .* to open in\?/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Slicing/ })).toHaveAttribute('aria-checked', 'true')
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()

  // Then mimir: setting it up is offered, and the plate opens from there.
  await expect(page.locator('#fr-step-label')).toHaveText('Step 5 of 5')
  await expect(page.getByRole('heading', { name: 'Set up mimir' })).toBeVisible()
  await noHorizontalScroll(page)
  await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)

  // The Bambu style names the Printers workspace Device and keeps the choice and the printer.
  await expectTabLabel(page, 'printers', 'Device')
  const stored = await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1') ?? '')
  const prefs = JSON.parse(stored) as { lookAndFeel: { id: string }; firstRun: { completedAt: string | null; printerId: string | null } }
  expect(prefs.lookAndFeel.id).toBe('bambu-studio')
  expect(prefs.firstRun.completedAt).not.toBeNull()
  expect(prefs.firstRun.printerId).toBe('bay-1')
  // The access code never lands in storage.
  const all = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'))
  expect(all).not.toContain('12345678')

  await page.reload()
  await expectTabLabel(page, 'printers', 'Device')
  await expect(page.getByRole('heading', { name: 'Find your printer' })).toHaveCount(0)
})

test('adding by hand: a failed test names the step and cause, and setup can continue without it', async ({ page }) => {
  await fresh(page)
  await page.getByRole('button', { name: 'Not listed? Add it by hand' }).click()
  await expect(page.getByRole('heading', { name: 'Add your printer' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search brand or model' }).fill('voron 2.4')
  await page.locator('.fr-hits .fr-hit').first().click()
  await expect(page.getByRole('radio', { name: /Moonraker/ })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('textbox', { name: /IP address/ }).fill('192.0.2.77')
  await page.getByRole('button', { name: 'Test connection' }).first().click()
  await expect(page.locator('.fr-test-bad-h')).toContainText('No answer from 192.0.2.77.')
  await expect(page.locator('.fr-foot').getByRole('button', { name: 'Test again' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue without testing' }).click()
  await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
})

test('Escape asks before leaving, and Settings brings the slicer screen back', async ({ page }) => {
  await fresh(page)
  await page.keyboard.press('Escape')
  const dialog = page.getByRole('dialog', { name: 'Leave setup?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('You can finish it later from Settings.')
  await dialog.getByRole('button', { name: 'Stay' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 2 of 5')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Leave setup?' }).getByRole('button', { name: 'Leave' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('change look and feel')
  await page.keyboard.press('Enter')
  await expect(page.locator('#fr-step-label')).toHaveText('Step 3 of 5')
})

test('the theme step: every theme as a card, the mode and flavors apply at once and stay after a reload', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  const cards = page.getByRole('radiogroup', { name: 'Theme' }).locator('.th-card')
  await expect(cards).toHaveCount(13)
  await expect(page.getByTestId('theme-subban')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-dark')
  await noHorizontalScroll(page)

  // Catppuccin: one card, the dark flavor picked inside it, Latte as its light mode.
  await page.getByTestId('theme-catppuccin').click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'catppuccin-mocha')
  await page.getByRole('radiogroup', { name: 'Dark flavor' }).getByRole('radio', { name: 'Frappe' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'catppuccin-frappe')
  await page.getByRole('radiogroup', { name: 'Theme mode' }).getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'catppuccin-latte')

  // Subban light is the Nocturne Bright palette.
  await page.getByTestId('theme-subban').click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-light')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink-0').trim())).toBe('#fbf8ff')

  // The quick reading options apply at once.
  const easy = page.getByRole('region', { name: 'Easier to read' })
  await easy.getByRole('radio', { name: 'Larger' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'larger')
  await easy.getByRole('radio', { name: 'Red-green' }).click()
  await noHorizontalScroll(page)

  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-light')
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'larger')
  const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as { themeIds: { dark: string; light: string }; appearance: { colorVision: string }; firstRun: { version: number } }
  expect(prefs.themeIds).toEqual({ dark: 'subban-dark', light: 'subban-light' })
  expect(prefs.appearance.colorVision).toBe('redgreen')
  expect(prefs.firstRun.version).toBe(4)
})

test('Settings, Look and feel: theme, accent, text and accessibility; Slicing and modeling holds auto slice', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('slicerx.prefs.v1')) localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
  await nav.getByRole('button', { name: 'Look and feel' }).click()
  await dialog.getByTestId('theme-nord').click()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'nord')
  await dialog.getByRole('radiogroup', { name: 'Contrast' }).getByRole('radio', { name: 'Higher' }).click()
  await dialog.getByRole('radiogroup', { name: 'Color vision' }).getByRole('radio', { name: 'Blue-yellow' }).click()
  await dialog.getByRole('radiogroup', { name: 'Text size' }).getByRole('radio', { name: 'Large', exact: true }).click()
  await dialog.getByRole('radiogroup', { name: 'Font weight' }).getByRole('radio', { name: 'Medium' }).click()
  await dialog.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Green' }).click()
  await dialog.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Roomy' }).click()
  const root = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return { scale: cs.getPropertyValue('--text-scale').trim(), weight: cs.getPropertyValue('--fw-regular').trim(), accentIsGreen: cs.getPropertyValue('--accent').trim() === cs.getPropertyValue('--green').trim(), density: document.documentElement.dataset['density'], contrast: cs.getPropertyValue('--line').trim() }
  })
  expect(root).toMatchObject({ scale: '1.14', weight: '500', accentIsGreen: true, density: 'roomy' })
  // Higher contrast draws Nord's borders stronger than the file's #4c566a.
  expect(root.contrast).not.toBe('#4c566a')
  await expect(dialog.getByText('Body text at 16 px.', { exact: false })).toBeVisible()
  await noHorizontalScroll(page)
  // Auto slice, the electricity price and the drawing tools moved to their own page.
  await expect(dialog.getByRole('radiogroup', { name: 'Auto slice' })).toHaveCount(0)
  await nav.getByRole('button', { name: 'Slicing and modeling' }).click()
  await expect(dialog.getByRole('radiogroup', { name: 'Auto slice' })).toBeVisible()
  await expect(dialog.getByText('Drawing tools')).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'nord')
})

test('a profile from an earlier onboarding goes through setup again, prefilled, and keeps everything', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('sx-e2e-seeded')) return
    localStorage.setItem('sx-e2e-seeded', '1')
    // As 0.2.2 left it: setup finished with no version, the old SlicerX theme ids, the Bambu look, a printer, slicing on open.
    localStorage.setItem(
      'slicerx.prefs.v1',
      JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', scheme: 'dark', themeIds: { dark: 'slicerx-dark', light: 'slicerx-light' }, lookAndFeel: { id: 'bambu-studio' }, toolpathPalette: 'colorblind', modelModeDefault: 'slice', settingsMode: 'advanced', autoSlice: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'bambu-studio' }, printerId: 'bay-1' } }),
    )
  })
  await page.goto('./')
  // Pre-alpha: everyone runs it again, from the theme, with their choices filled in.
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  await expect(page.locator('#fr-step-label')).toHaveText(/^Step 1 of \d$/)
  await expect(page.getByTestId('theme-subban')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-dark')
  await expect(page.getByRole('region', { name: 'Easier to read' }).getByRole('radio', { name: 'Red-green' })).toHaveAttribute('aria-checked', 'true')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  // The printer they have is kept with one click.
  await expect(page.getByRole('heading', { name: 'Your printer' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Your printers' }).locator('li').first()).toContainText('Slices for this one')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('radiogroup', { name: 'Slicer you use now' }).getByRole('radio', { name: /Bambu Studio/ })).toHaveAttribute('aria-checked', 'true')
  // The settings mode question is new in this onboarding, prefilled with the mode they use.
  await expect(page.getByTestId('setup-mode-advanced')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('setup-mode-expert').click()
  await expect(page.getByTestId('setup-mode-expert')).toHaveAttribute('aria-checked', 'true')
  // So is the auto slice question: their saved on reads as Auto, the new default.
  await expect(page.getByTestId('setup-autoslice-auto')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('setup-autoslice-always').click()
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as Record<string, unknown>
  expect(prefs).toMatchObject({ printerId: 'bay-1', lookAndFeel: { id: 'bambu-studio' }, themeIds: { dark: 'subban-dark', light: 'subban-light' }, appearance: { colorVision: 'redgreen' }, settingsMode: 'expert', autoSlice: true, autoSliceBySize: false, firstRun: { version: 4, printerId: 'bay-1' } })
  // Once through, it does not come back.
  await page.reload()
  await expect(page.locator('.fr')).toHaveCount(0)
})

test('a profile that finished the version 2 onboarding goes through setup again for the settings mode question', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('sx-e2e-seeded')) return
    localStorage.setItem('sx-e2e-seeded', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'simple', firstRun: { completedAt: '2026-10-07T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: 'bay-1', version: 2 } }))
  })
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
  await expect(page.getByTestId('setup-mode-simple')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('setup-mode-advanced').click()
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await expect(page.getByTestId('slice-mode-chip')).toHaveText('Advanced')
  await page.reload()
  await expect(page.locator('.fr')).toHaveCount(0)
})

test('Skip, use defaults closes setup; mimir shows and opens the connect step until a model is connected', async ({ page }) => {
  await fresh(page)
  await page.getByRole('button', { name: 'Skip, use defaults' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await page.locator('.mimir-btn').click()
  await expect(page.locator('.mimir-connect')).toContainText('Nothing is sent until you connect')
  await expect(page.locator('.mimir-connect').getByRole('radiogroup', { name: 'Model provider' })).toBeVisible()
  await page.locator('.mimir-btn').click()
  await expect(page.locator('.mimir-dock')).toHaveCount(0)
  // A question offers mimir, and choosing it opens the same step with the question waiting.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('why is my first layer rough')
  await page.locator('.sx-palette-item', { hasText: 'Ask mimir: why is my first layer rough' }).click()
  await expect(page.locator('.mimir-connect')).toContainText('why is my first layer rough')
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('connect mimir')
  await page.locator('.sx-palette-item', { hasText: 'Connect mimir' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'mimir' })).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: 'Model provider' })).toBeVisible()
})

test('choosing CAD model opens the plate in Model, now and on the next launch, and Settings changes it', async ({ page }) => {
  await fresh(page)
  // Straight to the open step: no printer, the slicer as it is.
  await page.getByRole('button', { name: 'I do not have a printer yet' }).first().click()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 3 of 5')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await expect(page.locator('#fr-step-label')).toHaveText('Step 4 of 5')
  const cad = page.getByRole('radio', { name: /^CAD model/ })
  await cad.click()
  await expect(cad).toHaveAttribute('aria-checked', 'true')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
  await expect(page.locator('.fr')).toHaveCount(0)
  await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
  // Settings > Look and feel changes the default; the session stays where it is.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
  const row = page.getByRole('radiogroup', { name: 'Open models in' })
  await expect(row.getByRole('radio', { name: 'Model' })).toHaveAttribute('aria-checked', 'true')
  await row.getByRole('radio', { name: 'Slicing' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await expect(page.locator('.sx-tab[data-mode="slice"]')).toHaveAttribute('aria-current', 'page')
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: the settings mode question in the slicer step, light and dark', async ({ page }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
  await page.addInitScript(() => {
    if (localStorage.getItem('sx-e2e-seeded')) return
    localStorage.setItem('sx-e2e-seeded', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'advanced', firstRun: { completedAt: '2026-10-07T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: 'bay-1', version: 2 } }))
  })
  await page.goto('./')
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
  const question = page.getByRole('group', { name: 'Settings mode' })
  await expect(question).toBeVisible()
  for (const scheme of ['light', 'dark'] as const) {
    await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
    await question.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/setup-mode-${scheme}-${width}.png` })
  }
})
