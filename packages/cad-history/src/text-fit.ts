// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Does text fit on the face it goes on? Both outlines are in the face's frame (u, v, mm): the text as the engine lays
// it out (shape.profile, with its placement), the face as face.pick returns it. The test compares their extents along
// the text's own axes, turned with it: the text is too wide when its width along its baseline is more than the face's
// width that way, and too tall the same way across it. Text wider than the face's extent runs off the face wherever it
// is placed. The other way round is not certain (a notch or a hole in the face, text placed off center), and a join
// that floats is still refused when it runs.
import type { Polygon, Vec2 } from './types'

/** A text's size against its face, in mm along the text's axes. */
export interface TextFit {
  /** The text's width along its baseline and its height across it. */
  textMm: Vec2
  /** The face's extent along the same two directions. */
  faceMm: Vec2
  wide: boolean
  tall: boolean
  fits: boolean
  /** The letter height the text was laid out at. */
  sizeMm: number
  /** The largest letter height whose text fits both ways, rounded down to `FIT_STEP_MM`; 0 when none does. */
  fitSizeMm: number
}

/** Suggested sizes are whole tenths of a millimeter. */
export const FIT_STEP_MM = 0.1

/** Text this little over the face still counts as fitting, so a size that fills the face exactly is not refused. */
const SLACK_MM = 1e-3

/** The extent of the outlines' outer loops along the axes turned `rotationDeg` from the frame's u (counterclockwise). */
export function extentAlong(polygons: readonly Polygon[], rotationDeg = 0): Vec2 | null {
  const a = (rotationDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  let lo = [Infinity, Infinity]
  let hi = [-Infinity, -Infinity]
  for (const p of polygons) {
    for (const [x, y] of p.outer) {
      const along = c * x + s * y
      const across = -s * x + c * y
      lo = [Math.min(lo[0]!, along), Math.min(lo[1]!, across)]
      hi = [Math.max(hi[0]!, along), Math.max(hi[1]!, across)]
    }
  }
  if (!Number.isFinite(lo[0]!) || !Number.isFinite(hi[0]!)) return null
  return [hi[0]! - lo[0]!, hi[1]! - lo[1]!]
}

/** The largest size on the step at or under `mm`, with no float residue (4.3, not 4.300000000000001). */
const stepDown = (mm: number) => Math.max(0, Math.floor(mm / FIT_STEP_MM + 1e-9) / Math.round(1 / FIT_STEP_MM))

/**
 * Text laid out at `sizeMm` and turned `rotationDeg`, against the face it goes on. Null when either outline is empty
 * (the bed has no outline, and nothing is laid out for empty text). Text scales with its letter height, so the size
 * that fits is the current one times the tighter of the two ratios.
 */
export function textFit(text: readonly Polygon[], face: readonly Polygon[], sizeMm: number, rotationDeg = 0): TextFit | null {
  const t = extentAlong(text, rotationDeg)
  const f = extentAlong(face, rotationDeg)
  if (!t || !f || !(sizeMm > 0)) return null
  const wide = t[0] > f[0] + SLACK_MM
  const tall = t[1] > f[1] + SLACK_MM
  const ratio = Math.min(t[0] > 0 ? f[0] / t[0] : Infinity, t[1] > 0 ? f[1] / t[1] : Infinity)
  return { textMm: t, faceMm: f, wide, tall, fits: !wide && !tall, sizeMm, fitSizeMm: Number.isFinite(ratio) ? stepDown(sizeMm * ratio) : sizeMm }
}

/**
 * `textFit`, with its suggested size laid out again to check it: `layout` lays out the same text, turned and placed
 * the same, at another letter height. A size that still runs over (rounding in the font's outlines) steps down a
 * tenth at a time, a few times at most.
 */
export async function checkedTextFit(layout: (sizeMm: number) => Promise<readonly Polygon[]>, text: readonly Polygon[], face: readonly Polygon[], sizeMm: number, rotationDeg = 0): Promise<TextFit | null> {
  const fit = textFit(text, face, sizeMm, rotationDeg)
  if (!fit || fit.fitSizeMm <= 0) return fit
  let tenths = Math.round(fit.fitSizeMm / FIT_STEP_MM)
  for (let tries = 0; tries < 4 && tenths > 0; tries++) {
    const size = tenths * FIT_STEP_MM
    const again = size === sizeMm ? fit : textFit(await layout(size), face, size, rotationDeg)
    if (!again || again.fits) return { ...fit, fitSizeMm: Math.round(size * 10) / 10 }
    tenths = Math.min(tenths - 1, Math.round(again.fitSizeMm / FIT_STEP_MM))
  }
  return { ...fit, fitSizeMm: Math.max(0, tenths) / 10 }
}

/** A length as the panels show it: tenths, with no trailing ".0". */
const mm = (v: number) => `${String(Math.round(v * 10) / 10)} mm`
const bare = (v: number) => String(Math.round(v * 10) / 10)

/** What the panel says about text that does not fit, or null when it fits. */
export function textFitMessage(fit: TextFit | null): string | null {
  if (!fit || fit.fits) return null
  const sizes = fit.wide && fit.tall
    ? `The text is ${bare(fit.textMm[0])} x ${mm(fit.textMm[1])}; the face is ${bare(fit.faceMm[0])} x ${mm(fit.faceMm[1])}.`
    : fit.wide
      ? `The text is ${mm(fit.textMm[0])} wide; the face is ${mm(fit.faceMm[0])}.`
      : `The text is ${mm(fit.textMm[1])} tall; the face is ${mm(fit.faceMm[1])}.`
  return fit.fitSizeMm > 0 ? `${sizes} A letter height of ${mm(fit.fitSizeMm)} fits.` : `${sizes} Shorten the text to fit it.`
}
