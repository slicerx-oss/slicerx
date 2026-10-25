// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Box3, Matrix4, PerspectiveCamera, Vector3, type BufferGeometry, type Mesh } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { applyInsets, CameraRig, freeNdc, type Insets } from '../src/camera'
import { PICK_Z, PickRings } from '../src/pick-rings'

type Pt = [number, number]
const rect = (x: number, y: number, w: number, d: number): Pt[] => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]
const at = (x: number, y = 0) => new Matrix4().makeTranslation(x, y, 0)

/** The corners of a ring mesh on the bed, as its object stands now. */
function corners(m: Mesh): { x0: number; x1: number; y0: number; y1: number; z: number } {
  const p = (m.geometry as BufferGeometry).getAttribute('position')
  const v = new Vector3()
  const xs: number[] = []
  const ys: number[] = []
  let z = 0
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(m.matrix)
    xs.push(v.x)
    ys.push(v.y)
    z = v.z
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z }
}

describe('pick rings', () => {
  it('rings each picked footprint just outside its edge, over a first layer, and shows only while it has some', () => {
    const r = new PickRings()
    expect(r.group.visible).toBe(false)
    r.set([{ id: 'a', transform: at(0).toArray(), hull: rect(10, 10, 20, 20) }, { id: 'b', transform: at(0).toArray(), hull: rect(50, 10, 20, 20) }])
    expect(r.group.visible).toBe(true)
    expect(r.ids).toEqual(['a', 'b'])
    r.follow(() => at(0))
    const a = corners(r.group.children[0] as Mesh)
    // 0.5 mm clear of the footprint, 3 mm wide
    expect(a.x0).toBeCloseTo(10 - 3.5, 5)
    expect(a.x1).toBeCloseTo(30 + 3.5, 5)
    expect(a.z).toBeCloseTo(PICK_Z, 5)
    expect(PICK_Z).toBeGreaterThan(0.4)
    r.set(null)
    expect(r.group.visible).toBe(false)
    expect(r.group.children).toHaveLength(0)
  })

  it('rides with its object, and hides when the view no longer has it', () => {
    const r = new PickRings()
    r.set([{ id: 'a', transform: at(0).toArray(), hull: rect(10, 10, 20, 20) }])
    r.follow((id) => (id === 'a' ? at(40, 5) : undefined))
    const m = r.group.children[0] as Mesh
    expect(corners(m).x0).toBeCloseTo(50 - 3.5, 5)
    expect(corners(m).y0).toBeCloseTo(15 - 3.5, 5)
    r.follow(() => undefined)
    expect(m.visible).toBe(false)
  })

  it('skips a footprint with no area', () => {
    const r = new PickRings()
    r.set([{ id: 'a', transform: at(0).toArray(), hull: [[0, 0], [1, 1]] }])
    expect(r.group.visible).toBe(false)
  })
})

describe('in view', () => {
  function rig(w: number, h: number, insets: Insets) {
    const camera = new PerspectiveCamera(30, w / h, 1, 5000)
    camera.position.set(0, 200, 400)
    const controls = { target: new Vector3(), update: vi.fn() }
    camera.lookAt(controls.target)
    const r = new CameraRig(camera, controls as never)
    r.free = applyInsets(camera, w, h, insets)
    r.freeNdc = freeNdc(w, h, insets)
    camera.updateMatrixWorld(true)
    return r
  }
  const box = (x: number, z: number, s = 10) => new Box3(new Vector3(x - s, 0, z - s), new Vector3(x + s, 2 * s, z + s))

  it('holds a box in the middle in view, and one past an edge or behind the camera out of it', () => {
    const r = rig(1440, 900, { left: 0, right: 0, top: 0, bottom: 0 })
    expect(r.inView(box(0, 0))).toBe(true)
    expect(r.inView(box(400, 0))).toBe(false)
    expect(r.inView(box(0, 700))).toBe(false)
    expect(r.inView(new Box3())).toBe(false)
  })

  it('counts a box under an overlay as out of view', () => {
    const plain = rig(390, 844, { left: 0, right: 0, top: 0, bottom: 0 })
    const under = rig(390, 844, { left: 0, right: 0, top: 0, bottom: 420 })
    // low on the screen: in the plain view, under the bottom overlay in the other
    const low = box(0, 120, 8)
    expect(plain.inView(low)).toBe(true)
    expect(under.inView(low)).toBe(false)
  })

  it('maps the free area to the normalized view as the insets shift it', () => {
    expect(freeNdc(1000, 500, { left: 0, right: 0, top: 0, bottom: 0 })).toEqual({ x0: -1, x1: 1, y0: -1, y1: 1 })
    expect(freeNdc(1000, 500, { left: 250, right: 0, top: 0, bottom: 125 })).toEqual({ x0: -0.5, x1: 1, y0: -0.5, y1: 1 })
  })
})
