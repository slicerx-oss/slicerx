// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Camera framing: the product-shot default, view presets, animated moves and
// near and far planes fitted to the scene so the depth buffer keeps its
// precision for stacked color parts.
import { Box3, PerspectiveCamera, Sphere, Spherical, Vector3 } from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ViewPreset } from './types'

export interface CameraMove {
  t0: number
  dur: number
  fromPos: Vector3
  fromTarget: Vector3
  toPos: Vector3
  toTarget: Vector3
}

// the app's Motion choice is on the root as data-motion (ui/src/motion.ts); without it, the system's
export function reducedMotion(): boolean {
  const m = typeof document === 'undefined' ? undefined : document.documentElement.dataset['motion']
  if (m) return m === 'reduced'
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Distance at which the box's projected corners fill the given share of the view. */
function fitDistance(cam: PerspectiveCamera, box: Box3, dir: Vector3, fillH: number, fillW: number): { target: Vector3; distance: number } {
  const target = box.getCenter(new Vector3())
  const pts: Vector3[] = []
  for (let i = 0; i < 8; i++) pts.push(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z))
  const c = cam.clone()
  c.near = 1
  c.far = 200000
  c.updateProjectionMatrix()
  let d = 500
  const v = new Vector3()
  for (let it = 0; it < 5; it++) {
    c.position.copy(target).addScaledVector(dir, d)
    c.lookAt(target)
    c.updateMatrixWorld(true)
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
    for (const p of pts) {
      v.copy(p).project(c)
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y)
    }
    d *= Math.max((y1 - y0) / 2 / fillH, (x1 - x0) / 2 / fillW)
  }
  return { target, distance: Math.max(d, 60) }
}

/** Pixels of the view that overlays cover on each side (the legend, the layer strip, the playback bar). */
export interface Insets {
  left: number
  right: number
  top: number
  bottom: number
}

export const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 }

/** What is left of a w by h view once the insets are taken off. Each side keeps at least 40 percent of the view. */
export function freeArea(w: number, h: number, insets: Insets): { insets: Insets; x: number; y: number; w: number; h: number } {
  const fit = (a: number, b: number, size: number): [number, number] => {
    const room = size * 0.6
    const sum = a + b
    return sum > room ? [(a * room) / sum, (b * room) / sum] : [a, b]
  }
  const [left, right] = fit(Math.max(0, insets.left), Math.max(0, insets.right), w)
  const [top, bottom] = fit(Math.max(0, insets.top), Math.max(0, insets.bottom), h)
  return { insets: { left, right, top, bottom }, x: left, y: top, w: w - left - right, h: h - top - bottom }
}

/**
 * Shifts the picture so the middle of the view is the middle of the free area, and returns the free
 * area as shares of the view (what the framing math fills). With no insets the camera is left alone.
 */
