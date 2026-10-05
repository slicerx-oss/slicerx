// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The G-code line view's data side: a line index over the file's bytes, built in slices so a 50 MB file never
// holds the page, lines decoded only when they scroll into view, and the mapping between G-code lines and
// preview moves (the SXPV extras carry each move's line).
import { SXPV_EXTRA_BYTES, type PreviewBuffers } from '@slicerx/contracts'

/** Line starts of a text file. Line n (1-based) is bytes[starts[n - 1], starts[n]) without its line break. */
export interface LineIndex {
  bytes: Uint8Array
  /** Byte offset of each line's start, then one past the end: length count + 1. */
  starts: Uint32Array
  count: number
}

const NL = 10
const CR = 13

/** Lets the page paint between slices of a long job. */
export const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Indexes the lines of `bytes`. Long files are walked in slices of `sliceBytes`, yielding to the page between
 * them; `signal` stops the walk. The newline search is the native `indexOf`, so a slice costs a few ms.
 */
export async function indexLines(bytes: Uint8Array, opts: { sliceBytes?: number; signal?: AbortSignal; pause?: () => Promise<void> } = {}): Promise<LineIndex> {
  const slice = opts.sliceBytes ?? 4 << 20
  const pause = opts.pause ?? yieldToPage
  // About 30 bytes a line in slicer output; grown on demand.
  let starts = new Uint32Array(Math.max(16, Math.ceil(bytes.length / 24)))
  let n = 0
  let pos = 0
  starts[n++] = 0
  while (pos < bytes.length) {
    const stop = Math.min(bytes.length, pos + slice)
    while (pos < stop) {
      const nl = bytes.indexOf(NL, pos)
      if (nl < 0) {
        pos = bytes.length
        break
      }
      pos = nl + 1
      if (n >= starts.length) {
        const grown = new Uint32Array(starts.length * 2)
        grown.set(starts)
        starts = grown
      }
      starts[n++] = pos
    }
    if (pos < bytes.length) {
      if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError')
      await pause()
    }
  }
  // A file that ends with a line break has no empty last line.
  const count = bytes.length > 0 && starts[n - 1] === bytes.length ? n - 1 : n
  if (n >= starts.length) {
    const grown = new Uint32Array(n + 1)
    grown.set(starts)
    starts = grown
  }
  starts[count] = bytes.length
  return { bytes, starts: starts.subarray(0, count + 1), count: bytes.length === 0 ? 0 : count }
}

const decoder = new TextDecoder()

/** Text of line `n` (1-based), without its line break. Empty outside the file. */
export function lineText(ix: LineIndex, n: number): string {
  if (n < 1 || n > ix.count) return ''
  const a = ix.starts[n - 1] ?? 0
  let b = ix.starts[n] ?? a
  if (b > a && ix.bytes[b - 1] === NL) b--
  if (b > a && ix.bytes[b - 1] === CR) b--
  return decoder.decode(ix.bytes.subarray(a, b))
}

/** G-code line (1-based) of a move, or 0 when the preview has no line numbers. */
export function lineOfSegment(p: PreviewBuffers, segment: number): number {
  if (p.extrasOffset < 0 || segment < 0 || segment >= p.segmentCount) return 0
  return new DataView(p.raw).getUint32(p.extrasOffset + segment * SXPV_EXTRA_BYTES + 4, true)
}

/**
 * The move a G-code line belongs to: the last move whose line is at or before `line`. Moves are written in
 * print order, so their lines rise and a binary search finds it. -1 before the first move or without lines.
 */
export function segmentOfLine(p: PreviewBuffers, line: number): number {
  if (p.extrasOffset < 0 || p.segmentCount === 0) return -1
  const v = new DataView(p.raw)
  const at = (i: number) => v.getUint32(p.extrasOffset + i * SXPV_EXTRA_BYTES + 4, true)
  let lo = 0
  let hi = p.segmentCount - 1
  if (at(0) > line) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (at(mid) <= line) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Layer index of a move. */
export function layerOfSegment(p: PreviewBuffers, segment: number): number {
  let lo = 0
  let hi = p.layerCount - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((p.layerStart[mid] ?? 0) <= segment) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The move at the nozzle for the layer and move sliders: the last one drawn. -1 when nothing is drawn. */
export function currentSegment(p: PreviewBuffers, layerHi: number, moveCut: number): number {
  if (p.layerCount === 0 || layerHi < 1) return -1
  const top = Math.min(layerHi, p.layerCount) - 1
  const a = p.layerStart[top] ?? 0
  const b = p.layerStart[top + 1] ?? p.segmentCount
  // The same rounding the viewport host uses for the move cut.
  const to = moveCut >= 1 ? b : a + Math.round((b - a) * moveCut)
  return to > 0 ? to - 1 : -1
}

/** Layer and move sliders that put `segment` at the nozzle: the inverse of currentSegment. */
export function slidersFor(p: PreviewBuffers, segment: number): { layerHi: number; moveCut: number } {
  const layer = layerOfSegment(p, segment)
  const a = p.layerStart[layer] ?? 0
  const b = p.layerStart[layer + 1] ?? p.segmentCount
  const k = segment - a + 1
  return { layerHi: layer + 1, moveCut: k >= b - a ? 1 : k / Math.max(1, b - a) }
}

/**
 * Virtual scrolling past the browser's element height limit. Up to `maxPx` the list is its real height; above it
 * the scroll range is scaled, so the scroll bar still spans the whole file.
 */
export interface Scroller {
  rowPx: number
  /** Height of the scrolling spacer element. */
  spacerPx: number
  /** First line (1-based, may be fractional) at the top of the view for a scroll offset. */
  lineAt(scrollTop: number, viewPx: number): number
  /** Scroll offset that puts line `n` at the top of the view. */
  scrollFor(n: number, viewPx: number): number
}

export function scroller(count: number, rowPx: number, maxPx = 8_000_000): Scroller {
  const real = count * rowPx
  const spacerPx = Math.min(real, maxPx)
  const scaled = real > maxPx
  return {
    rowPx,
    spacerPx,
    lineAt(scrollTop, viewPx) {
      if (!scaled) return 1 + scrollTop / rowPx
      const range = Math.max(1, spacerPx - viewPx)
      const lines = Math.max(0, count - viewPx / rowPx)
      return 1 + (Math.min(range, Math.max(0, scrollTop)) / range) * lines
    },
    scrollFor(n, viewPx) {
      if (!scaled) return Math.max(0, (n - 1) * rowPx)
      const range = Math.max(1, spacerPx - viewPx)
      const lines = Math.max(1, count - viewPx / rowPx)
      return Math.max(0, Math.min(range, ((n - 1) / lines) * range))
    },
  }
}
