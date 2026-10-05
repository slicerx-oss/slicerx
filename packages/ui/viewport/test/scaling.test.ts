// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { clampScale, dragFactor, factorsFor, handleAxis, handleIds, handleLocal, minFactorFor, nearestOnLine, pivotFor, ratioLine, ratioPivotFor, ratioPlane, ratioPoint, scaleTransform, snapScale, type V3 } from '../src/scaling'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const apply = (m: number[], v: V3): V3 => [
  (m[0] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[8] ?? 0) * v[2] + (m[12] ?? 0),
  (m[1] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[9] ?? 0) * v[2] + (m[13] ?? 0),
  (m[2] ?? 0) * v[0] + (m[6] ?? 0) * v[1] + (m[10] ?? 0) * v[2] + (m[14] ?? 0),
]

describe('scaleTransform', () => {
  it('scales about an anchor that stays put', () => {
    const m = scaleTransform(I, [2, 1, 1], [10, 0, 0])
    expect(apply(m, [10, 5, 5])).toEqual([10, 5, 5])
    expect(apply(m, [20, 5, 5])).toEqual([30, 5, 5])
    expect(apply(m, [0, 0, 0])).toEqual([-10, 0, 0])
  })

  it('scales the object own axes when the object is moved and rotated', () => {
    // Rotated a quarter turn about Z, then moved by (100, 0, 0): local +x now points along +y.
    const m = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]
    const out = scaleTransform(m, [3, 1, 1], [0, 0, 0])
    expect(apply(out, [1, 0, 0])).toEqual([100, 3, 0])
    expect(apply(out, [0, 1, 0])).toEqual([99, 0, 0])
    expect(apply(out, [0, 0, 0])).toEqual([100, 0, 0])
  })

  it('composes: two scales multiply', () => {
    const a = scaleTransform(scaleTransform(I, [2, 2, 2], [0, 0, 0]), [1.5, 1.5, 1.5], [0, 0, 0])
    expect(apply(a, [1, 1, 1])).toEqual([3, 3, 3])
  })
})

