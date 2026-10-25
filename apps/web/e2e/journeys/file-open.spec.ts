// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Files opened and dropped on the plate, on one page: a model of several bodies asks how to load them, a model the
// engine splits keeps its pieces in place, a design opened over a slicing plate loads at once, and a dropped STEP
// becomes named objects. The other multi-body answers (remember, close, one body) are tested in
// packages/app/test/multi-body.test.ts. Each step opens its own file and answers "Save changes first?" if the step
// before left the project edited.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { openTransform } from '../fixtures'
import { expect, journey as test } from '../journey'
import { cubes, dropFile, openFile, openModel, setState, settleOpen, useFileDialogs, useFlags, useSliceTab, useStarters, useTempDir } from './lib/model'

test.skip(({ isMobile }) => isMobile, 'Desktop open')
useFlags()
useSliceTab()
useFileDialogs()
const starters = useStarters()
const tmp = useTempDir('sx-bodies-')

type Sx = {
  getState(): {
    plateLoading: boolean
    multiBodyImport: string
    multiBodyPrompt: unknown
    overrides: Record<string, unknown>
    plate: { id: string; name: string; parts: { name: string; positions: ArrayLike<number> }[]; transform: number[] }[]
    slice: { status: string; stale?: boolean; result?: { id: string; layerZ: ArrayLike<number> } }
    toast: { text: string } | null
    openNote: { text: string } | null
  }
  setState(p: unknown): void
}
const store = (page: Page) => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState())

// A model file with several separate bodies asks whether to load one object with parts or separate objects.
test('a file of three bodies asks, and One object loads one object with three parts', async ({ page }) => {
  await setState(page, { multiBodyImport: 'ask' })
  await openFile(page, cubes(tmp(), 'three-cubes.stl', 3))
  const dialog = page.getByTestId('multi-body-dialog')
  await settleOpen(page, () => dialog.isVisible())
  await expect(dialog).toContainText('holds 3 separate bodies')
  // Nothing goes on the plate before the answer.
  expect((await store(page)).plate.length).toBe(0)
  await page.getByTestId('multi-body-parts').click()
  await expect.poll(async () => { const s = await store(page); return !s.plateLoading && s.multiBodyPrompt === null }, { timeout: 60_000 }).toBe(true)
  const s = await store(page)
  expect({ objects: s.plate.length, parts: s.plate.map((p) => p.parts.length), pref: s.multiBodyImport }).toEqual({ objects: 1, parts: [3], pref: 'ask' })
})

// Opening one model the engine splits into loose bodies: the pieces keep the places they had as one model, so nothing
// on the plate moves after it first shows (no arrange, no second arrange), and the slice that follows starts after.
test('a model split into two bodies keeps its pieces in place: nothing moves after it first shows', async ({ page }) => {
  // separate objects, as the engine groups bodies that do not touch, so the open does not stop to ask
  await setState(page, { multiBodyImport: 'objects' })
  try {
    const previous = (await store(page)).plate.map((e) => e.id)
    await openFile(page, cubes(tmp(), 'two-cubes.stl', 2))
    // Sample the opened model from its first appearance; file selection can return before the old example clears.
    const samples: { loading: boolean; count: number; spans: [number, number][] }[] = []
    for (let i = 0; i < 300; i++) {
      // The project was edited by the step before, so the open may ask first.
      const discard = page.getByTestId('unsaved-discard')
      if (await discard.isVisible()) await discard.click()
      const s = await page.evaluate((previous) => {
        const st = (window as unknown as { __sx: Sx }).__sx.getState()
        const spans = st.plate.filter((e) => !previous.includes(e.id)).map((e) => {
          let lo = Infinity
          let hi = -Infinity
          for (const p of e.parts) for (let k = 0; k + 2 < p.positions.length; k += 3) {
            const x = e.transform[0]! * p.positions[k]! + e.transform[4]! * p.positions[k + 1]! + e.transform[8]! * p.positions[k + 2]! + e.transform[12]!
            lo = Math.min(lo, x)
            hi = Math.max(hi, x)
          }
          return [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100] as [number, number]
        })
        return { loading: st.plateLoading, count: st.plate.length, spans: spans.sort((a, b) => a[0] - b[0]) }
      }, previous)
      if (s.spans.length) samples.push(s)
      if (!s.loading && s.count === 2 && s.spans.length === 2) break
      await page.waitForTimeout(100)
    }
    expect(samples.length).toBeGreaterThan(0)
    const last = samples.at(-1)!
    expect(last.loading).toBe(false)
    expect(last.count).toBe(2)
    expect(last.spans).toHaveLength(2)
    // the pieces are 30 mm apart, as in the file
    expect(last.spans[1]![0] - last.spans[0]![1]).toBeCloseTo(30, 1)
    // from the first frame with the model to the end, the model's overall span never changes
    const outer = (sp: [number, number][]) => [Math.min(...sp.map((x) => x[0])), Math.max(...sp.map((x) => x[1]))]
    for (const s of samples) expect(outer(s.spans)).toEqual(outer(last.spans))
  } finally {
    await setState(page, { multiBodyImport: 'ask' })
  }
})

