// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Box3, PerspectiveCamera, Sphere, Vector3 } from 'three'
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

describe('the side views', () => {
  it.each([
    ['front', [0, 0, 1]],
    ['back', [0, 0, -1]],
    ['left', [-1, 0, 0]],
    ['right', [1, 0, 0]],
  ] as const)('%s looks level along its axis, at the content', (kind, axis) => {
    const { rig } = setup(1600, 900, NO_INSETS)
    const box = new Box3(new Vector3(-20, 0, -20), new Vector3(20, 60, 20))
    const pose = rig.presetPose(kind, box, 256)
    const dir = pose.pos.clone().sub(pose.target).normalize()
    expect(dir.x).toBeCloseTo(axis[0], 6)
    expect(dir.y).toBeCloseTo(0, 6)
    expect(dir.z).toBeCloseTo(axis[2], 6)
    expect(pose.target.y).toBeCloseTo(30, 6)
  })
})

describe('framed: Model frames a part from the current angle with room around it', () => {
  it('keeps the angle and gives a 20 mm part about 60 percent of the height, inside the view', () => {
    const w = 886
    const h = 674
    const { camera, rig } = setup(w, h, NO_INSETS)
    const before = camera.position.clone().normalize()
    const part = new Box3(new Vector3(90, 0, 90), new Vector3(110, 20, 110))
    const pose = rig.framed(part)
    expect(pose.pos.clone().sub(pose.target).normalize().dot(before)).toBeGreaterThan(0.999)
    camera.position.copy(pose.pos)
    camera.lookAt(pose.target)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    const ys = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ((1 - new Vector3(i & 1 ? 110 : 90, i & 2 ? 20 : 0, i & 4 ? 110 : 90).project(camera).y) / 2) * h)
    const share = (Math.max(...ys) - Math.min(...ys)) / h
    expect(share).toBeGreaterThan(0.5)
    expect(share).toBeLessThan(0.7)
    expect(Math.min(...ys)).toBeGreaterThan(0)
    expect(Math.max(...ys)).toBeLessThan(h)
  })
})

describe('a jump to a pose', () => {
  it('puts the camera matrices at the new pose before a frame is drawn', () => {
    const camera = new PerspectiveCamera(30, 1.6, 1, 5000)
    camera.position.set(400, 300, 500)
    const target = new Vector3()
    // The orbit controls turn the camera with lookAt on update, as the real ones do.
    const controls = { target, update: () => camera.lookAt(target) }
    controls.update()
    camera.updateMatrixWorld()
    const rig = new CameraRig(camera, controls as never)
    rig.go({ pos: new Vector3(-200, 500, 50), target: new Vector3(20, 0, -10) }, false, 0)
    // Where a point lands on screen with the matrices as they are, and as the next frame will draw it.
    const drawn = camera.clone()
    drawn.updateMatrixWorld()
    const p = new Vector3(30, 20, -40)
    const now = p.clone().project(camera)
    const next = p.clone().project(drawn)
    expect(now.x).toBeCloseTo(next.x, 6)
    expect(now.y).toBeCloseTo(next.y, 6)
  })
})

describe('fit: a long thin part fills the view, a compact one frames as before', () => {
  const W = 886
  const H = 674
  /** The camera distance Fit used before it looked at the part's own outline: its bounding sphere's, with 12 percent room. */
  function sphereDistance(camera: PerspectiveCamera, fw: number, fh: number, box: Box3): number {
    const fov = (camera.fov * Math.PI) / 180
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * camera.aspect)
    const half = Math.min(Math.atan(Math.tan(fov / 2) * fh), Math.atan(Math.tan(fovH / 2) * fw))
    return (box.getBoundingSphere(new Sphere()).radius * 1.12) / Math.sin(half)
  }
  /** Fit from the camera at `from`, and the share of the view's width and height the part's corners then take. */
  function fit(box: Box3, from: Vector3) {
    const { camera, rig } = setup(W, H, NO_INSETS)
    camera.position.copy(from)
    const pose = rig.presetPose('fit', box, 256)
    const before = sphereDistance(camera, rig.free.fw, rig.free.fh, box)
    const distance = pose.pos.distanceTo(pose.target)
    camera.position.copy(pose.pos)
    camera.lookAt(pose.target)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    const px = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera))
    const xs = px.map((p) => ((p.x + 1) / 2) * W)
    const ys = px.map((p) => ((1 - p.y) / 2) * H)
    const span = { w: (Math.max(...xs) - Math.min(...xs)) / W, h: (Math.max(...ys) - Math.min(...ys)) / H }
    const inside = Math.min(...xs) >= 0 && Math.max(...xs) <= W && Math.min(...ys) >= 0 && Math.max(...ys) <= H
    return { distance, before, span, inside, target: pose.target }
  }
  const ISO = new Vector3(400, 300, 500)
  const SIDE = new Vector3(0, 0.001, 600)
  const TOP = new Vector3(0, 600, 0.5)
  // A 20 mm calibration cube, the 64 x 60 x 22 mm layered X (y up), and a 255 x 51 x 27 mm ship, all on the bed.
  const CUBE = new Box3(new Vector3(-10, 0, -10), new Vector3(10, 20, 10))
  const X = new Box3(new Vector3(-32, 0, -11), new Vector3(32, 60, 11))
  const SHIP = new Box3(new Vector3(-127.75, 0, -13.5), new Vector3(127.75, 51, 13.5))

  it('frames a 20 mm cube exactly as before', () => {
    for (const from of [ISO, SIDE, TOP]) {
      const r = fit(CUBE, from)
      expect(r.distance / r.before).toBeCloseTo(1, 6)
    }
  })

  it('frames the layered X within 3 percent of before, never farther', () => {
    for (const from of [ISO, SIDE, TOP]) {
      const r = fit(X, from)
      // nearer by 1.2 percent from the front right and 2.4 percent from the side or the top
      expect(r.distance / r.before).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.distance / r.before).toBeGreaterThan(0.97)
      expect(r.inside).toBe(true)
    }
  })

  it('brings a long thin part in until it fills the view, from the front right, the side and the top', () => {
    // From the front right the sphere left the ship 57 percent of the width; it now takes about three quarters, as
    // Isometric gives it. Seen broadside its length already sets the sphere, so the side and top views keep their
    // framing, about two thirds of the width.
    const iso = fit(SHIP, ISO)
    expect(iso.distance / iso.before).toBeLessThan(0.8)
    expect(iso.span.w).toBeGreaterThan(0.7)
    expect(iso.inside).toBe(true)
    for (const from of [SIDE, TOP]) {
      const r = fit(SHIP, from)
      expect(r.distance / r.before).toBeLessThanOrEqual(1 + 1e-9)
      expect(r.span.w).toBeGreaterThan(0.6)
      expect(r.inside).toBe(true)
    }
  })

  it('frames a selection away from the middle of the bed around its own center', () => {
    const sel = SHIP.clone().translate(new Vector3(60, 0, -40))
    const r = fit(sel, ISO)
    expect(r.target.distanceTo(sel.getCenter(new Vector3()))).toBeLessThan(1e-9)
    expect(r.inside).toBe(true)
    expect(r.span.w).toBeGreaterThan(0.7)
  })
})

