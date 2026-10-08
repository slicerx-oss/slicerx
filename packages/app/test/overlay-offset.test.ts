// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { OVERLAY_GAP, overlayBottom } from '../src/lib/overlay-offset'

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
})
