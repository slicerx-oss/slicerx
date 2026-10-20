// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { PerspectiveCamera, Vector3 } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CameraRig } from '../src/camera'

function rig() {
  const camera = new PerspectiveCamera(30, 1, 1, 1000)
  camera.position.set(100, 80, 100)
  const controls = { target: new Vector3(0, 0, 0), update: vi.fn() }
  return { r: new CameraRig(camera, controls as never), camera, controls }
}

afterEach(() => vi.unstubAllGlobals())

describe('focusing a point', () => {
  it('slides the view to the point and keeps the angle and the distance', () => {
    const { r, camera, controls } = rig()
    const before = camera.position.distanceTo(controls.target)
    const pose = r.centerOn(new Vector3(30, 5, -20))
    expect(pose.target.toArray()).toEqual([30, 5, -20])
    expect(pose.pos.clone().sub(pose.target).toArray()).toEqual([100, 80, 100])
    expect(pose.pos.distanceTo(pose.target)).toBeCloseTo(before)
  })

  it('jumps when reduced motion is on, and eases otherwise', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const a = rig()
    a.r.go(a.r.centerOn(new Vector3(10, 0, 0)), true, 0)
    expect(a.r.move).toBeNull()
    expect(a.controls.target.x).toBe(10)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const b = rig()
    b.r.go(b.r.centerOn(new Vector3(10, 0, 0)), true, 0)
    expect(b.r.move).not.toBeNull()
    expect(b.controls.target.x).toBe(0)
    b.r.step(260)
    expect(b.controls.target.x).toBeGreaterThan(0)
    expect(b.controls.target.x).toBeLessThan(10)
    b.r.step(600)
    expect(b.controls.target.x).toBe(10)
  })
})

describe('a bed of another size', () => {
  // A 330 by 320 mm bed to a 256 mm one: the stage centers both on the origin, and the bed's Y runs along the world's
  // -Z, so a bed point moves by (37, 0, -32).
  const shift = new Vector3(37, 0, -32)

  it('keeps the view on the part it framed', () => {
    const { r, camera, controls } = rig()
    r.preset = 'iso'
    expect(r.followBed(shift)).toBe(true)
    expect(controls.target.toArray()).toEqual([37, 0, -32])
    expect(camera.position.toArray()).toEqual([137, 80, 68])
    expect(controls.update).toHaveBeenCalled()
  })

  it('ends a move under way on the same spot of the bed', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const { r, controls } = rig()
    r.go(r.centerOn(new Vector3(10, 0, 0)), true, 0)
    r.preset = null
    r.followBed(shift)
    r.step(600)
    expect(controls.target.toArray()).toEqual([47, 0, -32])
  })

  it('leaves a view of the whole bed centered on the new bed', () => {
    const { r, camera, controls } = rig()
    r.preset = 'plate'
    expect(r.followBed(shift)).toBe(false)
    expect(controls.target.toArray()).toEqual([0, 0, 0])
    expect(camera.position.toArray()).toEqual([100, 80, 100])
  })

  it('does nothing when the bed stays where it was', () => {
    const { r, controls } = rig()
    expect(r.followBed(new Vector3())).toBe(false)
    expect(controls.update).not.toHaveBeenCalled()
  })
})
