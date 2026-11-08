// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A PNG or JPEG traced into the open sketch as loops to edit. The engine's sketch.trace finds the inside (dark, light,
// opaque or picked colors), cleans away specks and fits lines, arcs and splines to the edges; this turns the dialog's
// form into its options, checks the form, and says what came in.
import { sketchFromImage, type SketchTrace, type SketchTraceImage, type SketchTraceOptions, type Vec2 } from '../geom/cad'

export type TraceMode = 'auto' | 'dark' | 'light' | 'color'
export type TraceFit = 'lines' | 'arcs' | 'curves'
export type TraceSize = 'width' | 'height' | 'pixel'

/** What the dialog sends. Sizes are mm; `value` is mm per pixel for a pixel size. */
export interface TraceForm {
  mode: TraceMode
  /** Luminance 0 to 255, or null for the automatic split. */
  threshold: number | null
  /** `#rrggbb`, for the color mode. */
  colors: string[]
  tolerance: number
  speckMm2: number
  /** mm, or null for half a working pixel. */
  smoothingMm: number | null
  fit: TraceFit
  cornerDeg: number
  size: TraceSize
  value: number
  center: Vec2
}

/** The most colors picked at once. */
export const MAX_PICKS = 8
/** A PNG or JPEG past this size is refused before it is read. */
export const TRACE_MAX_BYTES = 30 * 1024 * 1024
/** The preview's working size; Add uses the full one. */
export const PREVIEW_SIDE = 1024
export const WORKING_SIDE = 2048

export type TraceRunner = (image: SketchTraceImage, options: SketchTraceOptions, signal?: AbortSignal) => Promise<SketchTrace>

const engine: TraceRunner = (image, options, signal) => sketchFromImage(image, options, signal)

export function defaultTraceForm(center: Vec2): TraceForm {
  return { mode: 'auto', threshold: null, colors: [], tolerance: 12, speckMm2: 0.5, smoothingMm: null, fit: 'curves', cornerDeg: 50, size: 'width', value: 50, center }
}

const finite = (v: number) => Number.isFinite(v)

/** Why the form can't trace, or null. */
export function traceProblem(form: TraceForm): string | null {
  if (form.mode === 'color' && form.colors.length === 0) return 'Click the image to pick a color to trace.'
  if (form.colors.length > MAX_PICKS) return `Pick at most ${MAX_PICKS} colors.`
  if (form.threshold !== null && !(finite(form.threshold) && form.threshold >= 0 && form.threshold <= 255)) return 'The threshold must be 0 to 255.'
  if (!(finite(form.tolerance) && form.tolerance >= 0 && form.tolerance <= 100)) return 'The tolerance must be 0 to 100.'
  if (!(finite(form.speckMm2) && form.speckMm2 >= 0)) return 'Remove specks under must be 0 mm² or more.'
  if (form.smoothingMm !== null && !(finite(form.smoothingMm) && form.smoothingMm >= 0.01 && form.smoothingMm <= 10)) return 'Smoothing must be 0.01 to 10 mm.'
  if (!(finite(form.cornerDeg) && form.cornerDeg >= 1 && form.cornerDeg <= 179)) return 'The corner angle must be 1 to 179°.'
  if (!(finite(form.value) && form.value > 0)) return form.size === 'pixel' ? 'The pixel size must be more than 0 mm.' : `The ${form.size} must be more than 0 mm.`
  if (form.size === 'pixel' ? form.value > 100 : form.value > 10_000) return form.size === 'pixel' ? 'The pixel size must be 100 mm or less.' : `The ${form.size} must be 10000 mm or less.`
  if (!form.center.every(finite)) return 'The center must be two numbers in mm.'
  return null
}

/** The engine's options for the form, at a working size. */
export function traceOptions(form: TraceForm, maxSidePx: number): SketchTraceOptions {
  const size = form.size === 'width' ? { widthMm: form.value } : form.size === 'height' ? { heightMm: form.value } : { mmPerPx: form.value }
  return {
    mode: form.mode,
    ...(form.mode === 'dark' || form.mode === 'light' ? (form.threshold === null ? {} : { threshold: form.threshold }) : {}),
    ...(form.mode === 'color' ? { colors: form.colors, colorTolerance: form.tolerance } : {}),
    speckMm2: form.speckMm2,
    ...(form.smoothingMm === null ? {} : { smoothingMm: form.smoothingMm }),
    fit: form.fit,
    cornerAngleDeg: form.cornerDeg,
    ...size,
    center: form.center,
    maxSidePx,
  }
}

/** The image traced with the form, refused first when the form has a problem. */
export async function traceImage(image: SketchTraceImage, form: TraceForm, maxSidePx: number, run: TraceRunner = engine, signal?: AbortSignal): Promise<SketchTrace> {
  const problem = traceProblem(form)
  if (problem) throw new Error(problem)
  return run(image, traceOptions(form, maxSidePx), signal)
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const mm = (v: number) => `${Math.round(v * 100) / 100}`

/** The count line: "3 loops (1 hole), 14 lines, 6 arcs, 2 splines, 50 x 31.4 mm". */
export function traceCounts(r: SketchTrace): string {
  const holes = r.check.loops.filter((l) => l.role === 'hole').length
  const c = r.counts
  const curves = [plural(c.lines, 'line'), plural(c.arcs, 'arc'), plural(c.splines, 'spline'), plural(c.circles, 'circle')].filter((t) => !t.startsWith('0 '))
  return [`${plural(r.loops.length, 'loop')}${holes ? ` (${plural(holes, 'hole')})` : ''}`, ...curves, `${mm(r.sizeMm[0])} x ${mm(r.sizeMm[1])} mm`].join(', ')
}

/** What came in, for the toast: the count line, what was cleaned away, then what to fix. */
export function traceNote(name: string, r: SketchTrace): { text: string; warn: boolean } {
  const title = name.replace(/\.(png|jpe?g)$/i, '') || 'the image'
  const d = r.dropped
  const cleaned = d.specks || d.holes ? ` Removed ${[d.specks ? plural(d.specks, 'speck') : '', d.holes ? plural(d.holes, 'pinhole') : ''].filter(Boolean).join(' and ')}.` : ''
  const fix = r.check.ok ? '' : ` ${plural(r.check.issues.length, 'problem')} to fix before it makes a solid.`
  const left = r.warnings.length ? ` ${r.warnings.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('. ')}.` : ''
  return { text: `Added ${title}: ${traceCounts(r)}.${cleaned}${fix}${left}`, warn: !r.check.ok || r.warnings.length > 0 }
}

/** A chosen file's bytes, or why it can't be traced. */
export async function readImageFile(f: File): Promise<{ name: string; bytes: Uint8Array }> {
  if (f.size > TRACE_MAX_BYTES) throw new Error('The image is larger than 30 MB. Export it smaller first.')
  const bytes = new Uint8Array(await f.arrayBuffer().catch(() => {
    throw new Error('The file could not be read.')
  }))
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
  if (!png && !jpeg) throw new Error('That file is not a PNG or JPEG image.')
  return { name: f.name, bytes }
}

/** Bytes as base64, in pieces so a large file never goes through one call's arguments. */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** `#rrggbb` of a pixel. */
export function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Sketch mm back to the working image's pixels (y down), for drawing the loops over the preview. */
export function mmToImage(r: SketchTrace, p: Vec2): Vec2 {
  const [k, dx, dy] = r.pxToMm
  return [(p[0] - dx) / k, r.workingPx[1] - (p[1] - dy) / k]
}