/** Where a box lands on screen from a pose, in pixels from the top left. */
function onScreen(camera: PerspectiveCamera, pose: { pos: Vector3; target: Vector3 }, box: Box3, w: number, h: number) {
  camera.position.copy(pose.pos)
  camera.lookAt(pose.target)
  camera.updateMatrixWorld(true)
  const px = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const p = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera)
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h }
  })
  return { x0: Math.min(...px.map((p) => p.x)), x1: Math.max(...px.map((p) => p.x)), y0: Math.min(...px.map((p) => p.y)), y1: Math.max(...px.map((p) => p.y)) }
}

describe('the straight views of a design frame the model, as the isometric view does', () => {
  // a long low part off to one side of a large bed, and a small tall one near the middle of a small bed
  const cases = [
    ['a long part off center', new Box3(new Vector3(60, 0, -90), new Vector3(150, 12, -70)), 350],
    ['a tall narrow part', new Box3(new Vector3(-12, 0, -8), new Vector3(12, 70, 8)), 180],
  ] as const
  for (const [name, box, bed] of cases) {
    for (const kind of ['front', 'back', 'left', 'right', 'top', 'bottom'] as const) {
      it(`${kind} on ${name}: aimed at the model and filling the view like iso`, () => {
        const w = 1400
        const h = 900
        const { camera, rig } = setup(w, h, NO_INSETS)
        rig.frameModel = true
        const pose = rig.presetPose(kind, box, bed)
        expect(pose.target.distanceTo(box.getCenter(new Vector3()))).toBeLessThan(1e-6)
        const r = onScreen(camera, pose, box, w, h)
        // the bigger share of the view, height or width, is the share the iso framing gives (60 percent of the
        // height or 72 percent of the width), and the whole model is on screen
        const share = Math.max((r.y1 - r.y0) / h / 0.6, (r.x1 - r.x0) / w / 0.72)
        expect(share).toBeGreaterThan(0.97)
        expect(share).toBeLessThan(1.03)
        expect(r.x0).toBeGreaterThanOrEqual(0)
        expect(r.x1).toBeLessThanOrEqual(w)
        expect(r.y0).toBeGreaterThanOrEqual(0)
        expect(r.y1).toBeLessThanOrEqual(h)
      })
    }
  }

  it('keeps each view looking along its own axis', () => {
    const { rig } = setup(1400, 900, NO_INSETS)
    rig.frameModel = true
    const box = new Box3(new Vector3(30, 0, 10), new Vector3(70, 25, 50))
    for (const [kind, axis] of [['front', [0, 0, 1]], ['right', [1, 0, 0]], ['top', [0, 1, 0]]] as const) {
      const pose = rig.presetPose(kind, box, 256)
      const dir = pose.pos.clone().sub(pose.target).normalize()
      expect(dir.x).toBeCloseTo(axis[0], 2)
      expect(dir.y).toBeCloseTo(axis[1], 2)
      expect(dir.z).toBeCloseTo(axis[2], 2)
    }
  })

  it('Slice keeps framing the bed in its straight views', () => {
    const { rig } = setup(1400, 900, NO_INSETS)
    const box = new Box3(new Vector3(60, 0, -90), new Vector3(150, 12, -70))
    for (const kind of ['front', 'top'] as const) {
      const bedPose = rig.presetPose(kind, box, 350)
      // aimed at the bed's middle, not the part
      expect(Math.abs(bedPose.target.x)).toBeLessThan(1e-6)
      expect(Math.abs(bedPose.target.z)).toBeLessThan(1e-6)
      rig.frameModel = true
      const modelPose = rig.presetPose(kind, box, 350)
      rig.frameModel = false
      expect(modelPose.pos.distanceTo(modelPose.target)).toBeLessThan(bedPose.pos.distanceTo(bedPose.target))
    }
  })

  it('a framed straight view follows a bed that moves, as a view of the model does; a bed view stays put', () => {
    const { rig, camera } = setup(1400, 900, NO_INSETS)
    rig.preset = 'front'
    expect(rig.followBed(new Vector3(10, 0, 0))).toBe(false)
    rig.frameModel = true
    const x = camera.position.x
    expect(rig.followBed(new Vector3(10, 0, 0))).toBe(true)
    expect(camera.position.x).toBeCloseTo(x + 10, 6)
  })
})
