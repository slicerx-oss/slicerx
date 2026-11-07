// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// SVG artwork into the open sketch as loops to edit. The engine's sketch.svg reads the paths and turns them into lines,
// arcs, circles and splines with the holes kept; this sizes the artwork (the file's own size scaled, or fit to a width
// or height) and places its middle, and says what came in.
import { sketchFromSvg, type SvgSketch, type SvgSketchOptions, type Vec2 } from '../geom/cad'

export type SvgSize = 'scale' | 'width' | 'height'

/** What the import section sends. `value` is a percent of the file's size for scale, else mm. */
export interface SvgSketchForm {
  size: SvgSize
  value: number
  center: Vec2
}

export type SvgSketchRunner = (svg: string, options: SvgSketchOptions) => Promise<SvgSketch>

const engine: SvgSketchRunner = (svg, options) => sketchFromSvg(svg, options)

/** Why the form can't import, or null. */
export function svgSketchProblem(form: SvgSketchForm): string | null {
  if (!(form.value > 0) || !Number.isFinite(form.value)) return form.size === 'scale' ? 'The scale must be more than 0%.' : `The ${form.size} must be more than 0 mm.`
  if (form.size !== 'scale' && form.value > 10_000) return `The ${form.size} must be 10000 mm or less.`
  if (!form.center.every(Number.isFinite)) return 'The center must be two numbers in mm.'
  return null
}

/** The artwork as loops, sized and placed. A scale other than 100% reads the file's own size first. */
export async function svgToSketch(svg: string, form: SvgSketchForm, run: SvgSketchRunner = engine): Promise<SvgSketch> {
  const problem = svgSketchProblem(form)
  if (problem) throw new Error(problem)
  const center = form.center
  if (form.size === 'width') return run(svg, { fitWidthMm: form.value, center })
  if (form.size === 'height') return run(svg, { fitHeightMm: form.value, center })
  const own = await run(svg, { center })
  return form.value === 100 ? own : run(svg, { scale: (own.mmPerUnit * form.value) / 100, center })
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const mm = (v: number) => `${Math.round(v * 100) / 100}`

/** What came in, in a line: loops, holes, curves and size, then what to fix and what was left out. */
export function svgSketchNote(name: string, r: SvgSketch): { text: string; warn: boolean } {
  const holes = r.check.loops.filter((l) => l.role === 'hole').length
  const c = r.counts
  const curves = [plural(c.lines, 'line'), plural(c.arcs, 'arc'), plural(c.splines, 'spline'), plural(c.circles, 'circle')].filter((t) => !t.startsWith('0 ')).join(', ')
  const title = name.replace(/\.svg$/i, '') || 'the SVG'
  const head = `Added ${title}: ${plural(r.loops.length, 'loop')}${holes ? ` (${plural(holes, 'hole')})` : ''}, ${curves}, ${mm(r.sizeMm[0])} x ${mm(r.sizeMm[1])} mm.`
  const fix = r.check.ok ? '' : ` ${plural(r.check.issues.length, 'problem')} to fix before it makes a solid.`
  const left = r.warnings.length ? ` ${r.warnings.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('. ')}.` : ''
  return { text: head + fix + left, warn: !r.check.ok || r.warnings.length > 0 }
}
