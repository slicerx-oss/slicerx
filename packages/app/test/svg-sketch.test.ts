// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Import SVG in the sketch tool (cad/svg-sketch.ts): the form sizes and places the artwork through the engine's
// sketch.svg, its loops land in the sketch model as lines, arcs, circles and splines to edit, and finishing puts them
// in the timeline like any drawn sketch.
import { afterEach, describe, expect, it } from 'vitest'
import type { SketchLoop } from '@slicerx/cad-history'
import type { SvgSketch, SvgSketchOptions } from '../src/geom/cad'
import { svgSketchNote, svgSketchProblem, svgToSketch } from '../src/cad/svg-sketch'
import { finishSketch } from '../src/cad/sketches'
import { fromLoops, toLoops } from '../src/cad/sketch-model'
import { createHistory } from '../src/plate/history'
import { appStore } from '../src/state/store'

// what sketch.svg answers for a 40 mm square with a round hole and a leaf of a line, an arc and a spline
const LOOPS: SketchLoop[] = [
  { start: [80, 120], segments: [{ type: 'line', to: [120, 120] }, { type: 'line', to: [120, 80] }, { type: 'line', to: [80, 80] }, { type: 'line', to: [80, 120] }] },
  { type: 'circle', center: [100, 100], diameterMm: 16 },
  { start: [130, 80], segments: [{ type: 'line', to: [150, 80] }, { type: 'arc', to: [150, 100], through: [160, 90] }, { type: 'spline', points: [[140, 104], [133, 95]], to: [130, 80] }] },
]
const reply = (over: Partial<SvgSketch> = {}): SvgSketch => ({
  loops: LOOPS,
  counts: { lines: 5, arcs: 1, splines: 1, circles: 1 },
  sizeMm: [80, 40],
  mmPerUnit: 1,
  check: {
    ok: true,
    polygons: [],
    areaMm2: 1700,
    loops: [
      { index: 0, role: 'outer', areaMm2: 1600, lengthMm: 160 },
      { index: 1, role: 'hole', areaMm2: 201, lengthMm: 50 },
      { index: 2, role: 'outer', areaMm2: 300, lengthMm: 70 },
    ],
    issues: [],
  },
  warnings: [],
  ...over,
})

/** A stand-in for the engine that records what it was asked. */
function engine(r: SvgSketch = reply()) {
  const calls: SvgSketchOptions[] = []
  const run = async (_svg: string, options: SvgSketchOptions) => {
    calls.push(options)
    return { ...r, mmPerUnit: options.scale ?? r.mmPerUnit }
  }
  return { calls, run }
}

const SVG = '<svg viewBox="0 0 80 40" width="80mm"><rect width="40" height="40"/></svg>'

afterEach(() => appStore.setState({ timeline: { bodies: [], items: [], marker: 0 } }))

describe('Import SVG into a sketch', () => {
  it('fits the artwork to a width or height with its middle where asked', async () => {
    const e = engine()
    await svgToSketch(SVG, { size: 'width', value: 60, center: [100, 100] }, e.run)
    await svgToSketch(SVG, { size: 'height', value: 25, center: [0, 0] }, e.run)
    expect(e.calls).toEqual([
      { fitWidthMm: 60, center: [100, 100] },
      { fitHeightMm: 25, center: [0, 0] },
    ])
  })

  it("scales from the file's own size, reading it first only when the scale is not 100%", async () => {
    const own = engine(reply({ mmPerUnit: 0.2645833 }))
    await svgToSketch(SVG, { size: 'scale', value: 100, center: [5, 5] }, own.run)
    expect(own.calls).toEqual([{ center: [5, 5] }])
    const half = engine(reply({ mmPerUnit: 0.5 }))
    const r = await svgToSketch(SVG, { size: 'scale', value: 50, center: [5, 5] }, half.run)
    expect(half.calls).toEqual([{ center: [5, 5] }, { scale: 0.25, center: [5, 5] }])
    expect(r.mmPerUnit).toBe(0.25)
  })

  it('refuses sizes that make no sense before the engine sees them', async () => {
    expect(svgSketchProblem({ size: 'width', value: 0, center: [0, 0] })).toBe('The width must be more than 0 mm.')
    expect(svgSketchProblem({ size: 'scale', value: Number.NaN, center: [0, 0] })).toBe('The scale must be more than 0%.')
    expect(svgSketchProblem({ size: 'height', value: 20_000, center: [0, 0] })).toBe('The height must be 10000 mm or less.')
    expect(svgSketchProblem({ size: 'width', value: 10, center: [Number.NaN, 0] })).toBe('The center must be two numbers in mm.')
    const e = engine()
    await expect(svgToSketch(SVG, { size: 'width', value: -1, center: [0, 0] }, e.run)).rejects.toThrow('more than 0 mm')
    expect(e.calls).toEqual([])
  })

  it('lands as editable lines, arcs, circles and splines that read back the same', () => {
    const drawn = fromLoops(LOOPS)!
    expect(drawn.map((d) => d.kind)).toEqual(['chain', 'circle', 'chain'])
    const leaf = drawn[2]!
    expect(leaf.kind === 'chain' && leaf.closed).toBe(true)
    expect(leaf.kind === 'chain' ? leaf.segs.map((g) => g.kind) : []).toEqual(['line', 'arc', 'spline'])
    expect(toLoops(drawn)).toEqual(LOOPS)
  })

  it('goes into the timeline like any sketch when finished, and undo takes it out', () => {
    const undo = createHistory(appStore)
    const k = finishSketch({ loops: toLoops(fromLoops(LOOPS)!) })
    expect(k.loops).toEqual(LOOPS)
    expect(appStore.getState().timeline.items).toHaveLength(1)
    undo.undo()
    expect(appStore.getState().timeline.items).toHaveLength(0)
    undo.dispose()
  })

  it('says what came in, what to fix and what was left out', () => {
    expect(svgSketchNote('logo.svg', reply())).toEqual({ text: 'Added logo: 3 loops (1 hole), 5 lines, 1 arc, 1 spline, 1 circle, 80 x 40 mm.', warn: false })
    const bad = reply({
      check: { ...reply().check, ok: false, issues: [{ loop: 0, kind: 'loopsCross', message: 'Loops 1 and 3 cross.' }] },
      warnings: ['1 open path with no fill was left out; a sketch loop has to close', '<text> is not supported and was ignored'],
    })
    expect(svgSketchNote('logo.svg', bad)).toEqual({
      text: 'Added logo: 3 loops (1 hole), 5 lines, 1 arc, 1 spline, 1 circle, 80 x 40 mm. 1 problem to fix before it makes a solid. 1 open path with no fill was left out; a sketch loop has to close. <text> is not supported and was ignored.',
      warn: true,
    })
  })
})
