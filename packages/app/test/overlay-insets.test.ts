// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { OVERLAY_GAP, overlayInsets, type Rect } from '../src/viewport/overlay-insets'

const stage: Rect = { left: 18, top: 100, right: 1112, bottom: 900 }
const legend: Rect = { left: 30, top: 152, right: 275, bottom: 525 }
const strip: Rect = { left: 985, top: 364, right: 1100, bottom: 650 }
const dock: Rect = { left: 30, top: 785, right: 1100, bottom: 900 }
const corner: Rect = { left: 30, top: 112, right: 62, bottom: 144 }

describe('overlay insets', () => {
  it('takes the left for the legend, the right for the strip and the bottom for the bar', () => {
    expect(overlayInsets(stage, [legend, strip, dock])).toEqual({ left: 275 - 18 + OVERLAY_GAP, right: 1112 - 985 + OVERLAY_GAP, top: 0, bottom: 900 - 785 + OVERLAY_GAP })
  })

  it('ignores corner buttons and overlays that are not on the view', () => {
    expect(overlayInsets(stage, [corner, { left: 2000, top: 0, right: 2100, bottom: 50 }])).toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
  })

  it('puts a wide bar at the top on the top', () => {
    expect(overlayInsets(stage, [{ left: 30, top: 104, right: 1100, bottom: 160 }]).top).toBe(160 - 100 + OVERLAY_GAP)
  })

  it('keeps the largest claim on a side', () => {
    expect(overlayInsets(stage, [legend, { left: 30, top: 540, right: 400, bottom: 600 }]).left).toBe(400 - 18 + OVERLAY_GAP)
  })

  it('has nothing to give on an empty stage', () => {
    expect(overlayInsets({ left: 0, top: 0, right: 0, bottom: 0 }, [legend])).toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
  })
})
