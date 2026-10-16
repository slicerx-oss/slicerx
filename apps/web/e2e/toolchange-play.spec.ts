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

interface RendererInfo {
  programs: unknown[] | null
  memory: { geometries: number; textures: number }
}

// Drawn frames after Play before the plain window may open, and the fewest drawn frames each window must hold.
const WARM_UP = 30
const MIN_FRAMES = 100
// The fewest main thread CPU samples each window must hold, and how much more CPU time the change's busiest stretch
// may use than plain playback's (ms).
const MIN_CPU_SAMPLES = 20
const CPU_ALLOWANCE = 50

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
  // At 2x, sample plain playback for as long as the tool change, after 10 s of print-time warmup.
  // Equal windows give the minimum sample count the same duration on both sides.
  // A frame counts when the viewport's own frame counter moved since the last tick, so each interval is between two
  // drawn frames at whatever pace the browser runs: a fixed cutoff on tick length (once 30 ms, for software WebGL's
  // ticks that drew nothing) sat right on the GPU lane's own pace of about 31 ms a tick and would drop every frame of
  // a 60 Hz one. The plain window opens once playback is warmed up, after WARM_UP drawn frames and a second after Play
  // (the first frames after Play come at an uneven pace, with many short intervals, which would pull the plain median
  // down), and only in the matching window before the change.
  // a segmented control on a wide bar, one menu button on a folded one
  const seg = page.getByRole('radio', { name: '2 times real time' })
  if (await seg.isVisible()) await seg.click()
  else {
    await page.getByRole('button', { name: /^Playback speed/ }).click()
    await page.getByRole('menuitemcheckbox', { name: '2x' }).click()
  }
  const plainStart = info.first!.start - info.first!.duration
  const warmupStart = plainStart - 10
  expect(warmupStart).toBeGreaterThanOrEqual(0)
  await page.evaluate((t) => (window as unknown as { __pv: Hook }).__pv.seek(t), warmupStart)
  // While playback runs, the main thread's own CPU time (the protocol's ThreadTime) is read every 10 ms or so, each
  // reading paired with the page clock. A reading waits for the task in progress, so a long task falls between two
  // readings, and the CPU time between them tells the app's own work apart from time the system ran other processes.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const readings: { at: number; cpu: number }[] = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const [metrics, clock] = await Promise.all([cdp.send('Performance.getMetrics'), cdp.send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true })])
      const cpu = metrics.metrics.find((m) => m.name === 'ThreadTime')?.value
      if (cpu !== undefined && typeof clock.result.value === 'number') readings.push({ at: clock.result.value, cpu: cpu * 1000 })
      await new Promise((r) => setTimeout(r, 10))
    }
  })()
  const result = await page.evaluate(async ({ from, until, warmUp }) => {
    const w = window as unknown as { __pv: Hook; __vp: { stats(): { frames: number }; renderer: { info: RendererInfo } } }
    const plain: number[] = []
    const inChange: number[] = []
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0
    // What the renderer holds: compiled shader programs, uploaded geometries and textures.
    const held = () => {
      const i = w.__vp.renderer.info
      return { programs: i.programs?.length ?? 0, geometries: i.memory.geometries, textures: i.memory.textures }
    }
    let frames = w.__vp.stats().frames
    let drawn = 0
    let lastDrawn = -1
    // Where each window starts and ends on the page clock, for the CPU readings.
    let plainFrom = -1
    let changeFrom = -1
    let changeTo = -1
    // The renderer before the change's first frame, after its last, and the most programs it held during it.
    let before = held()
    let after = before
    let mostPrograms = 0
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
            if (document.querySelector('[data-testid="pv-change"]')) {
              if (changeFrom < 0) changeFrom = lastDrawn
              changeTo = now
              inChange.push(dt)
              after = held()
              mostPrograms = Math.max(mostPrograms, after.programs)
            } else if (drawn > warmUp && now - t0 >= 1000 && w.__pv.clock() >= from && inChange.length === 0) {
              if (plainFrom < 0) plainFrom = lastDrawn
              plain.push(dt)
            }
          }
          lastDrawn = now
          if (inChange.length === 0) before = held()
        }
        if (w.__pv.clock() >= until || !w.__pv.playing()) return resolve()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const reached = w.__pv.clock() >= until
    if (w.__pv.playing()) w.__pv.toggle()
    return { plainFrom, changeFrom, changeTo, drawn, plain: plain.length, inChange: inChange.length, medianPlain: median(plain), medianInChange: median(inChange), reached, renderer: { before, after, mostPrograms } }
  }, { from: plainStart, until: info.first!.start + info.first!.duration + 2, warmUp: WARM_UP })
  sampling = false
  await sampler
  await cdp.detach()
  // The CPU time between each pair of readings: the busiest stretch in plain playback, and in the change (a stretch
  // that overlaps the change counts for it).
  const spans = readings.slice(1).map((r, i) => ({ from: readings[i]!.at, to: r.at, cpu: r.cpu - readings[i]!.cpu }))
  const plainSpans = spans.filter((s) => s.from >= result.plainFrom && s.to <= result.changeFrom)
  const changeSpans = spans.filter((s) => s.to > result.changeFrom && s.from < result.changeTo)
  const cpu = { plain: plainSpans.length, inChange: changeSpans.length, busiestPlain: Math.max(0, ...plainSpans.map((s) => s.cpu)), busiestInChange: Math.max(0, ...changeSpans.map((s) => s.cpu)) }
  test.info().annotations.push({ type: 'frames', description: JSON.stringify(result) })
  test.info().annotations.push({ type: 'cpu', description: JSON.stringify(cpu) })
  expect(errors).toEqual([])
  expect(result.reached).toBe(true)
  // Enough drawn frames on each side for a median to mean something. The GPU lane draws about 32 frames a second
  // (about 255 frames in each window); fewer than MIN_FRAMES is a view that stopped drawing, or a machine too slow
  // to time a frame rate on, and either way the comparison below would rest on a handful of frames.
  expect(result.plain).toBeGreaterThanOrEqual(MIN_FRAMES)
  expect(result.inChange).toBeGreaterThanOrEqual(MIN_FRAMES)
  // The change keeps the frame rate of plain playback, measured in the same run; a limit in milliseconds would
  // measure the machine and not the app. Drawing the head at the rack, the rack and the purge may cost a little more:
  // the change's median frame stays within 1.5 times the plain median.
  expect(result.medianInChange).toBeLessThanOrEqual(1.5 * result.medianPlain)
  // No limit on single long frames: when the system runs other processes for a while, the main thread waits several
  // display frames while using almost no CPU time, in either window (a blank page beside the other timing specs
  // shows the same gaps), so the longest frame measures the machine and not the app. A stall of the app's own
  // (synchronous work at the change, a long garbage collection) uses the main thread's CPU, whatever else the system
  // runs: the change's busiest stretch between two readings stays within plain playback's busiest stretch plus
  // CPU_ALLOWANCE. Plain playback's own stretches reach about 40 ms on a loaded machine; a stall of 120 ms is far over.
  expect(cpu.plain).toBeGreaterThanOrEqual(MIN_CPU_SAMPLES)
  expect(cpu.inChange).toBeGreaterThanOrEqual(MIN_CPU_SAMPLES)
  expect(cpu.busiestInChange).toBeLessThanOrEqual(cpu.busiestPlain + CPU_ALLOWANCE)
  // Work on the GPU's side at the change (a shader compiled, a mesh or texture uploaded) shows in the renderer: the
  // change adds no shader program, geometry or texture.
  const { before, after, mostPrograms } = result.renderer
  expect(mostPrograms).toBeLessThanOrEqual(before.programs)
  expect(after.geometries).toBeLessThanOrEqual(before.geometries)
  expect(after.textures).toBeLessThanOrEqual(before.textures)
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
