// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { OVERLAY_GAP, overlayBottom, TOAST_ROOM, toastPlace } from '../src/lib/overlay-offset'

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
    // Just room enough for a toast above the bar.
    expect(overlayBottom(phone, [rect(TOAST_ROOM + 2 * OVERLAY_GAP, 40, 366)], 844)).toBe(844 - TOAST_ROOM - OVERLAY_GAP)
  })

  it('measures from the window bottom when the viewport runs past it', () => {
    expect(overlayBottom(rect(0, 1200, 390), [], 844)).toBe(OVERLAY_GAP)
  })

  const box = (left: number, top: number, width: number, height: number) => ({ top, bottom: top + height, height, width, left, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly

  it('on a phone keeps to the room left of the layer slider, between the view switch and the bars', () => {
    // The phone viewport with the toolpaths: view switch at the top, slider down the right, playback panel below.
    const vp = box(17, 70, 356, 620)
    const place = toastPlace(vp, { bottom: [box(29, 400, 330, 40), box(29, 430, 330, 250)], top: [box(97, 82, 196, 36)], side: [box(245, 272, 115, 160)] }, 844)
    expect(place).toEqual({ bottom: 844 - 400 + OVERLAY_GAP, center: Math.round((17 + OVERLAY_GAP + 245 - OVERLAY_GAP) / 2), width: 245 - OVERLAY_GAP - 17 - OVERLAY_GAP })
  })

  it('goes under the top controls when there is no room above the bars', () => {
    const vp = box(0, 0, 800, 300)
    const place = toastPlace(vp, { bottom: [box(12, 200, 300, 40)], top: [box(300, 12, 200, 160)] }, 300)
    expect(place).toEqual({ top: 172 + OVERLAY_GAP, center: 400 })
  })

  it('a hidden control takes no room', () => {
    const vp = box(0, 0, 800, 600)
    expect(toastPlace(vp, { bottom: [box(12, 548, 300, 40)], top: [box(0, 0, 0, 0)], side: [box(0, 0, 0, 0)] }, 600)).toEqual({ bottom: 600 - 548 + OVERLAY_GAP, center: 400 })
  })

  it('keeps to the room right of the color legend', () => {
    const vp = box(433, 69, 677, 786)
    const place = toastPlace(vp, { bottom: [box(445, 560, 300, 36)], top: [box(608, 125, 317, 40)], left: [box(445, 220, 170, 330)] }, 900)
    expect(place).toEqual({ bottom: 900 - 560 + OVERLAY_GAP, center: Math.round((615 + OVERLAY_GAP + 1110 - OVERLAY_GAP) / 2), width: 1110 - OVERLAY_GAP - 615 - OVERLAY_GAP })
  })
})
