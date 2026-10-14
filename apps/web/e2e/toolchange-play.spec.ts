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

// Drawn frames after Play before the plain window may open, and the fewest drawn frames each window must hold.
const WARM_UP = 30
const MIN_FRAMES = 100

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

test('playback through a tool change on the H2C runs clean and keeps its frame rate', { tag: ['@gpu', '@gpu-timing'] }, async ({ page, isMobile }) => {
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
  // Play at 2x from 20 s of print time before the first change to just after it, and time the frames the view draws.
  // The change lasts about 16 s of print time, so it plays for about eight seconds, after ten of plain playback.
  // A frame counts when the viewport's own frame counter moved since the last tick, so each interval is between two
  // drawn frames at whatever pace the browser runs: a fixed cutoff on tick length (once 30 ms, for software WebGL's
  // ticks that drew nothing) sat right on the GPU lane's own pace of about 31 ms a tick and would drop every frame of
  // a 60 Hz one. The plain window opens once playback is warmed up, after WARM_UP drawn frames and a second after Play
  // (the first frames after Play come at an uneven pace, with many short intervals, which would pull the plain median
  // down), and only in the last 10 s of print time before the change (about five seconds).
  // a segmented control on a wide bar, one menu button on a folded one
  const seg = page.getByRole('radio', { name: '2 times real time' })
  if (await seg.isVisible()) await seg.click()
  else {
    await page.getByRole('button', { name: /^Playback speed/ }).click()
    await page.getByRole('menuitemcheckbox', { name: '2x' }).click()
  }
  await page.evaluate((t) => (window as unknown as { __pv: Hook }).__pv.seek(t), Math.max(0, info.first!.start - 20))
  const result = await page.evaluate(async ({ from, until, warmUp }) => {
    const w = window as unknown as { __pv: Hook; __vp: { stats(): { frames: number } } }
    const plain: number[] = []
    const inChange: number[] = []
    let frames = w.__vp.stats().frames
    let drawn = 0
    let lastDrawn = -1
    w.__pv.toggle()
    const t0 = performance.now()
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const f = w.__vp.stats().frames
        if (f > frames) {
          frames = f
          drawn++
          if (lastDrawn >= 0) {
            const dt = now - lastDrawn
            if (document.querySelector('[data-testid="pv-change"]')) inChange.push(dt)
            else if (drawn > warmUp && now - t0 >= 1000 && w.__pv.clock() >= from && inChange.length === 0) plain.push(dt)
          }
          lastDrawn = now
        }
        if (w.__pv.clock() >= until || !w.__pv.playing()) return resolve()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const reached = w.__pv.clock() >= until
    if (w.__pv.playing()) w.__pv.toggle()
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0
    return { drawn, plain: plain.length, inChange: inChange.length, medianPlain: median(plain), medianInChange: median(inChange), longestPlain: Math.max(0, ...plain), longestInChange: Math.max(0, ...inChange), reached, plainFrames: plain.map(Math.round), changeFrames: inChange.map(Math.round) }
  }, { from: info.first!.start - 10, until: info.first!.start + info.first!.duration + 2, warmUp: WARM_UP })
  test.info().annotations.push({ type: 'frames', description: JSON.stringify(result) })
  expect(errors).toEqual([])
  expect(result.reached).toBe(true)
  // Enough drawn frames on each side for a median to mean something. The GPU lane draws about 32 frames a second
  // (about 160 plain and 255 in the change); fewer than MIN_FRAMES is a view that stopped drawing, or a machine too slow
  // to time a frame rate on, and either way the comparison below would rest on a handful of frames.
  expect(result.plain).toBeGreaterThanOrEqual(MIN_FRAMES)
  expect(result.inChange).toBeGreaterThanOrEqual(MIN_FRAMES)
  // The change keeps the frame rate of plain playback, measured in the same run; a limit in milliseconds would
  // measure the machine and not the app. Drawing the head at the rack, the rack and the purge may cost a little more:
  // the change's median frame stays within 1.5 times the plain median.
  // Single frames are not compared one to one: entering the change is cheap, nothing compiles a shader during it and
  // the viewport's own script takes about a millisecond a frame, and the occasional missed frame deadline comes anywhere
  // in plain playback as well as in the change. A frame over five times the plain median is past those misses: a real
  // stall, as is playback that never reaches the end of the change (`reached` above).
  expect(result.medianInChange).toBeLessThanOrEqual(1.5 * result.medianPlain)
  expect(result.longestInChange).toBeLessThanOrEqual(5 * result.medianPlain)
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
