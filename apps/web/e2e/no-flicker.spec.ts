// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edit, a model added and the background slice after them change the screen once: the plate view never goes blank
// or swaps to another picture, and the panels never empty and come back, while the new slice runs. Every composited
// frame is checked (e2e/frames.ts). A preview waiting for its new slice is drawn dimmed, which keeps its picture.
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { alike, cellsIn, diff, pops, recordFrames, spread, swaps, type Box, type Frame } from './frames'
import { appReady, plateReady } from './fixtures'

type Sx = { getState(): { slice: { status: string; stale?: boolean }; plate: { transform: number[] }[] }; setState(p: unknown): void }

/** Panels: the mean gray difference (0 to 255) a frame may show against both the frame before the step and the one after. */
const PANEL_LIMIT = 6
/** The 3D view: how alike (correlation) a frame must be to the picture before the step or the one after. */
const VIEW_LIKE = 0.8

async function sliced(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => { const s = (window as unknown as { __sx?: Sx }).__sx?.getState().slice; return s?.status === 'done' && !s.stale }), { timeout: 120_000 })
    .toBe(true)
}

/** Lets the picture settle, so the last frame recorded is the finished one. */
const settle = (page: Page) => page.waitForTimeout(1500)

async function boxOf(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`${selector} is not on screen`)
  return b
}

/**
 * Fails on a frame where the view went blank or swapped pictures, or a panel popped. With `arrived`, the swap and pop
 * checks start at the first frame that already shows the finished picture, past a step that is meant to change the
 * whole screen (a model arriving and the view framing it); blank frames count from the start.
 */
async function check(page: Page, info: TestInfo, frames: Frame[], view: Box, panels: Record<string, Box>, arrived = false): Promise<void> {
  const size = page.viewportSize()!
  // The screencast sends a frame only when the picture changes: fewer than two means nothing on screen moved.
  if (frames.length < 2) return console.log(`${frames.length} frames: the picture did not change`)
  const report: string[] = [`${frames.length} frames over ${(frames.at(-1)!.t - frames[0]!.t).toFixed(2)} s`]
  const bad: string[] = []
  const v = cellsIn(view, size)
  const last = frames.at(-1)!
  const done = (f: Frame) => alike(f, last, v) >= VIEW_LIKE && Object.values(panels).every((b) => diff(f, last, cellsIn(b, size)) <= PANEL_LIMIT)
  const from = arrived ? (frames.find(done) ?? last).t - frames[0]!.t : 0
  // A view drawn with the plate and grid has detail; one flat color is a cleared canvas.
  const drawn = spread(frames[0]!, v)
  const blank = frames.flatMap((f, i) => (spread(f, v) < drawn * 0.3 ? [i] : []))
  const swapped = swaps(frames, v, VIEW_LIKE, from)
  report.push(`view: ${blank.length} blank, ${swapped.length} swapped${swapped.length ? ` (least alike ${Math.min(...swapped.map((s) => s.like)).toFixed(2)} at ${swapped[0]!.t.toFixed(2)} s)` : ''}`)
  if (blank.length) bad.push(`the view went blank in ${blank.length} frames`)
  if (swapped.length) bad.push(`the view swapped pictures in ${swapped.length} frames`)
  for (const [name, box] of Object.entries(panels)) {
    const cells = cellsIn(box, size)
    const found = pops(frames, cells, PANEL_LIMIT, from)
    report.push(`${name}: ${found.length} popped${found.length ? ` (worst ${Math.max(...found.map((p) => Math.min(p.fromStart, p.fromEnd))).toFixed(1)} at ${found[0]!.t.toFixed(2)} s)` : ''}`)
    if (found.length) bad.push(`${name} popped in ${found.length} frames`)
  }
  // Every frame and its numbers go to the test's output folder, to look at when a run fails.
  const dir = info.outputPath('frames')
  mkdirSync(dir, { recursive: true })
  frames.forEach((f, i) => writeFileSync(`${dir}/${String(i).padStart(3, '0')}.jpg`, Buffer.from(f.jpeg, 'base64')))
  const rows = frames.map((f) => `${(f.t - frames[0]!.t).toFixed(2)} like ${alike(f, frames[0]!, v).toFixed(2)}/${alike(f, frames.at(-1)!, v).toFixed(2)} spread ${spread(f, v).toFixed(1)} ${Object.entries(panels).map(([n, b]) => `${n} ${diff(f, frames[0]!, cellsIn(b, size)).toFixed(1)}/${diff(f, frames.at(-1)!, cellsIn(b, size)).toFixed(1)}`).join(' ')}`)
  writeFileSync(`${dir}/report.txt`, [...report, ...rows].join('\n'))
  console.log(report.join('\n'))
  expect(bad, report.join('\n')).toEqual([])
}

async function start(page: Page, workspace: 'prepare' | 'preview'): Promise<void> {
  await page.addInitScript((ws) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: ws, settingsMode: 'advanced', pilot: { mode: 'off' } }))
  }, workspace)
  await page.goto('./')
  if (workspace === 'prepare') await plateReady(page)
  else await appReady(page)
  await sliced(page)
  await settle(page)
}

/** A 20 mm cube as ASCII STL. */
function cube(): Buffer {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const facets = f.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((i) => `  vertex ${v[i]!.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')
  return Buffer.from(`solid cube\n${facets}\nendsolid cube\n`)
}

test.describe('no flicker', { tag: '@gpu' }, () => {
  test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
  test.slow()

  test('moving a part and the slice after it change the Prepare view once', async ({ page }, info) => {
    await start(page, 'prepare')
    const view = await boxOf(page, '.vp')
    const panels = { sidebar: await boxOf(page, '.studio .pane[aria-label="Printer and settings"]') }
    const stop = await recordFrames(page)
    await page.evaluate(() => {
      const st = (window as unknown as { __sx: Sx }).__sx
      const [o, ...rest] = st.getState().plate
      const t = [...o!.transform]
      t[12] = t[12]! + 8
      st.setState({ plate: [{ ...o, transform: t }, ...rest] })
    })
    await sliced(page)
    await settle(page)
    await check(page, info, await stop(), view, panels)
  })

  test('a model added and the slice after it never blank the view or pop the panels', async ({ page }, info) => {
    await start(page, 'prepare')
    const view = await boxOf(page, '.vp')
    const panels = { sidebar: await boxOf(page, '.studio .pane[aria-label="Printer and settings"]') }
    const stop = await recordFrames(page)
    const chooser = page.waitForEvent('filechooser')
    await page.getByTestId('objects-add-model').click()
    await (await chooser).setFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: cube() })
    await expect(page.locator('.obj-name')).toHaveCount(2)
    await sliced(page)
    await settle(page)
    // The new model lands and the view frames it; from the first finished-looking frame on, nothing may change back.
    await check(page, info, await stop(), view, panels, true)
  })

  test('a setting change and the slice after it keep the preview drawn', async ({ page }, info) => {
    await start(page, 'preview')
    const view = await boxOf(page, '.vp')
    const panels = { summary: await boxOf(page, '.studio .pane[aria-label="Slice summary and filament"]') }
    const stop = await recordFrames(page)
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ overrides: { sparse_infill_density: '25%' } }))
    await sliced(page)
    await settle(page)
    await check(page, info, await stop(), view, panels)
  })
})
