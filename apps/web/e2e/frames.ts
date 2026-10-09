// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every frame the browser composites while a step runs (the DevTools screencast), reduced to a grid of gray levels,
// so a spec can find a frame that went blank or a region that popped out and back.
import type { Page } from '@playwright/test'

/** One composited frame: when it was drawn (seconds) and its gray levels, GRID_W by GRID_H cells, row by row. */
export interface Frame {
  t: number
  gray: number[]
  jpeg: string
}

export const GRID_W = 96
export const GRID_H = 60

/**
 * How many times slower this runner draws than the project's own machine, from SX_SLOW_GL (CI sets 3 on GitHub's
 * runners, which draw WebGL in software on 4 cores shared by two workers). Drawing time budgets scale by it; what a
 * spec checks stays the same.
 */
export const GL_SLOW = Math.max(1, Number(process.env['SX_SLOW_GL']) || 1)

/** A region of the page, in CSS pixels. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Records frames from now until the returned stop is called; stop resolves to the frames, oldest first. */
export async function recordFrames(page: Page): Promise<() => Promise<Frame[]>> {
  const cdp = await page.context().newCDPSession(page)
  const raw: { t: number; data: string }[] = []
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    raw.push({ t: f.metadata.timestamp ?? Date.now() / 1000, data: f.data })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  const size = page.viewportSize() ?? { width: 1440, height: 900 }
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 })
  // The screencast starts with the picture as it is; wait for that frame, so the step's first change is recorded after it.
  for (let i = 0; i < 10 && raw.length === 0; i++) await page.waitForTimeout(50)
  // It sends a frame only when the page draws one, and a page already at rest draws none: a nearly clear pixel in the
  // corner, for a moment, makes it draw the picture once.
  if (raw.length === 0) {
    await page
      .evaluate(() => {
        const d = document.createElement('div')
        d.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:rgba(128,128,128,0.02);pointer-events:none;z-index:2147483647'
        document.body.append(d)
        setTimeout(() => d.remove(), 120)
      })
      .catch(() => undefined)
  }
  for (let i = 0; i < 50 && raw.length === 0; i++) await page.waitForTimeout(50)
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    await cdp.detach().catch(() => undefined)
    // Decoding happens in a page of its own, so it never shows in the frames.
    const decoder = await page.context().newPage()
    const grids = await decoder.evaluate(
      async ({ frames, w, h }) => {
        const c = new OffscreenCanvas(w, h)
        const g = c.getContext('2d', { willReadFrequently: true })!
        const out: number[][] = []
        for (const f of frames) {
          const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${f}`)).blob())
          g.drawImage(bmp, 0, 0, w, h)
          const px = g.getImageData(0, 0, w, h).data
          const gray: number[] = []
          for (let i = 0; i < w * h; i++) gray.push(Math.round(0.2126 * px[i * 4]! + 0.7152 * px[i * 4 + 1]! + 0.0722 * px[i * 4 + 2]!))
          out.push(gray)
        }
        return out
      },
      { frames: raw.map((f) => f.data), w: GRID_W, h: GRID_H },
    )
    await decoder.close()
    return raw.map((f, i) => ({ t: f.t, gray: grids[i]!, jpeg: f.data }))
  }
}

/** The grid cells inside a box, given the page size the frames were taken at. */
export function cellsIn(box: Box, page: { width: number; height: number }): number[] {
  const out: number[] = []
  const x0 = Math.floor((box.x / page.width) * GRID_W)
  const x1 = Math.ceil(((box.x + box.width) / page.width) * GRID_W)
  const y0 = Math.floor((box.y / page.height) * GRID_H)
  const y1 = Math.ceil(((box.y + box.height) / page.height) * GRID_H)
  for (let y = Math.max(0, y0); y < Math.min(GRID_H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(GRID_W, x1); x++) out.push(y * GRID_W + x)
  return out
}

/** Mean gray difference between two frames over some cells, 0 to 255. */
export function diff(a: Frame, b: Frame, cells: number[]): number {
  let d = 0
  for (const c of cells) d += Math.abs(a.gray[c]! - b.gray[c]!)
  return cells.length ? d / cells.length : 0
}

/** How much the gray levels vary over some cells: near 0 for a region drawn in one flat color. */
export function spread(f: Frame, cells: number[]): number {
  let m = 0
  for (const c of cells) m += f.gray[c]!
  m /= Math.max(1, cells.length)
  let v = 0
  for (const c of cells) v += (f.gray[c]! - m) ** 2
  return Math.sqrt(v / Math.max(1, cells.length))
}

/** How alike two frames are over some cells, by the pattern of light and dark (Pearson correlation, 1 the same picture). A picture drawn darker keeps its pattern; a cleared or swapped one does not. */
export function alike(a: Frame, b: Frame, cells: number[]): number {
  const n = Math.max(1, cells.length)
  let ma = 0
  let mb = 0
  for (const c of cells) {
    ma += a.gray[c]!
    mb += b.gray[c]!
  }
  ma /= n
  mb /= n
  let ab = 0
  let aa = 0
  let bb = 0
  for (const c of cells) {
    const x = a.gray[c]! - ma
    const y = b.gray[c]! - mb
    ab += x * y
    aa += x * x
    bb += y * y
  }
  return aa === 0 || bb === 0 ? (aa === bb ? 1 : 0) : ab / Math.sqrt(aa * bb)
}

/** Frames whose picture in a region is like neither the first frame's nor the last one's: it was cleared or swapped. */
export function swaps(frames: Frame[], cells: number[], least: number, from = 0): { i: number; t: number; like: number }[] {
  const first = frames[0]
  const last = frames[frames.length - 1]
  if (!first || !last) return []
  return frames.flatMap((f, i) => {
    if (f.t - first.t < from) return []
    const like = Math.max(alike(f, first, cells), alike(f, last, cells))
    return like < least ? [{ i, t: f.t - first.t, like }] : []
  })
}

/**
 * Frames where a region shows something it showed neither before the step nor after it: it differs from the first frame
 * and from the last by more than `limit`. A change that lands once (a value, a moved part) passes; a region that empties,
 * swaps to something else or jumps and comes back does not.
 */
export function pops(frames: Frame[], cells: number[], limit: number, from = 0): { i: number; t: number; fromStart: number; fromEnd: number }[] {
  const first = frames[0]
  const last = frames[frames.length - 1]
  if (!first || !last) return []
  return frames.flatMap((f, i) => {
    if (f.t - first.t < from) return []
    const fromStart = diff(f, first, cells)
    const fromEnd = diff(f, last, cells)
    return Math.min(fromStart, fromEnd) > limit ? [{ i, t: f.t - first.t, fromStart, fromEnd }] : []
  })
}
