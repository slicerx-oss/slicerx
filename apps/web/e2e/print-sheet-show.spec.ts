// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Print sheet block with a place in the slice offers Show me: it closes the sheet and opens Slice's toolpaths at the
// first offending layer.
import { type Page } from '@playwright/test'
import { openStudio } from './cad-helpers'
import { expect, sliceCount, sliced, test } from './fixtures'

type Sx = { getState(): { layerHi: number; sliceLook: string; printSheet: unknown; preview: { layerCount: number } | null }; setState(p: unknown): void }
const sx = (page: Page) => page.evaluate.bind(page)

const TALL = 'The print is 300.0 mm tall; the P1S reaches 256 mm. Arrange it for this printer and slice again.'

/** Opens the Print sheet as a send to a P1S would, with the tall print's block and its spot at layer 3 (0 based). */
async function openSheet(page: Page, scheme: 'light' | 'dark' = 'dark'): Promise<void> {
  await page.evaluate(
    ({ tall, scheme }) => {
      const s = (window as unknown as { __sx: Sx }).__sx
      s.setState({
        scheme,
        themeFollowsSystem: false,
        printSheet: {
          printer: { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', host: '192.0.2.12', nozzleCount: 1 },
          status: null,
          plateName: 'Plate 1',
          specs: [],
          initial: {},
          name: 'x-mark',
          ending: '.gcode.3mf',
          filaments: [],
          slots: [],
          auto: {},
          stats: { timeS: 5400, grams: 24, layers: 300 },
          check: { errors: [tall, 'Bay 2 is busy (printing). Wait until it is idle.'], warnings: [], sha256: 'ab'.repeat(32), spots: { [tall]: { kind: 'layer', layer: 3 } } },
          bed: 'clear',
          resolve: () => undefined,
        },
      })
    },
    { tall: TALL, scheme },
  )
  await expect(page.getByRole('dialog')).toBeVisible()
}

test('Show me on a block closes the Print sheet and opens the toolpaths at its layer', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await openStudio(page, { settingsMode: 'simple' })
  const n = await sliceCount(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(sliced(page, n)).toBeVisible({ timeout: 120_000 })
  await openSheet(page)
  const shows = page.getByTestId('check-show')
  // Only the block with a place in the slice has it; the busy printer does not.
  await expect(shows).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('sheet-show-me.png') })
  await shows.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => sx(page)(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return `${s.sliceLook} ${s.layerHi}` })).toBe('toolpaths 4')
})

// Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
test('shots: Show me on the Print sheet, light and dark', async ({ page, isMobile }, info) => {
  test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
  test.slow()
  const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
  const width = page.viewportSize()?.width ?? 0
  await openStudio(page, { settingsMode: 'simple' })
  for (const scheme of ['light', 'dark'] as const) {
    await openSheet(page, scheme)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${dir}/sheet-show-me-${scheme}-${width}.png` })
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ printSheet: null }))
  }
  void isMobile
})
