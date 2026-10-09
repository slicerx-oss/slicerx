// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model draws its parts in the CAD look, a neutral gray with dark feature edges; Slice keeps the filament look.
// SX_SHOTS=1 also saves the look at 1440 in light and dark on the x-mark and the shelf bracket.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FileChooser, type Page } from '@playwright/test'
import { expect, plateReady, pnpmSync, test, viewportReady } from './fixtures'

type Part = { edges: { visible: boolean }; mesh: { material: { color: { getHexString(): string } } } }
type Vp = { renderMode: string; objects: Map<string, { parts: Part[] }> }

const root = join(import.meta.dirname, '..', '..', '..')
let starters = ''
test.beforeAll(() => {
  starters = mkdtempSync(join(tmpdir(), 'sx-starters-'))
  pnpmSync(['--filter', '@slicerx/store', 'exec', 'tsx', '../app/scripts/vault-starters.ts', starters], root)
})

// Every file dialog the page opened, listened for from the start: waiting only around the key press can miss one.
const choosers = new WeakMap<Page, FileChooser[]>()

async function open(page: Page, file: string, scheme: 'light' | 'dark' = 'dark'): Promise<void> {
  if (!choosers.has(page)) {
    const seen: FileChooser[] = []
    choosers.set(page, seen)
    page.on('filechooser', (c) => seen.push(c))
  }
  await page.addInitScript((scheme) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, scheme, themeFollowsSystem: false }))
  }, scheme)
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  const seen = choosers.get(page)!
  const before = seen.length
  await page.keyboard.press('ControlOrMeta+o')
  await expect.poll(() => seen.length, { timeout: 60_000 }).toBe(before + 1)
  await seen[before]!.setFiles(join(starters, file))
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.objects.size)).toBeGreaterThan(0)
}

const look = (page: Page) =>
  page.evaluate(() => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const parts = [...vp.objects.values()].flatMap((o) => o.parts)
    return { mode: vp.renderMode, edges: parts.every((p) => p.edges.visible), colors: [...new Set(parts.map((p) => p.mesh.material.color.getHexString()))] }
  })

test.describe('Model CAD look', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop look')

  test('Model draws one gray with its edges, and Slice its filament colors', async ({ page }) => {
    await open(page, 'x-mark.sx3mf')
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect.poll(async () => (await look(page)).mode).toBe('cad')
    const model = await look(page)
    expect(model.edges).toBe(true)
    expect(model.colors).toHaveLength(1)
    await page.locator('.sx-tab[data-mode="slice"]').click()
    await expect.poll(async () => (await look(page)).mode).not.toBe('cad')
    expect((await look(page)).colors).not.toEqual(model.colors)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`shots: the CAD look in ${scheme}`, async ({ page }, info) => {
      test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
      const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
      for (const file of ['x-mark.sx3mf', 'shelf-bracket.sx3mf']) {
        await open(page, file, scheme)
        await page.locator('.sx-tab[data-mode="design"]').click()
        await expect.poll(async () => (await look(page)).mode).toBe('cad')
        // Nothing selected, framed close, so the gray and its edges are what shows.
        await page.evaluate(() => {
          const w = window as unknown as { __sx: { setState(p: unknown): void }; __vp: { view(v: string, o?: unknown): void } }
          w.__sx.setState({ selection: null, selectedIds: [] })
          w.__vp.view('fit')
        })
        await page.waitForTimeout(1500)
        await page.screenshot({ path: join(dir, `${file.replace('.sx3mf', '')}-model-${scheme}.png`) })
        await page.locator('.sx-tab[data-mode="slice"]').click()
        await page.waitForTimeout(1500)
        await page.screenshot({ path: join(dir, `${file.replace('.sx3mf', '')}-slice-${scheme}.png`) })
      }
    })
  }
})
