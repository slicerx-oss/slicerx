// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension boxes on the shape, without the engine: which shapes get which boxes, the dimension each box sets,
// where the boxes go on screen (outside the shape, clear of each other, inside the view), the drawing moved toward a
// typed size before the solve, and the sizes a typed shape keeps.
import { describe, expect, it } from 'vitest'
import { allShapes, boxesOf, boxesState, boxIndex, boxKeyOf, BOX_GAP, BOX_INSET, boxProblem, constraintFor, draftShape, isRect, keptShape, onShapeTool, placeBoxes, placedShape, seeded, shapeAt, typedConstraints, type BoxSpot } from '../src/cad/sketch-boxes'
import { toSolver, X_AXIS, dimMark, type SketchConstraint } from '../src/cad/sketch-constraints'
import { measured } from '../src/cad/sketch-dimension'
import { click, emptyDraft, rectangle, type Entity, type V2 } from '../src/cad/sketch-model'

const rect = (): Entity[] => [rectangle([10, 10], [30, 20])]
const line = (): Entity[] => [{ kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [10, 0] }, { kind: 'line', to: [10, 10] }], closed: false }]
const circle = (): Entity[] => [{ kind: 'circle', center: [5, 5], diameterMm: 8 }]
const size = { w: 110, h: 28 }
const sizes = { width: size, height: size, length: size, angle: size, diameter: size }
const box = (spots: BoxSpot[], key: string) => spots.find((s) => s.key === key)!
const overlap = (a: BoxSpot, b: BoxSpot) => a.left < b.left + size.w && b.left < a.left + size.w && a.top < b.top + size.h && b.top < a.top + size.h

describe('which boxes a shape has', () => {
  it('gives a rectangle Width and Height, a line Length and Angle, a circle Diameter', () => {
    expect(shapeAt(rect(), { e: 0, seg: 2 })).toEqual({ kind: 'rect', e: 0 })
    expect(shapeAt(line(), { e: 0, seg: 1 })).toEqual({ kind: 'line', e: 0, seg: 1 })
    expect(shapeAt(circle(), { e: 0, seg: 0 })).toEqual({ kind: 'circle', e: 0 })
    expect(boxesOf('rect').map((b) => b.label)).toEqual(['Width', 'Height'])
    expect(boxesOf('line').map((b) => [b.label, b.unit])).toEqual([['Length', 'mm'], ['Angle', '°']])
    expect(boxesOf('circle').map((b) => b.label)).toEqual(['Diameter'])
    expect(boxKeyOf('Width')).toBe('width')
    expect(boxKeyOf('X')).toBeNull()
  })

  it('gives none to an arc, a construction curve or nothing picked', () => {
    const arc: Entity[] = [{ kind: 'chain', start: [0, 0], segs: [{ kind: 'arc', to: [10, 0], through: [5, 5] }], closed: false }]
    expect(shapeAt(arc, { e: 0, seg: 0 })).toBeNull()
    expect(shapeAt([{ ...circle()[0]!, construction: true }], { e: 0, seg: 0 })).toBeNull()
    expect(shapeAt(rect(), null)).toBeNull()
  })

  it('takes a closed square-cornered four-line loop as a rectangle, turned or not, and nothing else', () => {
    const turned: Entity[] = [{ kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [3, 4] }, { kind: 'line', to: [-1, 7] }, { kind: 'line', to: [-4, 3] }, { kind: 'line', to: [0, 0] }], closed: true }]
    expect(isRect(turned, 0)).toBe(true)
    const skew: Entity[] = [{ kind: 'chain', start: [0, 0], segs: [{ kind: 'line', to: [10, 0] }, { kind: 'line', to: [12, 5] }, { kind: 'line', to: [0, 5] }, { kind: 'line', to: [0, 0] }], closed: true }]
    expect(isRect(skew, 0)).toBe(false)
    // a skewed loop's sides are lines with Length and Angle
    expect(shapeAt(skew, { e: 0, seg: 1 })).toEqual({ kind: 'line', e: 0, seg: 1 })
    expect(allShapes([...rect(), ...line(), ...circle()])).toEqual([{ kind: 'rect', e: 0 }, { kind: 'line', e: 1, seg: 0 }, { kind: 'line', e: 1, seg: 1 }, { kind: 'circle', e: 2 }])
  })
})