// Opening a design over a plate that is still slicing: the slice is for a plate that is gone, so it stops, and the new
// design loads at once instead of waiting for the slicer to finish the old plate.
test('a design opened over a plate that is slicing loads at once, and the old slice stops', async ({ page }) => {
  test.slow()
  const status = async () => (await store(page)).slice.status
  const was = (await store(page)).overrides
  try {
    await openModel(page, join(starters(), 'calibration-cube-20mm.sx3mf'))
    await expect(page.locator('.obj-name')).toHaveText(['20 mm calibration cube'], { timeout: 60_000 })
    // An edit, so opening asks about unsaved work, a bed full of cubes and very thin solid layers, so the slice runs
    // well past the open.
    await openTransform(page)
    await page.getByRole('button', { name: 'Fill bed' }).click()
    await expect.poll(() => page.locator('.objs > li').count()).toBeGreaterThan(4)
    await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
    await page.keyboard.press('Escape')
    await setState(page, { overrides: { layer_height: '0.04', sparse_infill_density: '100%' } })
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect.poll(status).toBe('running')
    await openFile(page, join(starters(), 'cable-clip.sx3mf'))
    const ask = page.getByRole('dialog').getByRole('button', { name: "Don't save" })
    await expect(ask).toBeVisible()
    // The slice must still be running here, or the step proves nothing about stopping it.
    expect(await status()).toBe('running')
    await ask.click()
    const asked = Date.now()
    await expect(page.locator('.obj-name')).toHaveText(['Cable clip'], { timeout: 60_000 })
    const ms = Date.now() - asked
    console.log(`open-while-slicing: the clip loaded ${ms} ms after Don't save`)
    expect(ms).toBeLessThan(5_000)
    // The old plate's slice never lands on the new one.
    await page.waitForTimeout(3000)
    expect(await status()).toBe('idle')
    // The slicer is free for the new design, and what it shows is the clip (8 mm tall), not the old 20 mm cube.
    await setState(page, { overrides: was })
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect.poll(status, { timeout: 120_000 }).toBe('done')
    const top = await page.evaluate(() => { const z = (window as unknown as { __sx: Sx }).__sx.getState().slice.result!.layerZ; return z[z.length - 1] })
    expect(top).toBeLessThan(10)
  } finally {
    await setState(page, { overrides: was })
  }
})

// STEP import: a dropped .step file is meshed in its own worker, repaired by the geometry engine, added
// as objects with the names from the file, and slices.
test('a dropped STEP assembly becomes named objects and slices', async ({ page }) => {
  test.slow()
  const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'app', 'test', 'fixtures', 'step')
  const drop = (name: string) => dropFile(page, name, readFileSync(join(fixtures, name)), 'application/step')
  await setState(page, { plate: [], selection: null, selectedIds: [], toast: null, openNote: null })

  await drop('assembly.step')
  await expect(page.locator('.obj-name', { hasText: 'assembly' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.obj-name', { hasText: 'cube' })).toBeVisible()
  const plate = (await store(page)).plate
  expect(plate.find((p) => p.name === 'assembly')?.parts.map((p) => p.name)).toEqual(['assembly base', 'assembly post'])
  // The open ends with the note under the printer card that says what the file became. The next file is dropped after
  // that, so the last note is its own and not one still on its way from this file.
  await expect.poll(async () => { const s = await store(page); return s.plateLoading ? 'loading' : (s.openNote?.text ?? '') }).toBe('assembly.step: Split into 2 objects.')

  // An inch file arrives at its real size, and the note says it was converted.
  await drop('bracket-inch.stp')
  await expect(page.locator('.obj-name', { hasText: 'bracket-inch' })).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await store(page)).openNote?.text ?? '').toMatch(/^bracket-inch\.stp: Converted from inches to millimeters/)

  // A file with nothing in it is refused in words and adds nothing.
  const before = (await store(page)).plate.length
  await drop('empty.step')
  await expect.poll(async () => (await store(page)).toast?.text ?? '', { timeout: 60_000 }).toMatch(/empty\.step has no solids/)
  expect((await store(page)).plate.length).toBe(before)

  // Slice a STEP part on its own, centered by the import. (Arranging several objects can leave a brim
  // past the bed edge, which the safety preflight blocks; that is the arrange's business, not STEP's.)
  await setState(page, { plate: [], selection: null, selectedIds: [] })
  await drop('bracket-inch.stp')
  await expect.poll(async () => (await store(page)).plate.length, { timeout: 60_000 }).toBe(1)
  // The slice of the bracket, not the earlier one of the assembly: done, current and with a new id. An error shows its
  // message in the failure.
  const earlier = (await store(page)).slice.result?.id ?? null
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).click()
  await expect.poll(async () => { const sl = (await store(page)).slice as { status: string; stale?: boolean; error?: unknown; result?: { id: string } }; if (sl.status === 'error') return JSON.stringify(sl).slice(0, 400); return sl.status === 'done' && !sl.stale && sl.result?.id !== earlier ? 'done' : sl.status }, { timeout: 120_000 }).toBe('done')
})
