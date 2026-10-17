// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: the prime tower on Bay 2. Its place is automatic, a hand move turns that off and the engine keeps the spot,
// auto snaps it back, and a spot off the bed shows a note instead of an error; the drawn tower is hit by the viewport's
// ray, and the inline settings plan renders. Layered X is on the plate for its two filaments; both tests slice it once
// per page (the second reuses what the first left).
import { type Page } from '@playwright/test'
import { sliceCount, sliced, tab, viewportReady } from '../fixtures'
import { expect, journey as test } from '../journey'
import { calm, debugHooks, layeredX, patch, plain, screenOf, state, usePrinter, type Tower } from './lib/slice'

test.skip(({ isMobile }) => isMobile, 'Desktop layout and a pointer')

test.beforeAll(async ({ app }) => {
  await debugHooks(app)
})

type Sx = { getState(): { tower: { auto: boolean; x: number; y: number }; slice: { status: string; stale?: boolean; result?: { id: string; primeTower?: Tower } } }; setState(p: unknown): void }

/** Layered X on Bay 2, the printer that needs a prime tower, with nothing else set. */
async function onBay2(page: Page): Promise<void> {
  await calm(page)
  await plain(page)
  await layeredX(page)
  await usePrinter(page, /Bay 2/)
}

// The tower of the slice this click starts: done, current and with a new id, so the last slice's tower does not pass for it.
async function sliceAgain(page: Page): Promise<Tower> {
  const slice = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return { status: s.status, stale: s.stale ?? false, id: s.result?.id ?? null } })
  const before = (await slice()).id
  await tab(page, 'prepare').click()
  const slices1 = await sliceCount(page)
  await page.getByRole('main').getByRole('button', { name: /^Slice/ }).first().click()
  await expect.poll(async () => { const s = await slice(); return s.status === 'done' && !s.stale && s.id !== before }, { timeout: 120_000 }).toBe(true)
  await expect(sliced(page, slices1)).toBeVisible({ timeout: 120_000 })
  await tab(page, 'prepare').click()
  return page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result!.primeTower!)
}

const moveTower = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => {
    const vp = (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp
    // The same events the viewport sends for a click on the tower and a finished drag of it.
    vp.emit('pick', { objectId: 'prime-tower' })
    vp.emit('transform', { id: 'prime-tower', final: true, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] })
  }, [x, y] as const)

test('the prime tower is automatic, a hand move turns that off, and a spot off the bed gets a note', async ({ page }) => {
  test.slow()
  await onBay2(page)
  // Automatic at the start, whatever an earlier test did to it.
  await patch(page, { tower: { ...(await state(page)).tower, auto: true }, slice: { status: 'idle' } })

  const auto = await sliceAgain(page)
  expect(auto.reason).toBe('auto')
  const tower = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().tower)
  expect(await tower()).toMatchObject({ auto: true })
  // The atlas row is in the Color tab of the print settings.
  await patch(page, { expertOpen: true })
  await page.getByTestId('slice-settings-tab-multicolor').click()
  const atlas = page.getByTestId('slice-tower-atlas')
  await expect(atlas).toHaveAttribute('data-auto', 'true')

  // Drag it: auto turns off at once, and the engine keeps the spot.
  await moveTower(page, 190, 30)
  expect(await tower()).toEqual({ auto: false, x: 190, y: 30 })
  await expect(atlas).toHaveAttribute('data-auto', 'false')
  const kept = await sliceAgain(page)
  expect(kept).toMatchObject({ x: 190, y: 30, reason: 'kept' })

  // Placed automatically again: the engine picks its own spot.
  await atlas.getByRole('button', { name: 'Place automatically' }).click()
  expect(await tower()).toMatchObject({ auto: true })
  const again = await sliceAgain(page)
  expect(again.reason).toBe('auto')

  // Off the bed: the engine pulls it back and the panel says so. It is a note, not an error.
  await moveTower(page, 400, 400)
  const pulled = await sliceAgain(page)
  expect(pulled.reason).toBe('moved_onto_bed')
  expect(pulled.x + pulled.width).toBeLessThanOrEqual(256.5)
  await expect(page.getByRole('status').filter({ hasText: 'moved the prime tower back onto the bed' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.status)).toBe('done')
  await patch(page, { tower: { ...(await tower()), auto: true }, expertOpen: false })
})

test('the viewport ray hits the prime tower, and the settings plan renders', async ({ page }, info) => {
  test.slow()
  await onBay2(page)
  await viewportReady(page)
  // The tower of the slice on the screen, or of a new one when the plate has none yet.
  let s = (await state(page)).slice
  if (!(s.status === 'done' && !s.stale && s.result?.primeTower)) {
    await sliceAgain(page)
    s = (await state(page)).slice
  }
  await tab(page, 'prepare').click()
  const t = s.result!.primeTower!
  // Find a screen point the viewport's own ray hits the tower at, from the middle of the drawn tower, high up on the box.
  const findSpot = async () => {
    const at = await screenOf(page, t.x + t.width / 2, t.y + t.depth / 2, 5)
    return page.evaluate(([cx, cy]) => {
      const vp = (window as unknown as { __vp: { pickFn(e: { clientX: number; clientY: number }): { entry: { id: string } } | null } }).__vp
      const got: { x: number; y: number }[] = []
      for (let dx = -300; dx <= 300; dx += 4) for (let dy = -300; dy <= 300; dy += 4) if (vp.pickFn({ clientX: (cx as number) + dx, clientY: (cy as number) + dy })?.entry.id === 'prime-tower') got.push({ x: (cx as number) + dx, y: (cy as number) + dy })
      const mean = (k: 'x' | 'y') => got.reduce((n, p) => n + p[k], 0) / Math.max(1, got.length)
      return { n: got.length, x: mean('x'), y: mean('y') }
    }, [at.x, at.y] as const)
  }
  // The 3D view takes a moment to show the plate again after the tab change; poll until the ray reaches the tower.
  await expect.poll(async () => (await findSpot()).n, { timeout: 60_000 }).toBeGreaterThan(20)
  // The viewport's own ray reaches the tower, so the move gizmo can take it. (A real mouse click does not register on the canvas under the
  // headless software renderer, even on the model before any slice, so the move itself is covered by the first test through the viewport's events.)
  if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath('tower-in-view.png') })
  // The inline settings plan: a nozzle too small for an abrasive filament is a blocker. Set one filament to a CF material.
  try {
    await patch(page, { slotSetup: { 1: { type: 'PA-CF', brand: '', color: '#222222' } } })
    await expect(page.getByRole('status', { name: 'Setup notes' })).toBeVisible({ timeout: 15_000 })
    if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath('setup-notes.png') })
  } finally {
    await patch(page, { slotSetup: {} })
  }
})