describe('the dimension a box sets', () => {
  it('maps Width and Height to the first two sides, Length to the line, Angle from the X axis and Diameter to the circle', () => {
    expect(constraintFor({ kind: 'rect', e: 0 }, 'width', 25)).toEqual({ type: 'length', line: { e: 0, seg: 0 }, value: 25 })
    expect(constraintFor({ kind: 'rect', e: 0 }, 'height', 12)).toEqual({ type: 'length', line: { e: 0, seg: 1 }, value: 12 })
    expect(constraintFor({ kind: 'line', e: 2, seg: 1 }, 'length', 7.5)).toEqual({ type: 'length', line: { e: 2, seg: 1 }, value: 7.5 })
    expect(constraintFor({ kind: 'line', e: 2, seg: 1 }, 'angle', -30)).toEqual({ type: 'angle', a: X_AXIS, b: { e: 2, seg: 1 }, value: 330 })
    expect(constraintFor({ kind: 'circle', e: 1 }, 'diameter', 6)).toEqual({ type: 'diameter', circle: { e: 1, seg: 0 }, value: 6 })
    expect(constraintFor({ kind: 'circle', e: 1 }, 'width', 6)).toBeNull()
  })

  it('finds a box dimension already there, a rectangle top or left side included', () => {
    const cons: SketchConstraint[] = [{ type: 'horizontal', line: { e: 0, seg: 0 } }, { type: 'length', line: { e: 0, seg: 2 }, value: 20 }, { type: 'length', line: { e: 0, seg: 1 }, value: 10, driven: true }]
    expect(boxIndex(rect(), cons, { kind: 'rect', e: 0 }, 'width')).toBe(1)
    expect(boxIndex(rect(), cons, { kind: 'rect', e: 0 }, 'height')).toBe(2)
    expect(boxIndex(line(), [{ type: 'angle', a: X_AXIS, b: { e: 0, seg: 1 }, value: 90 }], { kind: 'line', e: 0, seg: 1 }, 'angle')).toBe(0)
    expect(boxIndex(line(), [{ type: 'angle', a: X_AXIS, b: { e: 0, seg: 1 }, value: 90 }], { kind: 'line', e: 0, seg: 0 }, 'angle')).toBe(-1)
  })

  it('reads each box: the driving value, else the size as drawn, and says what sets it', () => {
    const cons: SketchConstraint[] = [{ type: 'length', line: { e: 0, seg: 0 }, value: 25 }, { type: 'length', line: { e: 0, seg: 1 }, value: 10, driven: true }]
    const s = boxesState(rect(), cons, 2)
    expect(s.dof).toBe(2)
    expect(s.shapes[0]).toEqual({
      shape: 'rectangle',
      loop: 0,
      boxes: [
        { box: 'width', label: 'Width', value: 25, unit: 'mm', set: 'driving' },
        { box: 'height', label: 'Height', value: 10, unit: 'mm', set: 'driven' },
      ],
    })
    expect(s.dimensions).toEqual([{ index: 0, type: 'length', value: 25, driven: false }, { index: 1, type: 'length', value: 10, driven: true }])
    const free = boxesState(line(), [], null)
    expect(free.shapes[1]!.boxes).toEqual([
      { box: 'length', label: 'Length', value: 10, unit: 'mm', set: null },
      { box: 'angle', label: 'Angle', value: 90, unit: 'deg', set: null },
    ])
  })

  it('refuses a size of 0 or less, any angle is fine', () => {
    expect(boxProblem('width', 0)).toMatch(/more than 0/)
    expect(boxProblem('diameter', -2)).toMatch(/more than 0/)
    expect(boxProblem('angle', -45)).toBeNull()
    expect(boxProblem('length', NaN)).toBe('Type a number.')
  })
})

