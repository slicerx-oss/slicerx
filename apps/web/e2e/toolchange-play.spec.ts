// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preview on a tool changer: playback through a tool change runs without errors and without dropping frames.
import { type Page } from '@playwright/test'
import { expect, plateReady, test } from './fixtures'

interface Hook {
  timeline: { total: number; changes: { segment: number; start: number; duration: number }[] } | null
  seek(t: number): void
  toggle(): void
  playing(): boolean
  clock(): number
}

async function slicedOnTheH2C(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-6' }))
  })
  await page.goto('./')
  await plateReady(page)
  await expect(page.locator('.printer-name')).toContainText('Bay 6', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByRole('group', { name: 'Layers and moves' })).toBeVisible({ timeout: 120_000 })
}

test('playback through a tool change on the H2C runs clean and keeps its frame rate', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop layout')
  test.slow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())))
  await slicedOnTheH2C(page)
  // The printer is a hotend rack and the plate has two colors: the timeline carries changes.
  const info = await page.evaluate(() => {
    const w = window as unknown as { __pv: Hook; __vp: { toolpaths: { changePoints(): unknown[] } } }
    const tl = w.__pv.timeline!
    return { changes: tl.changes.length, points: w.__vp.toolpaths.changePoints().length, first: tl.changes[0] ?? null, total: tl.total }
  })
  expect(info.points).toBeGreaterThan(0)
  expect(info.changes).toBe(info.points)
  // The head drives to the chute and back, on top of the firmware's own seconds for the change.
  expect(info.first!.duration).toBeGreaterThan(10)
  // Play at 2x from 20 s of print time before the first change to just after it, and time the frames. The change lasts
  // about 16 s of print time, so it plays for about eight seconds, after ten of plain playback.
  await page.getByRole('radio', { name: '2 times real time' }).click()
  await page.evaluate((t) => (window as unknown as { __pv: Hook }).__pv.seek(t), Math.max(0, info.first!.start - 20))
  const result = await page.evaluate(async (until) => {
    const w = window as unknown as { __pv: Hook }
    const plain: number[] = []
    const inChange: number[] = []
    let last = performance.now()
    w.__pv.toggle()
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const dt = now - last
        last = now
        // A tick under 30 ms redrew nothing: it came one 60 Hz interval (17 ms) after the last, where a frame that
        // draws the view takes far longer on software WebGL. Counting it would pull either median down.
        if (dt >= 30) (document.querySelector('[data-testid="pv-change"]') ? inChange : plain).push(dt)
        if (w.__pv.clock() >= until || !w.__pv.playing()) return resolve()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const reached = w.__pv.clock() >= until
    if (w.__pv.playing()) w.__pv.toggle()
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0
    return { plain: plain.length, inChange: inChange.length, medianPlain: median(plain), medianInChange: median(inChange), longestPlain: Math.max(0, ...plain), longestInChange: Math.max(0, ...inChange), reached }
  }, info.first!.start + info.first!.duration + 2)
  test.info().annotations.push({ type: 'frames', description: JSON.stringify(result) })
  expect(errors).toEqual([])
  expect(result.reached).toBe(true)
  expect(result.plain).toBeGreaterThan(2)
  expect(result.inChange).toBeGreaterThan(3)
  // The change keeps the frame rate of plain playback, measured in the same run. Software WebGL draws every playback
  // frame slowly, at a pace that is the machine's (on a CI runner about a second a frame, plain or not), so a limit in
  // milliseconds measures the runner and not the app. Drawing the head at the rack, the rack and the purge may cost a
  // little more: the change's median frame stays within 1.5 times the plain median. Its longest frame is held to the
  // longest plain frame, not to a median: plain playback misses frame deadlines too (single frames of two or three times
  // the median), so only a frame well past the worst of those is a stall.
  expect(result.medianInChange).toBeLessThanOrEqual(1.5 * result.medianPlain)
  expect(result.longestInChange).toBeLessThanOrEqual(1.5 * result.longestPlain)
  // Scrubbing the time slider onto the change places the head away from the paths, and back.
  const mid = info.first!.start + info.first!.duration / 2
  await page.evaluate((t) => (window as unknown as { __pv: Hook }).__pv.seek(t), mid)
  await expect(page.getByTestId('pv-change')).toContainText('Tool change 1')
  // Half way through, the head is at the chute behind the bed or at the rack beside it, not over the paths.
  const head = await page.evaluate(() => {
    const w = window as unknown as { __vp: { toolpaths: { head: { head: { position: { x: number; y: number } } } } } }
    return w.__vp.toolpaths.head.head.position
  })
  expect(head.y > 300 || head.x > 320).toBe(true)
  await page.evaluate((t) => (window as unknown as { __pv: Hook }).__pv.seek(t), info.first!.start + info.first!.duration + 1)
  await expect(page.getByTestId('pv-change')).toHaveCount(0)
})
