// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Print by object on a plate arranged by layer: the boxes sit a few millimeters apart, too close for the toolhead. The
// slice runs and heimdall strikes it: the collision list names the hit, the layer slider carries the strike, Print
// waits. A jump goes to the moment, and printing by layer, one click away, clears it.
import { expect, test } from '@playwright/test'
import { plateReady } from './fixtures'
import { command } from './cad-helpers'

type Collision = { title: string; layer: number; severity: string }
type Sx = {
  getState(): {
    plate: { id: string }[]
    plates: { id: string; settings: Record<string, unknown> }[]
    activePlate: string
    workspace: string
    modelMode: string
    sliceLook: string
    preview: unknown
    layerHi: number
    strikePick: number | null
    slice: { status: string; stale?: boolean; message?: string; result?: { id: string; collisions?: Collision[] } }
  }
  setState(p: unknown): void
}

test('heimdall strikes a plate too close to print by object, and printing by layer clears it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const sx = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return { n: s.plate.length, workspace: s.workspace, layers: s.workspace === 'prepare' && s.modelMode === 'slice' && s.sliceLook === 'toolpaths' && s.preview !== null, status: s.slice.status, stale: s.slice.stale ?? false, id: s.slice.result?.id ?? null, collisions: s.slice.result?.collisions ?? [], layerHi: s.layerHi, pick: s.strikePick } })
  const workspace = (w: string) => page.evaluate((ws) => (window as unknown as { __sx: Sx }).__sx.setState({ workspace: ws }), w)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  for (const n of [1, 2]) {
    await command(page, 'Add a box')
    await expect.poll(async () => (await sx()).n).toBe(n)
  }
  await command(page, 'Arrange all objects')
  const print = page.getByRole('button', { name: 'Print', exact: true })
  await expect.poll(async () => { const s = await sx(); return s.status === 'done' && !s.stale }, { timeout: 120_000 }).toBe(true)
  await expect(print).toBeEnabled()

  // By object the boxes stand inside the toolhead's reach: the slice runs and heimdall strikes it. The sequence change
  // starts a background slice, and it settles first: a command slice still running when the test moves on would
  // finish later and show its toolpaths again.
  await page.evaluate(() => {
    const st = (window as unknown as { __sx: Sx }).__sx
    const s = st.getState()
    st.setState({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, sequence: 'by-object' } } : p)) })
  })
  await expect.poll(async () => { const s = await sx(); return s.status === 'done' && !s.stale && s.collisions.some((c) => c.severity === 'hit') }, { timeout: 120_000 }).toBe(true)
  const background = (await sx()).id
  await command(page, 'Slice the plate')
  // The command's own slice is done once its result replaces the background one and Slice shows its toolpaths (there
  // is no Preview workspace any more: the command shows the slice in Slice).
  await expect.poll(async () => { const s = await sx(); return s.layers && s.status === 'done' && !s.stale && s.id !== background && s.collisions.some((c) => c.severity === 'hit') }, { timeout: 120_000 }).toBe(true)
  await expect(page.getByRole('alert').filter({ hasText: 'heimdall found' }).first()).toBeVisible()
  await workspace('prepare')
  await expect(print).toBeDisabled()

  // Slice's summary lists the strikes, marks them on the layer slider, and offers the fixes.
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ workspace: 'prepare', sliceLook: 'toolpaths' }))
  const list = page.locator('[data-section="collisions"]')
  await expect(list).toBeVisible()
  await expect(list.locator('.strike-tag')).toContainText(/strikes? on this plate/)
  const first = list.locator('.strikes li').first()
  await expect(first).toContainText(/hits/)
  await expect(first.locator('.sx-ic')).toBeVisible()
  await expect(page.locator('.layer-mark.strike-mark').first()).toBeVisible()
  await first.getByRole('button', { name: /^Jump to:/ }).click()
  const { collisions } = await sx()
  await expect.poll(async () => (await sx()).pick).toBe(0)
  // Playback runs up to the strike and stops on its layer.
  await expect.poll(async () => (await sx()).layerHi).toBe((collisions[0]?.layer ?? 0) + 1)

  // Print by layer clears it in one click.
  const byLayer = list.locator('.strike-fixes li', { hasText: 'Print by layer' })
  await expect(byLayer).toBeVisible()
  await byLayer.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(async () => { const s = await sx(); return s.status === 'done' && !s.stale && s.collisions.length === 0 }, { timeout: 120_000 }).toBe(true)
  await expect(list).toHaveCount(0)
  await workspace('prepare')
  await expect(print).toBeEnabled()
})
