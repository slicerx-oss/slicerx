// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { OVERLAY_GAP, overlayBottom, TOAST_ROOM } from '../src/lib/overlay-offset'

const rect = (top: number, height: number, width = 100) => ({ top, bottom: top + height, height, width, left: 0, right: width, x: 0, y: top, toJSON: () => ({}) }) as DOMRectReadOnly

describe('where toasts sit', () => {
  const viewport = rect(52, 848, 1100)

  it('clears the tallest bottom overlay', () => {
    // The plate bar is 40 px tall, 12 px off the viewport bottom at 900.
    expect(overlayBottom(viewport, [rect(848, 40)], 900)).toBe(900 - 848 + OVERLAY_GAP)
    // With the playback bar higher up, it wins.
    expect(overlayBottom(viewport, [rect(848, 40), rect(700, 188)], 900)).toBe(900 - 700 + OVERLAY_GAP)
  })

  it('ignores hidden overlays and sits on the viewport edge with none', () => {
    expect(overlayBottom(viewport, [rect(600, 0, 0)], 900)).toBe(OVERLAY_GAP)
    expect(overlayBottom(viewport, [], 900)).toBe(OVERLAY_GAP)
  })

  it('keeps the default place when the viewport is scrolled off a phone screen', () => {
    // A phone: the viewport is the top 490 px of the page, the plate bar 40 px tall near its bottom.
    const phone = rect(0, 490, 390)
    expect(overlayBottom(phone, [rect(438, 40, 366)], 844)).toBe(844 - 438 + OVERLAY_GAP)
    // Scrolled 420 px down: the plate bar's top is 18 px from the window top, no room for a toast above it.
    expect(overlayBottom(rect(-420, 490, 390), [rect(18, 40, 366)], 844)).toBeNull()
    // Scrolled past it entirely.
    expect(overlayBottom(rect(-600, 490, 390), [rect(-162, 40, 366)], 844)).toBeNull()
    expect(overlayBottom(phone, [rect(TOAST_ROOM + OVERLAY_GAP, 40, 366)], 844)).toBe(844 - TOAST_ROOM)
  })

  it('measures from the window bottom when the viewport runs past it', () => {
    expect(overlayBottom(rect(0, 1200, 390), [], 844)).toBe(OVERLAY_GAP)
  })
})
