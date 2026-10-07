// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Box3, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { applyInsets, CameraRig, freeArea, NO_INSETS, type Insets } from '../src/camera'

/** A rig on a w by h view with the overlays' insets applied, as the viewport sets it up. */
function setup(w: number, h: number, insets: Insets) {
  const camera = new PerspectiveCamera(30, w / h, 1, 5000)
  // 'fit' keeps the current viewing angle, so the camera needs one: front right and above, like the default view.
  camera.position.set(400, 300, 500)
  const controls = { target: new Vector3(), update: vi.fn() }
  const rig = new CameraRig(camera, controls as never)
  rig.free = applyInsets(camera, w, h, insets)
  return { camera, rig, controls }
}

/** Where the box's corners land on screen, in pixels from the top left, after the rig frames it. */
function framed(w: number, h: number, insets: Insets, box: Box3, bed: number, kind: 'iso' | 'fit' | 'plate', measure: Box3 = box) {
  const { camera, rig } = setup(w, h, insets)
  const pose = rig.presetPose(kind, box, bed)
  camera.position.copy(pose.pos)
  camera.lookAt(pose.target)
  camera.near = 1
  camera.far = 20000
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  const px = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const p = new Vector3(i & 1 ? measure.max.x : measure.min.x, i & 2 ? measure.max.y : measure.min.y, i & 4 ? measure.max.z : measure.min.z).project(camera)
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h }
  })
  return { x0: Math.min(...px.map((p) => p.x)), x1: Math.max(...px.map((p) => p.x)), y0: Math.min(...px.map((p) => p.y)), y1: Math.max(...px.map((p) => p.y)) }
}

// The Preview overlays of the H2C screenshot: the legend on the left, the layer strip on the right, the playback bar below.
const OVERLAID: Insets = { left: 287, right: 127, top: 0, bottom: 160 }
// A plate's toolpaths on a 350 mm bed with the purge tower off to one side, and a small bed with one part.
const H2C = new Box3(new Vector3(-170, 0, -150), new Vector3(150, 60, 140))
const SMALL = new Box3(new Vector3(-40, 0, -30), new Vector3(60, 25, 40))

describe('framing clear of overlays', () => {
  for (const [name, w, h, bed, box] of [['a large bed', 1094, 800, 350, H2C], ['a small bed', 1094, 800, 256, SMALL], ['a narrow window', 760, 640, 350, H2C]] as const) {
    for (const kind of ['iso', 'fit'] as const) {
      it(`${kind} on ${name}: every corner of the content is inside the free area`, () => {
        const f = freeArea(w, h, OVERLAID)
        const r = framed(w, h, OVERLAID, box, bed, kind)
        const eps = 1
        expect(r.x0).toBeGreaterThanOrEqual(f.x - eps)
        expect(r.x1).toBeLessThanOrEqual(f.x + f.w + eps)
        expect(r.y0).toBeGreaterThanOrEqual(f.y - eps)
        expect(r.y1).toBeLessThanOrEqual(f.y + f.h + eps)
      })
    }
  }

  it('centers the content in the free area, not in the whole view', () => {
    const f = freeArea(1094, 800, OVERLAID)
    const r = framed(1094, 800, OVERLAID, H2C, 350, 'iso')
    // The box center is the target, so the content's middle sits on the free area's middle within the perspective skew.
    expect((r.x0 + r.x1) / 2).toBeGreaterThan(f.x + f.w * 0.35)
    expect((r.x0 + r.x1) / 2).toBeLessThan(f.x + f.w * 0.65)
  })

  it('without overlays the framing is the plain product shot', () => {
    const r = framed(1094, 800, NO_INSETS, SMALL, 256, 'iso')
    expect(r.x0).toBeGreaterThan(0)
    expect(r.x1).toBeLessThan(1094)
    expect((r.y1 - r.y0) / 800).toBeLessThanOrEqual(0.62)
  })

  it('keeps at least 40 percent of the view free however much is covered', () => {
    const f = freeArea(1000, 800, { left: 900, right: 900, top: 700, bottom: 700 })
    expect(f.w).toBeGreaterThanOrEqual(400 - 1e-6)
    expect(f.h).toBeGreaterThanOrEqual(320 - 1e-6)
  })
})

describe('the opening view', () => {
  for (const [name, bed, box] of [['a 256 mm bed', 256, SMALL], ['a 350 mm bed with a tall plate', 350, H2C]] as const) {
    it(`frames the whole plate on ${name}, its edge about 70 percent of the width, with the parts in view`, () => {
      const plate = new Box3(new Vector3(-bed / 2, 0, -bed / 2), new Vector3(bed / 2, 0, bed / 2))
      const edge = framed(1094, 800, NO_INSETS, box, bed, 'plate', plate)
      expect((edge.x1 - edge.x0) / 1094).toBeGreaterThan(0.6)
      expect((edge.x1 - edge.x0) / 1094).toBeLessThanOrEqual(0.75)
      expect(edge.y1).toBeLessThan(800)
      const parts = framed(1094, 800, NO_INSETS, box, bed, 'plate')
      expect(parts.y0).toBeGreaterThan(0)
    })
  }
})
