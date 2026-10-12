// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A model file with several separate bodies asks whether to load one object with parts or separate objects;
// "Remember my choice" sets Settings > Slicing and modeling, so the next such file does not ask. A file of one body
// never asks.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FileChooser, type Page } from '@playwright/test'
import { expect, plateReady, test, viewportReady } from './fixtures'

/** A binary STL of 20 mm cubes 50 mm apart, one per offset: one file, a body per cube. */
function cubes(name: string, count: number): string {
  const tris: number[][] = []
  for (let c = 0; c < count; c++) {
    const v = (x: number, y: number, z: number) => [c * 50 + x * 20, y * 20, z * 20]
    const quad = (a: number[], b: number[], d: number[], e: number[]) => tris.push([...a, ...b, ...d], [...a, ...d, ...e])
    quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0))
    quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1))
    quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1))
    quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0))
    quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0))
    quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1))
  }
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.forEach((n, k) => buf.writeFloatLE(n, 84 + i * 50 + 12 + k * 4)))
  const file = join(mkdtempSync(join(tmpdir(), 'sx-bodies-')), name)
  writeFileSync(file, buf)
  return file
}

type Sx = { getState(): { plateLoading: boolean; multiBodyImport: string; multiBodyPrompt: unknown; plate: { parts: unknown[] }[] } }
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: Sx }).__sx.getState()
    return { loading: s.plateLoading, asking: s.multiBodyPrompt !== null, pref: s.multiBodyImport, objects: s.plate.length, parts: s.plate.map((p) => p.parts.length) }
  })

async function start(page: Page, prefs: Record<string, unknown> = {}): Promise<FileChooser[]> {
  const seen: FileChooser[] = []
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript((extra) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, autoSlice: false, ...extra }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  return seen
}

/** Opens a file through Open (Ctrl+O), as a person does; Open starts a new project. */
async function open(page: Page, seen: FileChooser[], file: string): Promise<void> {
  const before = seen.length
  for (let i = 0; i < 10 && seen.length === before; i++) {
    await page.keyboard.press('ControlOrMeta+o')
    await page.waitForTimeout(500)
  }
  await seen[before]!.setFiles(file)
}

const settled = (page: Page) => expect.poll(async () => { const s = await state(page); return !s.loading && !s.asking }, { timeout: 60_000 }).toBe(true)

test('a file of three bodies asks, and One object loads one object with three parts', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  const seen = await start(page)
  await open(page, seen, cubes('three-cubes.stl', 3))
  const dialog = page.getByTestId('multi-body-dialog')
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog).toContainText('holds 3 separate bodies')
  // Nothing goes on the plate before the answer.
  expect((await state(page)).objects).toBe(0)
  await page.getByTestId('multi-body-parts').click()
  await settled(page)
  expect(await state(page)).toMatchObject({ objects: 1, parts: [3], pref: 'ask' })
})

test('Separate objects with Remember my choice sets the setting, and the next file does not ask', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  const seen = await start(page)
  await open(page, seen, cubes('two-cubes.stl', 2))
  const dialog = page.getByTestId('multi-body-dialog')
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  // The box does not move the answers when it is ticked.
  const before = await page.getByTestId('multi-body-objects').boundingBox()
  await page.getByTestId('multi-body-remember').check()
  expect(await page.getByTestId('multi-body-objects').boundingBox()).toEqual(before)
  await page.getByTestId('multi-body-objects').click()
  await settled(page)
  expect(await state(page)).toMatchObject({ objects: 2, parts: [1, 1], pref: 'objects' })

  // The next file of several bodies follows the remembered choice.
  await open(page, seen, cubes('four-cubes.stl', 4))
  // Open starts a new project: the first one was never saved, so it asks first.
  const discard = page.getByTestId('unsaved-discard')
  if (await discard.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) await discard.click()
  await expect.poll(async () => (await state(page)).objects, { timeout: 60_000 }).toBe(4)
  await settled(page)
  await expect(dialog).toHaveCount(0)
})

for (const how of ['the close button', 'Escape'] as const) {
  test(`closing the question with ${how} loads the automatic grouping and remembers nothing`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop open')
    const seen = await start(page)
    await open(page, seen, cubes('three-cubes.stl', 3))
    const dialog = page.getByTestId('multi-body-dialog')
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    // Even with the box ticked, closing is not an answer to remember.
    await page.getByTestId('multi-body-remember').check()
    if (how === 'Escape') await page.keyboard.press('Escape')
    else await dialog.getByTestId('dialog-close').click()
    await settled(page)
    // Cubes apart are separate objects in the automatic grouping.
    expect(await state(page)).toMatchObject({ objects: 3, parts: [1, 1, 1], pref: 'ask' })
    await expect(dialog).toHaveCount(0)
  })
}

test('a file of one body never asks', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  const seen = await start(page)
  await open(page, seen, cubes('one-cube.stl', 1))
  await settled(page)
  expect(await state(page)).toMatchObject({ objects: 1, parts: [1], asking: false })
  await expect(page.getByTestId('multi-body-dialog')).toHaveCount(0)
})