describe('the X axis for a line angle', () => {
  it('goes into the solve as a held line from the origin, only when an angle names it', () => {
    const plain = toSolver(line(), [{ type: 'length', line: { e: 0, seg: 0 }, value: 5 }])
    expect(plain.solver.entities).toHaveLength(2)
    const { solver, map } = toSolver(line(), [{ type: 'angle', a: X_AXIS, b: { e: 0, seg: 1 }, value: 60 }])
    // the chain's two lines, then the axis from the origin (0, 0) to (1, 0), both ends fixed
    expect(solver.entities[2]).toEqual({ type: 'line', a: 3, b: 4 })
    expect(solver.points.slice(3)).toEqual([[0, 0], [1, 0]])
    expect(solver.constraints).toEqual([{ type: 'angle', a: 2, b: 1, value: 60 }, { type: 'fix', point: 3 }, { type: 'fix', point: 4 }])
    expect(map.from).toEqual([0, -1, -1])
  })

  it('measures and draws an angle from the axis at the line start', () => {
    const c: SketchConstraint = { type: 'angle', a: X_AXIS, b: { e: 0, seg: 1 }, value: 90 }
    expect(measured(line(), c)).toBeCloseTo(90)
    const m = dimMark(line(), c, 90, 0)!
    expect(m.label).toBe('90°')
    expect(m.from[1]).toBeCloseTo(0)
    expect(m.from[0]).toBeGreaterThan(10)
    expect(m.to[0]).toBeCloseTo(10)
    expect(m.to[1]).toBeGreaterThan(0)
  })
})

describe('where the boxes go', () => {
  // a 200 by 100 px rectangle; screen y runs down, so the plane's first side is the bottom one
  const corners: [V2, V2, V2, V2] = [[100, 300], [300, 300], [300, 200], [100, 200]]

  it('puts Width under the bottom side and Height right of the right side, outside the shape, centered on them', () => {
    const spots = placeBoxes({ kind: 'rect', corners }, sizes, null)
    const w = box(spots, 'width')
    const h = box(spots, 'height')
    expect(w.top).toBe(300 + BOX_GAP)
    expect(w.left + size.w / 2).toBe(200)
    expect(h.left).toBe(300 + BOX_GAP)
    expect(h.top + size.h / 2).toBe(250)
    expect(overlap(w, h)).toBe(false)
  })

  it('keeps the boxes outside a rectangle drawn the other way round or turned', () => {
    // drawn up and to the left: the same sides, the boxes still outside
    const flipped = placeBoxes({ kind: 'rect', corners: [[300, 200], [100, 200], [100, 300], [300, 300]] }, sizes, null)
    expect(box(flipped, 'width').top + size.h).toBe(200 - BOX_GAP)
    expect(box(flipped, 'height').left + size.w).toBe(100 - BOX_GAP)
    // turned 45 degrees: each box center sits outside, off the middle of its side
    const turned = placeBoxes({ kind: 'rect', corners: [[200, 300], [300, 200], [200, 100], [100, 200]] }, sizes, null)
    const wc: V2 = [box(turned, 'width').left + size.w / 2, box(turned, 'width').top + size.h / 2]
    expect(wc[0]).toBeGreaterThan(250)
    expect(wc[1]).toBeGreaterThan(250)
  })

  it('puts Length beside the middle of a line, above it, and Angle past its start', () => {
    const spots = placeBoxes({ kind: 'line', a: [100, 200], b: [400, 200] }, sizes, null)
    const l = box(spots, 'length')
    const g = box(spots, 'angle')
    expect(l.left + size.w / 2).toBe(250)
    expect(l.top + size.h).toBe(200 - BOX_GAP)
    expect(g.left + size.w).toBe(100 - BOX_GAP)
    expect(overlap(l, g)).toBe(false)
    // a line drawn right to left keeps Length above it, and Angle past its own start
    const back = placeBoxes({ kind: 'line', a: [400, 200], b: [100, 200] }, sizes, null)
    expect(box(back, 'length').top + size.h).toBe(200 - BOX_GAP)
    expect(box(back, 'angle').left).toBe(400 + BOX_GAP)
  })

  it('puts Diameter beside the radius line, clear of the center', () => {
    const [d] = placeBoxes({ kind: 'circle', center: [200, 200], rim: [260, 200] }, sizes, null)
    expect(d!.left + size.w / 2).toBe(230)
    expect(d!.top + size.h).toBe(200 - BOX_GAP)
  })

  it('keeps the two boxes of a rectangle with no size yet apart and off its corner', () => {
    const p: V2 = [200, 200]
    const spots = placeBoxes({ kind: 'rect', corners: [p, p, p, p] }, sizes, null)
    expect(overlap(box(spots, 'width'), box(spots, 'height'))).toBe(false)
    expect(box(spots, 'width').top).toBe(200 + BOX_GAP)
    expect(box(spots, 'height').top + size.h).toBe(200 - BOX_GAP)
  })

  it('steps a box aside where two would meet at the corner of a small shape', () => {
    const small = placeBoxes({ kind: 'rect', corners: [[100, 130], [130, 130], [130, 110], [100, 110]] }, sizes, null)
    expect(overlap(box(small, 'width'), box(small, 'height'))).toBe(false)
    // Width stays centered under its side; Height moves up beside the right side
    expect(box(small, 'width').left + size.w / 2).toBe(115)
    expect(box(small, 'height').left).toBe(130 + BOX_GAP)
    const short = placeBoxes({ kind: 'line', a: [100, 200], b: [104, 199] }, sizes, null)
    expect(overlap(box(short, 'length'), box(short, 'angle'))).toBe(false)
  })

  it('keeps every box inside the view', () => {
    const area = { left: 0, top: 50, right: 500, bottom: 400 }
    const spots = placeBoxes({ kind: 'rect', corners: [[420, 395], [495, 395], [495, 340], [420, 340]] }, sizes, area)
    for (const s of spots) {
      expect(s.left).toBeGreaterThanOrEqual(area.left + BOX_INSET)
      expect(s.top).toBeGreaterThanOrEqual(area.top + BOX_INSET)
      expect(s.left + size.w).toBeLessThanOrEqual(area.right - BOX_INSET)
      expect(s.top + size.h).toBeLessThanOrEqual(area.bottom - BOX_INSET)
    }
  })
})

