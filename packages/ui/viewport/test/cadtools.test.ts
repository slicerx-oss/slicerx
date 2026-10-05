// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { BufferAttribute, LineSegments, Matrix4, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { DimensionLayer, EdgePreview, PushPreview, SketchLayer, frameMatrix, fromPlane, prismMatrix, rayOnPlane, toPlane, type CadFrame } from '../src/cadtools'
import type { V3 } from '../src/scaling'

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? NaN, digits))

// A wall facing +X at x = 10, u along +Y and v up.
const WALL: CadFrame = { origin: [10, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] }

describe('sketch plane math', () => {
  it('goes to plane coordinates and back', () => {
    close(toPlane(WALL, [10, 4, 7]), [4, 7])
    close(fromPlane(WALL, [4, 7]), [10, 4, 7])
    const m = frameMatrix(WALL)
    close(new Vector3(4, 7, 0).applyMatrix4(m).toArray(), [10, 4, 7])
  })

  it('meets a ray with the plane, and misses one running along it or pointing away', () => {
    close(rayOnPlane(WALL, [50, 3, 2], [-1, 0, 0])!, [3, 2])
    expect(rayOnPlane(WALL, [50, 3, 2], [0, 1, 0])).toBeNull()
    expect(rayOnPlane(WALL, [50, 3, 2], [1, 0, 0])).toBeNull()
  })
})

describe('push preview', () => {
  it('stretches a 1 mm prism to the distance along the normal, about the face', () => {
    const point: V3 = [5, 5, 20]
    const n: V3 = [0, 0, 1]
    // The prism's far corner at 1 mm lands at d mm; points on the face stay.
    close(new Vector3(0, 0, 21).applyMatrix4(prismMatrix(point, n, 5)).toArray(), [0, 0, 25])
    close(new Vector3(3, 4, 20).applyMatrix4(prismMatrix(point, n, 5)).toArray(), [3, 4, 20])
    close(new Vector3(0, 0, 21).applyMatrix4(prismMatrix(point, n, -3)).toArray(), [0, 0, 17])
    // A tilted normal scales only along itself.
    const t: V3 = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const m = prismMatrix([0, 0, 0], t, 4)
    close(new Vector3(Math.SQRT1_2, Math.SQRT1_2, 0).applyMatrix4(m).toArray(), [4 * Math.SQRT1_2, 4 * Math.SQRT1_2, 0])
    close(new Vector3(-1, 1, 3).applyMatrix4(m).toArray(), [-1, 1, 3])
  })

  it('shows green when it adds, red when it cuts, and nothing at zero', () => {
    const p = new PushPreview()
    const prism = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3] }
    p.setPrism(prism, { point: [0, 0, 0], normal: [0, 0, 1] })
    p.setDistance(5)
    expect(p.group.visible).toBe(true)
    const fill = (p.group.children[0] as unknown as { material: { color: { getHexString(): string } } }).material
    expect(fill.color.getHexString()).toBe('50fa7b')
    expect(p.group.matrix.elements[10]).toBeCloseTo(5)
    p.setDistance(-2)
    expect(fill.color.getHexString()).toBe('ff5555')
    p.setDistance(0)
    expect(p.group.visible).toBe(false)
    p.setPrism(null, null)
    expect(p.hasPrism).toBe(false)
    p.dispose()
  })
})

describe('sketch layer', () => {
  it('draws paths by tone, handles and a grid, and finds the handle under the cursor', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [{ points: [[0, 0], [10, 0], [10, 5]], closed: true }, { points: [[0, 0], [10, 5]], tone: 'issue' }], handles: [[0, 0], [10, 0], [10, 5]], dragHandles: true, grid: { stepMm: 10, min: [-20, -20], max: [20, 20] } })
    expect(s.group.visible).toBe(true)
    const lines = s.group.children.filter((c): c is LineSegments => c instanceof LineSegments)
    // Grid, normal and issue.
    expect(lines.length).toBe(3)
    expect(s.handleAt([9.6, 0.2], 0.5)).toBe(1)
    expect(s.handleAt([5, 5], 0.5)).toBe(-1)
    s.set({ ...s.scene!, dragHandles: false })
    expect(s.handleAt([9.6, 0.2], 0.5)).toBe(-1)
    s.set(null)
    expect(s.group.visible).toBe(false)
    s.dispose()
  })

  it('moves the rubber band in its own buffer without allocating', () => {
    const s = new SketchLayer()
    s.set({ frame: WALL, paths: [], handles: [] })
    const band = s.group.children[0] as LineSegments
    const before = band.geometry.getAttribute('position') as BufferAttribute
    s.cursor({ path: [[0, 0], [3, 4]], at: [3, 4] })
    const after = band.geometry.getAttribute('position') as BufferAttribute
    expect(after).toBe(before)
    expect(band.geometry.drawRange.count).toBe(2)
    expect(Array.from(after.array.slice(3, 5))).toEqual([3, 4])
    s.cursor(null)
    expect(band.geometry.drawRange.count).toBe(0)
    s.dispose()
  })
})

describe('kept dimensions', () => {
  it('sizes labels for the lens and the view height only when they change', () => {
    const d = new DimensionLayer()
    // jsdom has no 2D canvas, so labels are skipped; lines and dots still draw.
    expect(d.set([{ id: 'd1', from: [0, 0, 0], to: [0, 0, 20], label: '20.00 mm' }])).toBe(true)
    expect(d.group.children.length).toBeGreaterThanOrEqual(2)
    d.fit(30, 800)
    expect(d.set([])).toBe(true)
    expect(d.group.children.length).toBe(0)
    expect(d.set([])).toBe(false)
    d.dispose()
  })
})

describe('frame matrix', () => {
  it('is a rigid placement for an orthonormal frame', () => {
    const m = frameMatrix({ origin: [1, 2, 3], u: [0, 0, 1], v: [1, 0, 0], normal: [0, 1, 0] }, new Matrix4())
    expect(m.determinant()).toBeCloseTo(1)
  })
})

describe('edge preview', () => {
  it('draws what a fillet removes in red and adds in green, and clears', () => {
    const p = new EdgePreview()
    const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }
    p.set({ cut: tri, join: null })
    expect(p.group.visible).toBe(true)
    expect(p.group.children).toHaveLength(1)
    const color = (i: number) => (p.group.children[i] as unknown as { material: { color: { getHexString(): string } } }).material.color.getHexString()
    expect(color(0)).toBe('ff5555')
    p.set({ cut: tri, join: tri })
    expect(p.group.children).toHaveLength(2)
    expect(color(1)).toBe('50fa7b')
    p.set({ cut: { positions: [], indices: [] }, join: null })
    expect(p.group.visible).toBe(false)
    p.set(null)
    expect(p.group.children).toHaveLength(0)
    p.dispose()
  })
})
