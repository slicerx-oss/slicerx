// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { PerspectiveCamera, Spherical, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CameraRig } from '../src/camera'
import { SpaceDrive } from '../src/space-drive'
import { SPACE_STALE_MS, ZERO_FRAME, type SpaceFrame } from '../src/spacemouse'

const H = 800

/** A rig looking at the origin from the front right and above, as the viewport starts. */
function setup() {
  const camera = new PerspectiveCamera(30, 1.5, 1, 5000)
  camera.position.set(300, 250, 400)
  const controls = { target: new Vector3(), update: vi.fn(), minDistance: 10, maxDistance: 4000, minPolarAngle: 0, maxPolarAngle: Math.PI }
  camera.lookAt(controls.target)
  camera.updateMatrixWorld(true)
  const rig = new CameraRig(camera, controls as never)
  return { camera, controls, rig }
}

const push = (f: Partial<SpaceFrame>): SpaceFrame => ({ ...ZERO_FRAME, ...f })
const opts = (o: Partial<{ reduced: boolean; pivot: Vector3 | null }> = {}) => ({ heightPx: H, reduced: o.reduced ?? false, pivot: () => o.pivot ?? null })

/** Steps the drive every 16 ms from `t0` for `n` frames; answers the time after the last one. */
function run(d: SpaceDrive, rig: CameraRig, t0: number, n: number, o = opts()): number {
  let t = t0
  for (let i = 0; i < n; i++) {
    t += 16
    d.step(t, rig, o)
    rig.camera.updateMatrixWorld(true)
  }
  return t
}