describe('drag math', () => {
  it('finds the nearest parameter on an axis line', () => {
    // Ray straight down at x = 7 over the x axis.
    expect(nearestOnLine([7, 4, 10], [0, 0, -1], [0, 0, 0], [1, 0, 0])).toBeCloseTo(7)
    expect(nearestOnLine([0, 0, 5], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull()
  })

  it('turns two projections into a factor, clamped', () => {
    expect(dragFactor(20, 10)).toBe(2)
    expect(dragFactor(5, 10)).toBe(0.5)
    expect(dragFactor(-5, 10)).toBe(clampScale(-0.5))
    expect(dragFactor(-5, 10)).toBe(0.01)
    expect(dragFactor(1e6, 1)).toBe(50)
    expect(dragFactor(3, 0)).toBe(1)
  })

  it('snaps to 5 percent and never below one step', () => {
    expect(snapScale(1.23)).toBeCloseTo(1.25)
    expect(snapScale(0.51)).toBeCloseTo(0.5)
    expect(snapScale(0.01)).toBeCloseTo(0.05)
  })

  it('places handles: Orca and Bambu at the bottom, PrusaSlicer at the face centers', () => {
    const min: V3 = [0, 0, 0]
    const max: V3 = [10, 20, 30]
    expect(handleLocal('xp', min, max)).toEqual([10, 10, 0])
    expect(handleLocal('yp', min, max)).toEqual([5, 20, 0])
    expect(handleLocal('zp', min, max)).toEqual([5, 10, 30])
    expect(handleLocal('cpp', min, max)).toEqual([10, 20, 0])
    expect(handleIds('bottom')).toHaveLength(9)
    expect(handleIds('bottom')).not.toContain('zn')
    expect(handleIds('faces')).toHaveLength(10)
    expect(handleLocal('xp', min, max, 'faces')).toEqual([10, 10, 15])
    expect(handleLocal('zn', min, max, 'faces')).toEqual([5, 10, 0])
    expect(handleLocal('cpp', min, max, 'faces')).toEqual([10, 20, 15])
    expect(handleAxis('cnn')).toBe('uniform')
    expect(handleAxis('zp')).toBe('z')
  })

  const bottom = { layout: 'bottom', pivot: 'bottom-center', cornerPinLocksZ: true } as const
  const faces = { layout: 'faces', pivot: 'center', cornerPinLocksZ: false } as const
  const min: V3 = [0, 0, 0]
  const max: V3 = [10, 20, 30]

  it('pivots: bottom center, the opposite handle when pinned, the center for PrusaSlicer', () => {
    expect(pivotFor('xp', min, max, bottom, false)).toEqual([5, 10, 0])
    expect(pivotFor('xp', min, max, bottom, true)).toEqual([0, 10, 0])
    expect(pivotFor('zp', min, max, bottom, true)).toEqual([5, 10, 0])
    expect(pivotFor('cpp', min, max, bottom, true)).toEqual([0, 0, 0])
    expect(pivotFor('cpp', min, max, { ...bottom, cornerPinLocksZ: false }, true)).toEqual([5, 10, 0])
    expect(ratioPivotFor('cpp', min, max, bottom, true)).toEqual([5, 10, 0])
    expect(ratioPivotFor('xp', min, max, bottom, true)).toEqual([0, 10, 0])
    expect(pivotFor('xp', min, max, faces, false)).toEqual([5, 10, 15])
    expect(pivotFor('zp', min, max, faces, true)).toEqual([5, 10, 0])
  })

  it('gives factors per handle; a pinned corner that locks z leaves z alone', () => {
    expect(factorsFor('xp', 2, false)).toEqual([2, 1, 1])
    expect(factorsFor('yn', 2, true)).toEqual([1, 2, 1])
    expect(factorsFor('zp', 2, false)).toEqual([1, 1, 2])
    expect(factorsFor('cpn', 2, false)).toEqual([2, 2, 2])
    expect(factorsFor('cpn', 2, true)).toEqual([2, 2, 1])
  })

  it('keeps at least the minimum size when a source asks for it', () => {
    expect(minFactorFor('xp', [10, 20, 30], 1)).toBeCloseTo(0.1)
    expect(minFactorFor('cpp', [10, 20, 30], 1)).toBeCloseTo(0.1)
    expect(minFactorFor('zp', [10, 20, 30], null)).toBe(0)
  })
})

describe('ratio sources', () => {
  // A handle 10 mm from the pivot along +x; the pointer looks straight down from above.
  const pivot: V3 = [0, 0, 0]
  const drag: V3 = [10, 0, 0]

  it('line (PrusaSlicer): length plus how far the cursor moved along the line since the start', () => {
    expect(ratioLine(15, 10, 10)).toBeCloseTo(1.5)
    expect(ratioLine(10, 10, 10)).toBe(1)
    expect(ratioLine(10, 12, 10)).toBeCloseTo(0.8)
  })

  it('point (Bambu Studio): the ray point nearest the handle start, projected on the pivot to handle direction', () => {
    expect(ratioPoint([15, 0, 50], [0, 0, -1], drag, pivot)).toBeCloseTo(1.5)
    expect(ratioPoint([10, 0, 50], [0, 0, -1], drag, pivot)).toBeCloseTo(1)
    expect(ratioPoint([5, 7, 50], [0, 0, -1], drag, pivot)).toBeCloseTo(0.5)
    expect(ratioPoint([5, 7, 50], [0, 0, -1], pivot, pivot)).toBe(1)
  })

  it('plane (Orca): the ray meets the horizontal plane of the handle', () => {
    // From above at an angle: the ray from (0, 0, 10) toward (15, 0, 0) hits z = 0 at x = 15.
    const d: V3 = [15, 0, -10]
    expect(ratioPlane([0, 0, 10], d, drag, pivot, [0, 0, 1], false)).toBeCloseTo(1.5)
    expect(ratioPlane([10, 0, 10], [0, 0, -1], drag, pivot, [0, 0, 1], false)).toBeCloseTo(1)
  })

  it('plane (Orca): a ray almost parallel to the plane leaves the ratio at 1', () => {
    expect(ratioPlane([0, 0, 0.1], [1, 0, -0.001], drag, pivot, [0, 0, 1], false)).toBe(1)
  })

  it('plane (Orca): the z handle uses a plane that contains the up axis and faces the ray', () => {
    // Handle 30 mm above the pivot, ray along -y at x = 0 through z = 45: the plane is x-z, hit at z = 45.
    expect(ratioPlane([0, 50, 45], [0, -1, 0], [0, 0, 30], pivot, [0, 0, 1], true)).toBeCloseTo(1.5)
  })
})
