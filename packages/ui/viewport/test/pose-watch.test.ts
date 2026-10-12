// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A camera parked on the controls' distance limit is still: OrbitControls reports a change on every update there,
// and the view must not take that for motion and redraw forever.
import { PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { describe, expect, it } from 'vitest'
import { PoseWatch } from '../src/camera'

/** Enough of an element for OrbitControls to attach to; the test drives it with update() alone. */
function element(): HTMLElement {
  const target = { addEventListener() {}, removeEventListener() {} }
  return { ...target, style: {}, getRootNode: () => target, ownerDocument: target } as unknown as HTMLElement
}

describe('PoseWatch', () => {
  it('sees no motion at the distance limit, where OrbitControls keeps reporting a change', () => {
    const camera = new PerspectiveCamera(30, 390 / 844, 1, 10000)
    const controls = new OrbitControls(camera, element())
    controls.enableDamping = true
    controls.maxDistance = 1500
    controls.target.set(0, 30.01, 0)
    // Views framed right at the limit, as a narrow phone view frames the plate. In some directions rounding leaves
    // the radius a hair past 1500 every time, so each update clamps it and calls that a change.
    let stuck = 0
    for (let i = 0; i < 400; i++) {
      camera.position.setFromSphericalCoords(1500, 0.4 + (i % 37) * 0.02, i * 0.0157).add(controls.target)
      controls.update()
      const watch = new PoseWatch()
      watch.moved(camera, controls.target)
      let reported = 0
      let moved = 0
      for (let k = 0; k < 5; k++) {
        if (controls.update()) reported++
        if (watch.moved(camera, controls.target)) moved++
      }
      if (reported === 5) stuck++
      expect(moved).toBe(0)
    }
    expect(stuck).toBeGreaterThan(0)
  })

  it('sees a real orbit, pan or zoom', () => {
    const camera = new PerspectiveCamera(30, 1, 1, 10000)
    camera.position.set(0, -400, 300)
    const target = new Vector3(0, 0, 0)
    camera.lookAt(target)
    const watch = new PoseWatch()
    expect(watch.moved(camera, target)).toBe(true)
    expect(watch.moved(camera, target)).toBe(false)
    camera.position.x += 0.01
    expect(watch.moved(camera, target)).toBe(true)
    target.y += 0.01
    expect(watch.moved(camera, target)).toBe(true)
    camera.zoom = 1.5
    expect(watch.moved(camera, target)).toBe(true)
    camera.rotateZ(0.01)
    expect(watch.moved(camera, target)).toBe(true)
    expect(watch.moved(camera, target)).toBe(false)
  })
})
