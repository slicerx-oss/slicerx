// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A big plate's auto slice waits for the plate's fit check (state/auto-slice.ts), so the fit check runs whatever is on
// screen: with Slice's right pane shut, as people get it, where the objects list is not drawn. After the open and after
// a preset edit the slice starts soon, not after the fit check's longest wait.
import { expect, test } from '@playwright/test'
import { zip } from './project-zip'

type Sx = { getState(): { plateLoading: boolean; plate: { name: string }[]; slice: { status: string; startedAt?: number } } }

/** A closed tube of `rings` by `around` quads: enough triangles that its slice counts as a big one (slice-estimate.ts). */
function tube(rings: number, around: number): string {
  const v: string[] = []
  const t: string[] = []
  for (let r = 0; r <= rings; r++) {
    const z = (r / rings) * 20
    for (let a = 0; a < around; a++) {
      const ang = (a / around) * Math.PI * 2
      v.push(`<vertex x="${(15 * Math.cos(ang)).toFixed(4)}" y="${(15 * Math.sin(ang)).toFixed(4)}" z="${z.toFixed(4)}"/>`)
    }
  }
  const at = (r: number, a: number) => r * around + (a % around)
  for (let r = 0; r < rings; r++) for (let a = 0; a < around; a++) t.push(`<triangle v1="${at(r, a)}" v2="${at(r, a + 1)}" v3="${at(r + 1, a + 1)}"/>`, `<triangle v1="${at(r, a)}" v2="${at(r + 1, a + 1)}" v3="${at(r + 1, a)}"/>`)
  const ends = v.length
  v.push('<vertex x="0" y="0" z="0"/>', '<vertex x="0" y="0" z="20"/>')
  for (let a = 0; a < around; a++) t.push(`<triangle v1="${ends}" v2="${at(0, a + 1)}" v3="${at(0, a)}"/>`, `<triangle v1="${ends + 1}" v2="${at(rings, a)}" v3="${at(rings, a + 1)}"/>`)
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="Tube" type="model"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 120 120 0"/></build></model>`
}

test('a big plate slices soon after it opens and after a preset edit, with the right pane shut', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop width: on a phone the objects list is in the settings sheet')
  test.slow()
  await page.addInitScript(() => {
    // The shut right pane people get; other specs start with it open.
    sessionStorage.setItem('sx-right-pane', 'shut')
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    // Always: Auto holds a big plate for Slice, and this is about how soon a big plate's background slice starts.
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', pilot: { mode: 'off' }, autoSliceBySize: false }))
  })
  await page.goto('./')
  // The starter is on the plate (the objects list is in the right pane, shut here, and the plate chip names the plate only).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx?: Sx }).__sx?.getState().plate.some((p) => p.name.includes('Layered X')) ?? false), { timeout: 120_000 }).toBe(true)
  const state = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __sx: Sx }).__sx.getState()
      return { loading: s.plateLoading, names: s.plate.map((p) => p.name), status: s.slice.status, startedAt: s.slice.startedAt ?? null }
    })
  // About 640,000 triangles: an expected slice of 1.6 s, a big one, on any machine.
  const file = zip({ '3D/3dmodel.model': tube(800, 400) })
  // A slice can start and finish between two looks (the native engine is quick): a new start or a newly finished
  // slice both count.
  const slices = async () => Number((await page.locator('.studio').getAttribute('data-slices')) ?? 0)
  const started = async (since: { startedAt: number | null; slices: number }) => {
    const s = await state()
    return (s.status === 'running' && s.startedAt !== since.startedAt) || (await slices()) > since.slices
  }
  // The starter's own slice opens the right pane when it finishes; shut by hand, it stays shut.
  await expect.poll(async () => (await state()).status, { timeout: 120_000 }).not.toBe('running')
  const tab = page.getByTestId('edge-tab-right')
  if ((await tab.getAttribute('aria-expanded')) === 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-expanded', 'false')
  const before = { startedAt: (await state()).startedAt, slices: await slices() }
  // One listener for the whole test: the plate's first slice can finish and draw while Ctrl+O is pressed, so the
  // chooser may come late. A chooser no listener takes stays open, and the browser then shows no other, so a
  // short-lived wait per press could miss the first chooser and block every later one.
  let chosen = 0
  page.on('filechooser', (c) => {
    if (chosen++ === 0) void c.setFiles({ name: 'tube.3mf', mimeType: 'model/3mf', buffer: file })
  })
  await expect(async () => {
    if (chosen === 0) await page.keyboard.press('ControlOrMeta+o')
    await expect.poll(() => chosen, { timeout: 10_000 }).toBeGreaterThan(0)
  }).toPass({ timeout: 60_000 })
  await expect.poll(async () => { const s = await state(); return !s.loading && s.names.includes('Tube') }, { timeout: 120_000 }).toBe(true)
  // Well inside the fit check's longest wait (FIT_WAIT_MS, 15 s): the check ran and said it was done.
  const soon = 7_500
  let from = Date.now()
  await expect.poll(() => started(before), { timeout: soon, intervals: [50] }).toBe(true)
  const opened = Date.now() - from
  // A preset edit (the Fine goal) once that slice is done: the next one starts as soon.
  await expect.poll(async () => (await state()).status, { timeout: 120_000 }).not.toBe('running')
  const first = { startedAt: (await state()).startedAt, slices: await slices() }
  from = Date.now()
  await page.getByTestId('slice-goal-fine').click()
  await expect.poll(() => started(first), { timeout: soon, intervals: [50] }).toBe(true)
  test.info().annotations.push({ type: 'auto slice', description: `started ${opened} ms after the open and ${Date.now() - from} ms after the edit` })
})