describe('boxes clear of the floating controls', () => {
  const area = { left: 0, top: 0, right: 390, bottom: 700 }
  // the undo group at the view's top right, 44 px buttons
  const undo = { left: 290, top: 100, right: 386, bottom: 148 }
  const overlaps = (s: BoxSpot, r: typeof undo) => s.left < r.right && r.left < s.left + size.w && s.top < r.bottom && r.top < s.top + size.h

  it('moves a box off a control it would partly cover, the shortest way, and keeps it inside the view', () => {
    // Height would sit right of the rectangle's right side, under the undo group
    const corners: [V2, V2, V2, V2] = [[200, 160], [260, 160], [260, 110], [200, 110]]
    const without = placeBoxes({ kind: 'rect', corners }, sizes, area)
    expect(overlaps(box(without, 'height'), undo)).toBe(true)
    const spots = placeBoxes({ kind: 'rect', corners }, sizes, area, [undo])
    for (const s of spots) {
      expect(overlaps(s, undo)).toBe(false)
      expect(s.left).toBeGreaterThanOrEqual(area.left + BOX_INSET)
      expect(s.left + size.w).toBeLessThanOrEqual(area.right - BOX_INSET)
      expect(s.top).toBeGreaterThanOrEqual(area.top + BOX_INSET)
    }
    expect(overlap(box(spots, 'width'), box(spots, 'height'))).toBe(false)
  })

  it('steps off the control it covers even when it also grazes the one beside it', () => {
    // the phone's first tap: a box under the view buttons' column by a fraction of a pixel and over the undo group
    const buttons = { left: 334, top: 164, right: 378, bottom: 208 }
    const phoneUndo = { left: 282, top: 216, right: 378, bottom: 266 }
    const p: V2 = [270.29, 188.1]
    const spots = placeBoxes({ kind: 'rect', corners: [p, p, p, p] }, { width: { w: 128, h: 44 }, height: { w: 130, h: 44 } }, { left: 0, top: 48, right: 390, bottom: 844 }, [buttons, phoneUndo])
    const w = box(spots, 'width')
    expect(w.left + 128 <= phoneUndo.left).toBe(true)
    for (const s of spots) expect(s.left < buttons.right && buttons.left < s.left + 130 && s.top < buttons.bottom && buttons.top < s.top + 44).toBe(false)
  })

  it('leaves a box where it is when no control is near it', () => {
    const corners: [V2, V2, V2, V2] = [[100, 400], [160, 400], [160, 350], [100, 350]]
    expect(placeBoxes({ kind: 'rect', corners }, sizes, area, [undo])).toEqual(placeBoxes({ kind: 'rect', corners }, sizes, area))
  })

  it('keeps boxes apart from each other after one steps off a control', () => {
    const spots = placeBoxes({ kind: 'line', a: [330, 160], b: [330, 120] }, sizes, area, [undo])
    for (const s of spots) expect(overlaps(s, undo)).toBe(false)
    expect(overlap(box(spots, 'length'), box(spots, 'angle'))).toBe(false)
  })
})

