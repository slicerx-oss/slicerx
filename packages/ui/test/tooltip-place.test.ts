// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip on a row of a stacked list (the Preview legend's markers) opens beside the list or above the row, so the
// next row stays in view; a tip anywhere else keeps its side.
import { describe, expect, it } from 'vitest'
import { place, stackedRow, type Rect } from '../src/components/tooltip'

const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height, right: left + width, bottom: top + height })
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const tipBox = (p: { x: number; y: number }, t: { w: number; h: number }) => box(p.x, p.y, t.w, t.h)

// the legend floats over the view at its left, a row of marker boxes inside it
const legend = box(433, 180, 168, 380)
const seams = box(445, 322, 145, 18)
const next = box(445, 342, 145, 18)
const loopTip = { w: 320, h: 240 }
const widened = (r: Rect, l: Rect): Rect => box(l.left, r.top, l.width, r.height)

describe('tip placement beside a stacked list', () => {
  it('counts a full-width row of a tall list as a stacked row, and a chip in a row of chips as not', () => {
    expect(stackedRow(seams, legend)).toBe(true)
    expect(stackedRow(box(0, 0, 60, 24), box(0, 0, 400, 24))).toBe(false)
    expect(stackedRow(box(0, 0, 90, 120), box(0, 0, 400, 400))).toBe(false)
  })

  it('opens beside the legend at 1440, clear of the next row and of the whole list', () => {
    const view = { w: 1440, h: 900 }
    const p = place(widened(seams, legend), loopTip, 'right', view, true)
    expect(p.side).toBe('right')
    expect(overlaps(tipBox(p, loopTip), next)).toBe(false)
    expect(overlaps(tipBox(p, loopTip), legend)).toBe(false)
  })

  it('opens above the row, not over the rows below, when there is no room beside the list', () => {
    const view = { w: 390, h: 844 }
    const list = box(16, 300, 358, 380)
    const row = box(28, 500, 334, 18)
    const below = box(28, 520, 334, 18)
    const t = { w: 300, h: 160 }
    const p = place(widened(row, list), t, 'right', view, true)
    expect(p.side).toBe('top')
    expect(overlaps(tipBox(p, t), below)).toBe(false)
    expect(overlaps(tipBox(p, t), row)).toBe(false)
  })

  it('keeps the old order for any other anchor: below first when a side does not fit', () => {
    const view = { w: 390, h: 844 }
    const anchor = box(28, 300, 334, 18)
    const t = { w: 300, h: 160 }
    expect(place(anchor, t, 'right', view).side).toBe('bottom')
    expect(place(box(600, 100, 40, 24), t, 'bottom', { w: 1440, h: 900 }).side).toBe('bottom')
  })
})
