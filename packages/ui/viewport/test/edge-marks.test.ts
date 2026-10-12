// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Texture, Vector2, type Mesh } from 'three'
import { EdgeMarks, patchOutline } from '../src/edge-marks'

/** Every mark drawn: the hover's dashes, then the overlay's picks. */
const marks = (m: EdgeMarks) => m.group.children.flatMap((g) => g.children)
const kinds = (m: EdgeMarks) => marks(m).map((c) => ((c as Mesh).geometry.type === 'SphereGeometry' ? 'dot' : 'bar'))

describe('picked edge marks', () => {
  const line = { from: [0, 0, 0] as [number, number, number], to: [10, 0, 0] as [number, number, number] }
  it('draws a picked edge as a bar with a dot at each end, sized from the screen scale', () => {
    const m = new EdgeMarks()
    expect(m.set([line], [], () => 0.1)).toBe(true)
    expect(kinds(m)).toEqual(['bar', 'dot', 'dot'])
    const bar = marks(m)[0]!
    expect(bar.scale.y).toBeCloseTo(10)
    expect(bar.scale.x).toBeCloseTo(0.12)
    expect(marks(m)[1]!.scale.x).toBeCloseTo(0.32)
    expect(m.set([], [], () => 0.1)).toBe(true)
    expect(marks(m)).toHaveLength(0)
  })

  it('gives a chain of picked lines dots at its loose ends only', () => {
    const m = new EdgeMarks()
    m.set([line, { from: [10, 0, 0], to: [10, 10, 0] }], [], () => 0.1)
    expect(kinds(m).filter((k) => k === 'dot')).toHaveLength(2)
  })

  it('draws the hovered edge as dashes that march along it, and keeps them still when asked', () => {
    const m = new EdgeMarks()
    m.set([], [line], () => 0.1)
    // 10 mm at 0.1 mm a pixel is 100 px: dashes of 5 px every 8 px
    expect(marks(m).length).toBeGreaterThanOrEqual(12)
    expect(marks(m).length).toBeLessThanOrEqual(14)
    const before = marks(m).map((c) => c.position.x)
    expect(m.march(1000, true, () => 0.1)).toBe(true)
    expect(m.march(1100, true, () => 0.1)).toBe(true)
    expect(marks(m).map((c) => c.position.x)).not.toEqual(before)
    expect(m.march(1200, false, () => 0.1)).toBe(false)
  })

  it('redraws only when the camera has moved enough to change the width', () => {
    const m = new EdgeMarks()
    m.set([line], [], () => 0.1)
    expect(m.refresh(() => 0.11)).toBe(false)
    expect(m.refresh(() => 0.2)).toBe(true)
    expect(marks(m)[0]!.scale.x).toBeCloseTo(0.24)
  })

  it('outlines a face patch by the edges its triangles do not share', () => {
    // a square of two triangles: four outline edges, the diagonal left out
    const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]
    const indices = [0, 1, 2, 0, 2, 3]
    const out = patchOutline(positions, indices, [0, 1])
    expect(out).toHaveLength(4)
    const m = new EdgeMarks()
    expect(m.setOutline(out, () => 0.1)).toBe(true)
    expect(kinds(m)).toEqual(['bar', 'bar', 'bar', 'bar'])
    expect(marks(m)[0]!.scale.x).toBeCloseTo(0.11)
  })

  it('draws every mark in the overlay, and tests only the hover against the scene depth', () => {
    const m = new EdgeMarks()
    m.set([line], [line], () => 0.1)
    const tested = m.overlay.children.filter((c) => ((c as Mesh).material as { userData: { depthTested?: boolean } }).userData.depthTested)
    // the hover's dashes are tested; the picked bar and its two dots show through
    expect(tested.length).toBeGreaterThan(0)
    expect(m.overlay.children.length - tested.length).toBe(3)
    m.setOutline([line], () => 0.1)
    expect(m.overlay.children.length - tested.length).toBe(4)
    // only the face outline cuts the selection outline
    expect(m.overlay.children.filter((c) => c.userData.cutsOutline)).toHaveLength(1)
    // the test runs once the pipeline hands over the scene's depth
    expect(m.depth.sxOn.value).toBe(0)
    m.setSceneDepth(new Texture(), new Vector2(1440, 900), new PerspectiveCamera(40, 1.6, 1, 5000))
    expect(m.depth.sxOn.value).toBe(1)
    expect(m.depth.sxSize.value.x).toBe(1440)
    expect(m.depth.sxFar.value).toBe(5000)
  })
})