export function applyInsets(camera: PerspectiveCamera, w: number, h: number, insets: Insets): { fw: number; fh: number } {
  const f = freeArea(w, h, insets)
  const { left, right, top, bottom } = f.insets
  if (left || right || top || bottom) camera.setViewOffset(w, h, -(left - right) / 2, (bottom - top) / 2, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
  return { fw: f.w / w, fh: f.h / h }
}

export class CameraRig {
  move: CameraMove | null = null
  preset: ViewPreset | null = 'iso'
  /** Share of the view width and height the overlays leave free; presets frame the model inside it. */
  free = { fw: 1, fh: 1 }
  /** An overlay is on the view, so a framed model fills more of the free area. */
  get covered(): boolean {
    return this.free.fw < 1 || this.free.fh < 1
  }

  constructor(
    readonly camera: PerspectiveCamera,
    readonly controls: OrbitControls,
  ) {}

  /** Destination for a preset. `box` is the world-space bounds of what should be framed; `bedSize` the larger bed side. */
  presetPose(kind: ViewPreset, box: Box3, bedSize: number): { pos: Vector3; target: Vector3 } {
    const cam = this.camera
    const sphere = box.getBoundingSphere(new Sphere())
    let target: Vector3
    let dir: Vector3
    let d: number
    const fov = (cam.fov * Math.PI) / 180
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * cam.aspect)
    // A sphere of radius r fits the free area when it fits the narrower of its two half angles.
    const { fw, fh } = this.free
    const half = Math.min(Math.atan(Math.tan(fov / 2) * fh), Math.atan(Math.tan(fovH / 2) * fw))
    const distFor = (r: number): number => r / Math.sin(half)
    if (kind === 'bed') {
      const bed = new Box3(new Vector3(-bedSize / 2, -2, -bedSize / 2), new Vector3(bedSize / 2, 2, bedSize / 2))
      target = bed.getCenter(new Vector3())
      dir = cam.position.clone().sub(this.controls.target).normalize()
      d = distFor(bedSize * 0.52 * 1.08)
    } else if (kind === 'fit') {
      target = sphere.center.clone()
      dir = cam.position.clone().sub(this.controls.target).normalize()
      d = distFor(sphere.radius * 1.12)
    } else if (kind === 'iso') {
      // Product shot: three-quarter view from the front right, slightly high, model filling about 60 percent of the height.
      dir = new Vector3(0.66, 0.42, 1).normalize()
      // With overlays on the view (the Preview legend, strip and bar) the model fills more of the free area, never more than it.
      const f = this.covered ? fitDistance(cam, box, dir, 0.74 * fh, 0.84 * fw) : fitDistance(cam, box, dir, 0.6, 0.72)
      target = f.target
      d = f.distance
    } else if (kind === 'top' || kind === 'bottom') {
      target = new Vector3(0, 0, 0)
      dir = new Vector3(0, kind === 'top' ? 1 : -1, 0.0008).normalize()
      d = distFor(bedSize * 0.74)
    } else {
      const side = kind === 'back' ? [0, 0.16, -1] : kind === 'left' ? [-1, 0.16, 0] : kind === 'right' ? [1, 0.16, 0] : [0, 0.16, 1]
      target = new Vector3(0, Math.max(20, sphere.center.y), 0)
      dir = new Vector3(side[0], side[1], side[2]).normalize()
      d = distFor(bedSize * 0.62)
    }
    return { pos: target.clone().addScaledVector(dir, d), target }
  }

  /** The pose that moves the view sideways to look at `target`, keeping the angle and the distance (so the zoom level stays). */
  centerOn(target: Vector3): { pos: Vector3; target: Vector3 } {
    const delta = target.clone().sub(this.controls.target)
    return { pos: this.camera.position.clone().add(delta), target: target.clone() }
  }

  /** The pose `factor` times closer to the target (below 1 moves away), kept within the zoom limits. */
  zoomed(factor: number): { pos: Vector3; target: Vector3 } {
    const t = this.controls.target
    const off = this.camera.position.clone().sub(t)
    const d = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, off.length() / factor))
    return { pos: t.clone().add(off.setLength(d)), target: t.clone() }
  }

  go(pose: { pos: Vector3; target: Vector3 }, animate: boolean, now: number): void {
    if (!animate || reducedMotion()) {
      this.move = null
      this.camera.position.copy(pose.pos)
      this.controls.target.copy(pose.target)
      this.controls.update()
      return
    }
    this.move = { t0: now, dur: 520, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), toPos: pose.pos, toTarget: pose.target }
  }

  /** Advances an animated move. Returns true while it is running. */
  step(now: number): boolean {
    const m = this.move
    if (!m) return false
    const k = Math.min(1, (now - m.t0) / m.dur)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    this.camera.position.lerpVectors(m.fromPos, m.toPos, e)
    this.controls.target.lerpVectors(m.fromTarget, m.toTarget, e)
    if (k >= 1) this.move = null
    return true
  }

  /** Near and far hug the scene. `sceneRadius` is the radius around the target that must stay inside the planes. */
  fitClip(sceneRadius: number): boolean {
    const cam = this.camera
    const d = cam.position.distanceTo(this.controls.target)
    const near = Math.max(1, d - sceneRadius * 1.3, d * 0.08)
    const far = d + sceneRadius * 3.5
    if (Math.abs(near - cam.near) / cam.near < 0.04 && Math.abs(far - cam.far) / cam.far < 0.04) return false
    cam.near = near
    cam.far = far
    cam.updateProjectionMatrix()
    return true
  }

  /** Slides the view sideways and up by a pixel delta, at the scale of the orbit distance. `heightPx` is the canvas height. */
  panBy(dxPx: number, dyPx: number, heightPx: number): void {
    const cam = this.camera
    const dist = cam.position.distanceTo(this.controls.target)
    const perPx = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, heightPx)
    const right = new Vector3().setFromMatrixColumn(cam.matrix, 0)
    const up = new Vector3().setFromMatrixColumn(cam.matrix, 1)
    const d = right.multiplyScalar(-dxPx * perPx).addScaledVector(up, dyPx * perPx)
    cam.position.add(d)
    this.controls.target.add(d)
    this.preset = null
    this.move = null
  }

  /** Orbits by a pixel delta around the target, respecting the polar limits. `speed` is OrbitControls.rotateSpeed. */
  orbitBy(dxPx: number, dyPx: number, heightPx: number, speed: number): void {
    const t = this.controls.target
    const sph = new Spherical().setFromVector3(this.camera.position.clone().sub(t))
    const k = (2 * Math.PI * speed) / Math.max(1, heightPx)
    sph.theta -= dxPx * k
    sph.phi = Math.min(this.controls.maxPolarAngle, Math.max(this.controls.minPolarAngle, sph.phi - dyPx * k))
    this.camera.position.copy(t).add(new Vector3().setFromSpherical(sph))
    this.camera.lookAt(t)
    this.preset = null
    this.move = null
  }

  /** Moves the orbit center to the depth of `point` along the current view ray. The picture does not change; later orbits pivot at that depth. */
  retargetToDepthOf(point: Vector3): void {
    const cam = this.camera
    const fwd = cam.getWorldDirection(new Vector3())
    const d = Math.max(cam.near, point.clone().sub(cam.position).dot(fwd))
    this.controls.target.copy(cam.position).addScaledVector(fwd, d)
  }
}
