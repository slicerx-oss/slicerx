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
    // An edit, so opening keeps unsaved work first, a bed full of cubes and very thin solid layers, so the slice runs
    // well past the open.
    await openTransform(page)
    await page.getByRole('button', { name: 'Fill bed' }).click()
    await expect.poll(() => page.locator('.objs > li').count()).toBeGreaterThan(4)
    await expect(page.locator('html')).not.toHaveAttribute('data-sx-busy')
    await page.keyboard.press('Escape')
    await setState(page, { overrides: { layer_height: '0.04', sparse_infill_density: '100%' } })
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect.poll(status).toBe('running')
    // The slice must still be running here, or the step proves nothing about stopping it.
    expect(await status()).toBe('running')
    const picked = Date.now()
    await openFile(page, join(starters(), 'cable-clip.sx3mf'))
    await expect(page.locator('.obj-name')).toHaveText(['Cable clip'], { timeout: 60_000 })
    const ms = Date.now() - picked
    console.log(`open-while-slicing: the clip loaded ${ms} ms after the file was picked`)
    // Opening asks nothing: the old plate is kept as a recent project first, and that write is part of the time.
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
  const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'step-reader', 'test', 'fixtures')
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

// A STEP file that colors its solids opens with each colored body on a filament of its color, says so in the note
// under the printer card, and Use one filament there takes the added filaments back.
test('a dropped STEP with colored bodies opens on filaments of its colors', async ({ page }) => {
  test.slow()
  const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'step-reader', 'test', 'fixtures')
  await setState(page, { plate: [], selection: null, selectedIds: [], toast: null, openNote: null, printerSlots: [], slotSetup: {} })
  await dropFile(page, 'assembly-colors.step', readFileSync(join(fixtures, 'assembly-colors.step')), 'application/step')
  await expect(page.locator('.obj-name', { hasText: 'cube' })).toBeVisible({ timeout: 60_000 })
  const note = page.getByTestId('open-note')
  await expect(note.getByTestId('open-note-text')).toHaveText("assembly-colors.step: Added filaments 2 (Red) and 3 (Blue) for the file's colors. Split into 2 objects.")
  const slots = () => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { slotOverrides?: Record<string, number>; handle: { parts: { name: string; slot: number }[] } }[] } } }).__sx.getState().plate.flatMap((e) => e.handle.parts.map((p) => e.slotOverrides?.[p.name] ?? p.slot)))
  expect(await slots()).toEqual([2, 1, 3])
  await note.getByTestId('open-note-action').filter({ hasText: 'Use one filament' }).click()
  await expect.poll(slots).toEqual([1, 1, 1])
})

// Paint from a texture: an OBJ dropped with its MTL and PNG shows painted from its texture, the toast says how many
// colors went to which filaments with an Undo, and the view shows the four colors on the cube.
test('an OBJ dropped with its MTL and PNG is painted from its texture, with an Undo toast', async ({ page }) => {
  test.slow()
  const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'geom', 'tests', 'fixtures', 'texture')
  const files = ['textured-cube.obj', 'textured-cube.mtl', 'quadrants.png'].map((name) => ({ name, data: [...readFileSync(join(fixtures, name))] }))
  const red = { type: 'PLA', brand: '', color: '#e6141e' }
  await setState(page, {
    plate: [], selection: null, selectedIds: [], toast: null, openNote: null, printerSlots: [],
    slotSetup: { 1: red, 2: { ...red, color: '#14c828' }, 3: { ...red, color: '#1428dc' }, 4: { ...red, color: '#f5f5f5' } },
  })
  await page.evaluate((files) => {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(new File([new Uint8Array(f.data)], f.name))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, files)
  await expect.poll(async () => (await store(page)).toast?.text ?? '', { timeout: 60_000 }).toBe('Painted from texture: 4 colors to filaments 1, 2, 3 and 4.')
  const painted = (await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { paint?: Record<number, { color?: Record<number, string> }> }[] } } }).__sx.getState().plate[0]?.paint?.[0]?.color)) ?? {}
  expect(Object.keys(painted).length).toBeGreaterThan(0)

  // Framed, the cube shows red, green and blue (white is the bed's color too): each covers more than 200 pixels of the
  // canvas. The Slice tab slices the new plate and then shows its toolpaths, so each look asks for the solid models.
  await page.evaluate(() => (window as unknown as { __vp: { zoomToSelection(o: { animate: boolean }): void } }).__vp.zoomToSelection({ animate: false }))
  const canvas = page.locator('canvas').first()
  await expect.poll(async () => {
    await setState(page, { sliceLook: 'solid' })
    await page.waitForTimeout(200)
    const shot = (await canvas.screenshot()).toString('base64')
    return page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const g = c.getContext('2d')!
      g.drawImage(bmp, 0, 0)
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data
      const n = { red: 0, green: 0, blue: 0 }
      for (let i = 0; i < px.length; i += 4) {
        const [r, gr, b] = [px[i]!, px[i + 1]!, px[i + 2]!]
        const max = Math.max(r, gr, b)
        const min = Math.min(r, gr, b)
        if (max < 60 || max - min < max * 0.45) continue
        if (max === r && gr < r * 0.5 && b < r * 0.5) n.red++
        else if (max === gr && r < gr * 0.6 && b < gr * 0.6) n.green++
        else if (max === b && r < b * 0.5 && gr < b * 0.7) n.blue++
      }
      return Math.min(n.red, n.green, n.blue)
    }, shot)
  }, { timeout: 30_000 }).toBeGreaterThan(200)

  // Undo in the toast takes the paint off and keeps the model.
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect.poll(async () => { const s = await store(page); return [s.plate.length, (s.plate[0] as { paint?: unknown } | undefined)?.paint === undefined] }).toEqual([1, true])
})
