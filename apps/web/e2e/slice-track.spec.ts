// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice in progress takes the big button's place in the Estimate block in a track of the button's own height, so
// the block does not move when a slice starts or ends, and muninn rides the bar inside the track, clear of the text
// above it.
import { expect, plateReady, test } from './fixtures'

test('the Estimate block keeps its height while a slice runs, and muninn stays clear of its text', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, autoSlice: false }))
  })
  await page.goto('./')
  await plateReady(page)
  const block = page.locator('[data-section="estimate"]').first()
  await block.scrollIntoViewIfNeeded()
  const idle = await block.boundingBox()
  // A slice that runs for a while: the store says so, as the engine's progress would.
  await page.evaluate(() => (window as any).__sx.setState({ slice: { status: 'running', progress: { stage: 'paths', fraction: 0.55 }, startedAt: performance.now() } }))
  const track = page.getByTestId('slice-track')
  await expect(track).toBeVisible()
  const raven = page.getByTestId('raven-slice-glide')
  await expect(raven).toBeVisible({ timeout: 5_000 })
  const running = await block.boundingBox()
  expect(Math.abs((running?.height ?? 0) - (idle?.height ?? 0))).toBeLessThanOrEqual(1)
  const r = (await raven.boundingBox())!
  const t = (await track.boundingBox())!
  // Inside the track, so above it is only the line of text, which it never reaches.
  expect(r.y).toBeGreaterThanOrEqual(t.y - 0.5)
  expect(r.y + r.height).toBeLessThanOrEqual(t.y + t.height + 0.5)
  for (const text of await block.locator('p').all()) {
    const b = await text.boundingBox()
    if (!b) continue
    const overlaps = r.x < b.x + b.width && b.x < r.x + r.width && r.y < b.y + b.height && b.y < r.y + r.height
    expect(overlaps).toBe(false)
  }
  // And back: the slice ends, the button comes back in the same place.
  await page.evaluate(() => (window as any).__sx.setState({ slice: { status: 'idle' } }))
  await expect(track).toHaveCount(0)
  const after = await block.boundingBox()
  expect(Math.abs((after?.height ?? 0) - (idle?.height ?? 0))).toBeLessThanOrEqual(1)
})