describe('3D mouse drive', () => {
  it('does nothing while off', () => {
    const { rig, camera } = setup()
    const d = new SpaceDrive()
    const was = camera.position.clone()
    expect(d.input(push({ tx: 350 }), 0)).toBe(false)
    expect(d.step(16, rig, opts())).toBe(false)
    expect(camera.position.equals(was)).toBe(true)
  })

  it('pans while the cap is pushed right and stops when it is let go', () => {
    const { rig, camera, controls } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true })
    const right = new Vector3().setFromMatrixColumn(camera.matrix, 0)
    d.input(push({ tx: 350 }), 0)
    let t = run(d, rig, 0, 30)
    expect(d.active).toBe(true)
    // the camera slides left, so the scene goes right; the distance to the center stays
    expect(controls.target.dot(right)).toBeLessThan(-10)
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(new Vector3(300, 250, 400).length(), 3)
    d.input(ZERO_FRAME, t)
    t = run(d, rig, t, 60)
    expect(d.active).toBe(false)
    const still = controls.target.clone()
    run(d, rig, t, 5)
    expect(controls.target.equals(still)).toBe(true)
  })

  it('stops at once with reduced motion, and glides briefly without it', () => {
    const stopAfterRelease = (reduced: boolean) => {
      const { rig, controls } = setup()
      const d = new SpaceDrive()
      d.set({ enabled: true })
      d.input(push({ tx: 350 }), 0)
      let t = run(d, rig, 0, 20, opts({ reduced }))
      d.input(ZERO_FRAME, t)
      const at = controls.target.clone()
      t += 16
      d.step(t, rig, opts({ reduced }))
      return controls.target.distanceTo(at)
    }
    expect(stopAfterRelease(true)).toBe(0)
    expect(stopAfterRelease(false)).toBeGreaterThan(0)
  })

  it('zooms closer on a pull and farther on a push', () => {
    const near = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true })
    const d0 = near.camera.position.distanceTo(near.controls.target)
    d.input(push({ ty: 350 }), 0)
    run(d, near.rig, 0, 20)
    expect(near.camera.position.distanceTo(near.controls.target)).toBeLessThan(d0 * 0.9)
    const far = setup()
    const e = new SpaceDrive()
    e.set({ enabled: true })
    e.input(push({ ty: -350 }), 0)
    run(e, far.rig, 0, 20)
    expect(far.camera.position.distanceTo(far.controls.target)).toBeGreaterThan(d0 * 1.1)
  })

  it('orbits around the center on a twist, keeping the distance', () => {
    const { rig, camera, controls } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true })
    const before = new Spherical().setFromVector3(camera.position.clone().sub(controls.target))
    d.input(push({ rz: 350 }), 0)
    run(d, rig, 0, 20)
    const after = new Spherical().setFromVector3(camera.position.clone().sub(controls.target))
    expect(Math.abs(after.theta - before.theta)).toBeGreaterThan(0.2)
    expect(after.radius).toBeCloseTo(before.radius, 3)
    expect(after.phi).toBeCloseTo(before.phi, 6)
  })

  it('turns around the selection when a push starts from rest', () => {
    const { rig, camera, controls } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true })
    const pivot = new Vector3(60, 0, 0)
    const pivotSpy = vi.fn(() => pivot)
    d.input(push({ rz: 350 }), 0)
    d.step(16, rig, { heightPx: H, reduced: false, pivot: pivotSpy })
    expect(pivotSpy).toHaveBeenCalledTimes(1)
    // the orbit center moved to the selection's depth along the view ray
    const fwd = camera.getWorldDirection(new Vector3())
    expect(controls.target.clone().sub(camera.position).dot(fwd)).toBeGreaterThan(0)
    // later frames of the same push keep that center
    d.step(32, rig, { heightPx: H, reduced: false, pivot: pivotSpy })
    expect(pivotSpy).toHaveBeenCalledTimes(1)
  })

  it('takes over from a camera move under way', () => {
    const { rig } = setup()
    rig.move = { t0: 0, dur: 500, fromPos: new Vector3(), fromTarget: new Vector3(), toPos: new Vector3(1, 1, 1), toTarget: new Vector3() }
    const d = new SpaceDrive()
    d.set({ enabled: true })
    d.input(push({ tx: 350 }), 0)
    d.step(16, rig, opts())
    expect(rig.move).toBeNull()
    expect(rig.preset).toBeNull()
  })

  it('treats a cap that stopped reporting as let go', () => {
    const { rig } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true, sensitivity: 1 })
    d.input(push({ tx: 350 }), 0)
    const t = run(d, rig, 0, Math.ceil((SPACE_STALE_MS + 400) / 16), opts({ reduced: true }))
    expect(d.active).toBe(false)
    const still = rig.camera.position.clone()
    run(d, rig, t, 10, opts({ reduced: true }))
    expect(rig.camera.position.equals(still)).toBe(true)
  })

  it('stops when turned off mid push', () => {
    const { rig } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true })
    d.input(push({ tx: 350 }), 0)
    run(d, rig, 0, 5)
    expect(d.active).toBe(true)
    d.set({ enabled: false })
    expect(d.active).toBe(false)
    expect(d.step(200, rig, opts())).toBe(false)
  })

  it('keeps settings it was not given', () => {
    const d = new SpaceDrive()
    d.set({ enabled: true, invert: { panX: false, panY: false, zoom: true, tilt: false, spin: false } })
    d.set({ sensitivity: 2 })
    expect(d.settings).toMatchObject({ enabled: true, sensitivity: 2, invert: { zoom: true } })
  })

  it('keeps zoom within the limits however long it is pushed', () => {
    const { rig, camera, controls } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true, sensitivity: 4 })
    d.input(push({ ty: 350 }), 0)
    let t = 0
    for (let i = 0; i < 40; i++) {
      t = run(d, rig, t, 10)
      d.input(push({ ty: 350 }), t)
    }
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThanOrEqual(controls.minDistance - 1e-6)
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(controls.minDistance + 1)
    d.input(push({ ty: -350 }), t)
    for (let i = 0; i < 60; i++) {
      t = run(d, rig, t, 10)
      d.input(push({ ty: -350 }), t)
    }
    expect(camera.position.distanceTo(controls.target)).toBeLessThanOrEqual(controls.maxDistance + 1e-6)
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(controls.maxDistance - 1)
  })

  it('tilts the view to look down from higher up on a forward tilt, within the polar limits', () => {
    const { rig, camera, controls } = setup()
    controls.minPolarAngle = 0.2
    controls.maxPolarAngle = 1.4
    const d = new SpaceDrive()
    d.set({ enabled: true })
    const y0 = camera.position.y
    d.input(push({ rx: 350 }), 0)
    let t = run(d, rig, 0, 10)
    expect(camera.position.y).toBeGreaterThan(y0)
    for (let i = 0; i < 30; i++) {
      d.input(push({ rx: 350 }), t)
      t = run(d, rig, t, 10)
    }
    const top = new Spherical().setFromVector3(camera.position.clone().sub(controls.target))
    expect(top.phi).toBeGreaterThanOrEqual(0.2 - 1e-6)
    expect(top.phi).toBeLessThan(0.21)
    for (let i = 0; i < 40; i++) {
      d.input(push({ rx: -350 }), t)
      t = run(d, rig, t, 10)
    }
    expect(new Spherical().setFromVector3(camera.position.clone().sub(controls.target)).phi).toBeLessThanOrEqual(1.4 + 1e-6)
  })

  it('raises the scene on a lift: the view moves down', () => {
    const { rig, camera, controls } = setup()
    const d = new SpaceDrive()
    d.set({ enabled: true })
    const up = new Vector3().setFromMatrixColumn(camera.matrix, 1)
    const before = controls.target.dot(up)
    // a lift is negative Z, which points down
    d.input(push({ tz: -350 }), 0)
    run(d, rig, 0, 20)
    expect(controls.target.dot(up)).toBeLessThan(before - 10)
  })
})
