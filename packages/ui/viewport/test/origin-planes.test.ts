// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Create Sketch's origin planes: XY is the bed's plane, XZ the front and YZ the side, each a right-handed frame whose
// normal faces the side it is seen square on from; a ray finds the plane it crosses first.
import { PerspectiveCamera, Raycaster, Vector2 } from 'three'
import { describe, expect, it } from 'vitest'
import { OriginPlanes, originFrame } from '../src/originplanes'

const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]

describe('origin planes', () => {
  it('are right handed, with the normals Z up, front (-Y) and right (+X)', () => {
    const want = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] } as const
    for (const p of ['xy', 'xz', 'yz'] as const) {
      const f = originFrame(p, [10, 20, 0])
      expect(f.normal).toEqual(want[p])
      expect(cross(f.u, f.v).map((x) => x + 0)).toEqual([...f.normal])
      expect(f.origin).toEqual([10, 20, 0])
    }
  })

  it('a ray from above finds XY, one from the front finds XZ', () => {
    const planes = new OriginPlanes()
    planes.set({ center: [0, 0, 0], sizeMm: 100 })
    const ray = new Raycaster()
    const cam = new PerspectiveCamera(40, 1, 1, 10_000)
    // three's Y is up in this test's world: the group sits as built, so XY lies in z=0 and XZ in y=0
    cam.position.set(10, 15, 500)
    cam.lookAt(10, 15, 0)
    cam.updateMatrixWorld()
    ray.setFromCamera(new Vector2(0, 0), cam)
    expect(planes.at(ray)?.plane).toBe('xy')
    cam.position.set(15, -500, 20)
    cam.lookAt(15, 0, 20)
    cam.updateMatrixWorld()
    ray.setFromCamera(new Vector2(0, 0), cam)
    expect(planes.at(ray)?.plane).toBe('xz')
    expect(planes.hover('xz')).toBe(true)
    expect(planes.hover('xz')).toBe(false)
    planes.set(null)
    expect(planes.at(ray)).toBeNull()
  })
})