describe('drawing with the boxes', () => {
  it('shows them for the second click of a rectangle, line or circle only', () => {
    expect(onShapeTool({ tool: 'rect', points: [[0, 0]] })).toBe(true)
    expect(onShapeTool({ tool: 'line', points: [[0, 0]] })).toBe(true)
    expect(onShapeTool({ tool: 'circle', points: [[0, 0]] })).toBe(true)
    expect(onShapeTool({ tool: 'rect', points: [] })).toBe(false)
    expect(onShapeTool({ tool: 'polygon', points: [[0, 0]] })).toBe(false)
    expect(draftShape({ tool: 'rect', points: [[10, 10]] }, [4, 15])).toEqual({ kind: 'rect', corners: [[4, 10], [10, 10], [10, 15], [4, 15]] })
    expect(draftShape({ tool: 'circle', points: [[0, 0]] }, [0, 0])).toEqual({ kind: 'circle', center: [0, 0], rim: [1, 0] })
  })

  it('names the shape a click left and keeps its typed sizes as dimensions', () => {
    const before: Entity[] = []
    const r = click(before, { tool: 'rect', points: [[0, 0]] }, [20, 10])
    const shape = placedShape(before, r.sketch, 'rect')!
    expect(shape).toEqual({ kind: 'rect', e: 0 })
    expect(typedConstraints(shape, { width: 20 }, [])).toEqual([{ type: 'length', line: { e: 0, seg: 0 }, value: 20 }])
    // a line going on: the segment just added
    const l1 = click([], { tool: 'line', points: [[0, 0]] }, [10, 0])
    const l2 = click(l1.sketch, l1.draft, [10, 10])
    expect(placedShape(l1.sketch, l2.sketch, 'line')).toEqual({ kind: 'line', e: 0, seg: 1 })
    // a level line already says its angle
    const level: SketchConstraint[] = [{ type: 'horizontal', line: { e: 0, seg: 0 } }]
    expect(typedConstraints({ kind: 'line', e: 0, seg: 0 }, { length: 10, angle: 0 }, level)).toEqual([{ type: 'length', line: { e: 0, seg: 0 }, value: 10 }])
    expect(typedConstraints({ kind: 'line', e: 0, seg: 1 }, { angle: 45 }, level)).toEqual([{ type: 'angle', a: X_AXIS, b: { e: 0, seg: 1 }, value: 45 }])
    const c = click([], { tool: 'circle', points: [[0, 0]] }, [3, 0])
    expect(placedShape([], c.sketch, 'circle')).toEqual({ kind: 'circle', e: 0 })
    expect(placedShape([], c.sketch, 'rect')).toBeNull()
    expect(emptyDraft('rect').points).toEqual([])
  })
})

describe('the drawing moved toward a typed size', () => {
  it('moves a rectangle far side, a line end and a circle rim, keeping the rest', () => {
    const w = seeded(rect(), { kind: 'rect', e: 0 }, 'width', 30)[0]!
    expect(w.kind === 'chain' && [w.start, ...w.segs.map((s) => s.to)]).toEqual([[10, 10], [40, 10], [40, 20], [10, 20], [10, 10]])
    const h = seeded(rect(), { kind: 'rect', e: 0 }, 'height', 4)[0]!
    expect(h.kind === 'chain' && [h.start, ...h.segs.map((s) => s.to)]).toEqual([[10, 10], [30, 10], [30, 14], [10, 14], [10, 10]])
    const a = seeded(line(), { kind: 'line', e: 0, seg: 0 }, 'angle', 90)[0]!
    expect(a.kind === 'chain' && a.segs[0]!.to.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 10])
    const l = seeded(line(), { kind: 'line', e: 0, seg: 1 }, 'length', 4)[0]!
    expect(l.kind === 'chain' && l.segs[1]!.to).toEqual([10, 4])
    expect(seeded(circle(), { kind: 'circle', e: 0 }, 'diameter', 12)[0]).toEqual({ kind: 'circle', center: [5, 5], diameterMm: 12 })
  })

  it('puts a kept circle rim point at 45 degrees for its box', () => {
    const k = keptShape(circle(), { kind: 'circle', e: 0 })!
    expect(k.kind === 'circle' && k.rim.map((v) => Math.round(v * 1000) / 1000)).toEqual([7.828, 7.828])
  })
})
