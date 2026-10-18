// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Text on a face says when it is wider or taller than the picked face, with both sizes, and the largest letter height
// that fits, rounded down to a tenth.
import { checkedTextFit, extentAlong, textFit, textFitMessage, type Polygon } from '@slicerx/cad-history'
import { describe, expect, it } from 'vitest'

/** A rectangle centered on (cx, cy), as an outline in face coordinates. */
const rect = (w: number, h: number, cx = 0, cy = 0): Polygon => ({
  outer: [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]],
  holes: [],
})
const face20 = [rect(20, 20)]
/** Text that scales with its letter height as glyphs do: `perMm` wide and `tallPerMm` tall per mm of height. */
const textAt = (sizeMm: number, perMm: number, tallPerMm = 1.2): Polygon[] => [rect(sizeMm * perMm, sizeMm * tallPerMm)]

describe('text fit on a face', () => {
  it('says text that is wider than the face is too wide, with both widths and a size that fits', () => {
    // "SlicerX" at 8 mm is 36.5 mm wide; the face is 20 mm.
    const fit = textFit(textAt(8, 36.5 / 8), face20, 8)!
    expect(fit.wide).toBe(true)
    expect(fit.tall).toBe(false)
    expect(fit.fits).toBe(false)
    expect(fit.textMm[0]).toBeCloseTo(36.5, 6)
    expect(fit.faceMm[0]).toBeCloseTo(20, 6)
    // 8 x 20 / 36.5 = 4.38, rounded down
    expect(fit.fitSizeMm).toBe(4.3)
    expect(textFitMessage(fit)).toBe('The text is 36.5 mm wide; the face is 20 mm. A letter height of 4.3 mm fits.')
  })

  it('says text that is taller than the face is too tall', () => {
    const fit = textFit(textAt(30, 0.5, 1), [rect(40, 12)], 30)!
    expect(fit.wide).toBe(false)
    expect(fit.tall).toBe(true)
    expect(fit.fitSizeMm).toBe(12)
    expect(textFitMessage(fit)).toBe('The text is 30 mm tall; the face is 12 mm. A letter height of 12 mm fits.')
  })

  it('gives both sizes when the text is too wide and too tall, and fits by the tighter one', () => {
    // "AB" at 60 mm: 104.5 x 60 on a 20 mm face
    const fit = textFit([rect(104.5, 60)], face20, 60)!
    expect(fit.wide && fit.tall).toBe(true)
    expect(fit.fitSizeMm).toBe(11.4)
    expect(textFitMessage(fit)).toBe('The text is 104.5 x 60 mm; the face is 20 x 20 mm. A letter height of 11.4 mm fits.')
  })

  it('says nothing for text that fits, and its suggested size is the largest that fits', () => {
    const fit = textFit(textAt(5, 1.2), face20, 5)!
    expect(fit.fits).toBe(true)
    expect(textFitMessage(fit)).toBeNull()
    expect(fit.fitSizeMm).toBe(16.6)
    // text that fills the face exactly fits
    expect(textFit([rect(20, 6)], face20, 5)!.fits).toBe(true)
  })

  it('measures along the text turned on the face, and only by its outer loops', () => {
    // a 40 x 4 mm strip turned 90 degrees stands 40 mm tall in the face's frame, but along its baseline it is still 40 mm
    const strip: Polygon[] = [{ ...rect(4, 40), holes: [rect(1, 1).outer] }]
    expect(extentAlong(strip, 90)![0]).toBeCloseTo(40, 6)
    expect(extentAlong(strip, 90)![1]).toBeCloseTo(4, 6)
    const fit = textFit(strip, [rect(20, 50)], 4, 90)!
    // the face is 50 mm along the turned baseline and 20 mm across it
    expect(fit.faceMm[0]).toBeCloseTo(50, 6)
    expect(fit.fits).toBe(true)
    // the same strip unturned runs off the 20 mm side
    expect(textFit([rect(40, 4)], [rect(20, 50)], 4, 0)!.wide).toBe(true)
  })

  it('has nothing to say without both outlines', () => {
    expect(textFit([], face20, 8)).toBeNull()
    expect(textFit(textAt(8, 4), [], 8)).toBeNull()
    expect(textFitMessage(null)).toBeNull()
  })

  it('checks the suggested size by laying it out again, and steps down while it still runs over', async () => {
    // a font whose outlines grow a little faster than its height: the scaled guess is a tenth too big
    const layout = async (s: number) => textAt(s, 36.5 / 8 + (s < 8 ? 0.1 : 0))
    const fit = (await checkedTextFit(layout, textAt(8, 36.5 / 8), face20, 8))!
    expect(fit.fits).toBe(false)
    expect(fit.fitSizeMm).toBeLessThan(4.3)
    expect(textFit(await layout(fit.fitSizeMm), face20, fit.fitSizeMm)!.fits).toBe(true)
    expect(textFit(await layout(fit.fitSizeMm + 0.1), face20, fit.fitSizeMm + 0.1)!.fits).toBe(false)
    // text that scales exactly keeps the scaled guess
    const exact = (await checkedTextFit(async (s) => textAt(s, 36.5 / 8), textAt(8, 36.5 / 8), face20, 8))!
    expect(exact.fitSizeMm).toBe(4.3)
  })

  it('says to shorten text no size fits', () => {
    const fit = textFit([rect(500, 1)], [rect(0.3, 20)], 1)!
    expect(fit.fitSizeMm).toBe(0)
    expect(textFitMessage(fit)).toBe('The text is 500 mm wide; the face is 0.3 mm. Shorten the text to fit it.')
  })
})
