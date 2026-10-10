// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A multi-selection moves, turns and scales as one: the objects keep their places relative to each other, and an even
// scale grows their sizes and the room between them alike. The scale handles show only the even ones for a selection.
import { Box3, Matrix4, Object3D, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { ScaleGizmo } from '../src/gizmo'
import { applyToAll, groupBounds, scaleAbout } from '../src/group'
import { rotateAbout } from '../src/rings'
import { handleAxis } from '../src/scaling'

const at = (x: number, y: number, z = 0) => new Matrix4().makeTranslation(x, y, z).toArray()
const pos = (m: number[]) => new Vector3(m[12], m[13], m[14])
const starts = new Map([
  ['a', at(100, 100)],
  ['b', at(160, 120)],
])

describe('a selection changed as one', () => {
  it('moves every object by the same amount', () => {
    const out = applyToAll(starts, at(10, -5, 2))
    expect(pos(out.get('a')!).toArray()).toEqual([110, 95, 2])
    expect(pos(out.get('b')!).toArray()).toEqual([170, 115, 2])
  })

  it('turns about the middle and keeps the room between the objects', () => {
    const before = pos(starts.get('a')!).distanceTo(pos(starts.get('b')!))
    const out = applyToAll(starts, rotateAbout(new Matrix4().elements, [130, 110, 0], [0, 0, 1], Math.PI / 2))
    expect(pos(out.get('a')!).distanceTo(pos(out.get('b')!))).toBeCloseTo(before, 6)
    // a quarter turn about the middle: a at (100, 100) goes to (140, 80)
    expect(pos(out.get('a')!).x).toBeCloseTo(140, 6)
    expect(pos(out.get('a')!).y).toBeCloseTo(80, 6)
    // and each object turns with it
    expect(new Vector3(1, 0, 0).applyMatrix4(new Matrix4().fromArray(out.get('b')!).setPosition(0, 0, 0)).y).toBeCloseTo(1, 6)
  })

  it('scales sizes and the room between the objects alike', () => {
    const before = pos(starts.get('a')!).distanceTo(pos(starts.get('b')!))
    const out = applyToAll(starts, scaleAbout(1.5, [130, 110, 0]))
    expect(pos(out.get('a')!).distanceTo(pos(out.get('b')!))).toBeCloseTo(before * 1.5, 6)
    expect(new Vector3().setFromMatrixScale(new Matrix4().fromArray(out.get('a')!)).toArray()).toEqual([1.5, 1.5, 1.5])
    // the anchor on the bed stays: nothing sinks under it
    expect(pos(out.get('a')!).z).toBe(0)
  })

  it('finds the box round several boxes', () => {
    expect(groupBounds([{ min: [0, 0, 0], max: [10, 10, 5] }, { min: [20, -4, 0], max: [30, 6, 12] }])).toEqual({ min: [0, -4, 0], max: [30, 10, 12], center: [15, 3, 6] })
    expect(groupBounds([])).toBeNull()
  })
})

describe('scale handles for a selection', () => {
  it('show only the even handles', () => {
    const g = new ScaleGizmo()
    const obj = new Object3D()
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(40, 20, 10))
    const cam = new PerspectiveCamera(30, 1, 1, 2000)
    cam.position.set(200, -200, 200)
    cam.lookAt(20, 10, 5)
    cam.updateMatrixWorld()
    const shown = () => g.group.children.filter((c) => c.visible && c.userData['handle']).map((c) => handleAxis(c.userData['handle']))
    g.update(obj, box, cam, 800, 30, { layout: 'faces', pivot: 'bottom-center', pinned: false })
    expect(shown()).toContain('x')
    g.update(obj, box, cam, 800, 30, { layout: 'faces', pivot: 'bottom-center', pinned: false, uniformOnly: true })
    expect(shown().length).toBeGreaterThan(0)
    expect(new Set(shown())).toEqual(new Set(['uniform']))
  })
})
