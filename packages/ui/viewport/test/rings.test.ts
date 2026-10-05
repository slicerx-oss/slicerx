// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { CutPreview, extentAlong, movePlane, tiltAxes } from '../src/cutplane'
import { BAMBU_GIZMO, ORCA_GIZMO, PRUSA_GIZMO, withGizmoOverrides } from '../src/gizmobindings'
import type { ObjectEntry } from '../src/model'
import { RingSet, angleAround, pickRing, rayPlane, ringAxes, ringDistance, rotateAbout, snapAngle, turnVector, unwrapAngle } from '../src/rings'
import type { V3 } from '../src/scaling'

const DEG = Math.PI / 180
const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? NaN, -Math.log10(eps)))

describe('rotate ring math', () => {
  it('measures the signed turn about an axis', () => {
    expect(angleAround([1, 0, 0], [0, 1, 0], [0, 0, 1])).toBeCloseTo(90 * DEG)
    expect(angleAround([1, 0, 0], [0, 1, 0], [0, 0, -1])).toBeCloseTo(-90 * DEG)
    // Out of plane parts do not count.
    expect(angleAround([1, 0, 5], [1, 1, -3], [0, 0, 1])).toBeCloseTo(45 * DEG)
  })

  it('keeps a drag going past half a turn', () => {
    let a = 0
    for (const deg of [60, 120, 170, -170, -100, -10]) a = unwrapAngle(a, deg * DEG)
    expect(a / DEG).toBeCloseTo(350)
  })

  it('snaps to 15 degree steps', () => {
    expect(snapAngle(22 * DEG, 15) / DEG).toBeCloseTo(15)
    expect(snapAngle(23 * DEG, 15) / DEG).toBeCloseTo(30)
    expect(snapAngle(-8 * DEG, 15) / DEG).toBeCloseTo(-15)
    expect(snapAngle(0.3, 0)).toBe(0.3)
  })

  it('picks the ring under the cursor, also a ring seen edge on', () => {
    const c: V3 = [100, 100, 10]
    const axes = [
      { id: 'x' as const, axis: [1, 0, 0] as V3 },
      { id: 'y' as const, axis: [0, 1, 0] as V3 },
      { id: 'z' as const, axis: [0, 0, 1] as V3 },
    ]
    // Straight down onto the z ring (radius 20) at 45 degrees, away from where the x and y rings cross it.
    expect(pickRing([100 + 20 * Math.SQRT1_2, 100 - 20 * Math.SQRT1_2, 200], [0, 0, -1], c, axes, 20, 1)).toBe('z')
    // From the side along x: the x ring faces the camera, the z ring is a line through the center seen edge on.
    expect(pickRing([300, 100, 30], [-1, 0, 0], c, axes, 20, 1)).toBe('x')
    expect(pickRing([300, 100, 10.5], [-1, 0, 0], c, [axes[2]!], 20, 1)).toBe('z')
    expect(pickRing([300, 100, 50], [-1, 0, 0], c, axes, 20, 1)).toBeNull()
    expect(ringDistance([100, 80, 200], [0, 0, -1], c, [0, 0, 1], 20).dist).toBeLessThan(0.1)
  })

  it('turns a transform about a line through the box center', () => {
    const m = new Matrix4().makeTranslation(10, 0, 0).toArray()
    const r = rotateAbout(m, [10, 5, 0], [0, 0, 1], 90 * DEG)
    close(new Vector3(0, 0, 0).applyMatrix4(new Matrix4().fromArray(r)).toArray(), [15, 5, 0])
    close(turnVector([1, 0, 0], [0, 0, 1], 90 * DEG), [0, 1, 0])
  })

  it('gives the bed axes in world space and the model axes in local space', () => {
    const m = new Matrix4().makeRotationZ(30 * DEG).scale(new Vector3(2, 3, 4)).setPosition(5, 6, 7).toArray()
    expect(ringAxes(m, 'world').z).toEqual([0, 0, 1])
    const l = ringAxes(m, 'local')
    close(l.x, [Math.cos(30 * DEG), Math.sin(30 * DEG), 0])
    close(l.z, [0, 0, 1])
    // A mirrored model still gets a right handed set of rings.
    const mirrored = ringAxes(new Matrix4().makeScale(-1, 1, 1).toArray(), 'local')
    close(mirrored.z, [0, 0, -1])
  })

  it('finds where a ray meets a ring plane', () => {
    close(rayPlane([0, 0, 10], [0, 0, -1], [0, 0, 2], [0, 0, 1])!, [0, 0, 2])
    expect(rayPlane([0, 0, 10], [1, 0, 0], [0, 0, 2], [0, 0, 1])).toBeNull()
  })

  it('draws the swept sector one triangle per degree', () => {
    const rings = new RingSet(['x', 'y', 'z'] as const)
    rings.sweep([0, 0, 0], [0, 0, 1], [1, 0, 0], -45.2 * DEG, 10)
    const fan = rings.group.children.find((c) => (c as Mesh).geometry?.drawRange.count !== Infinity) as Mesh
    expect(fan.visible).toBe(true)
    expect(fan.geometry.drawRange.count).toBe(46 * 3)
    // A negative sweep starts where it ends, so its first edge points at -45.2 degrees.
    const first = new Vector3(1, 0, 0).applyQuaternion(fan.quaternion)
    expect(Math.atan2(first.y, first.x) / DEG).toBeCloseTo(-45.2)
    rings.setActive(null)
    expect(fan.visible).toBe(false)
    rings.dispose()
  })
})

describe('rotate snap key per look', () => {
  it('snaps with Shift on every look and can be changed in Settings', () => {
    for (const g of [BAMBU_GIZMO, ORCA_GIZMO, PRUSA_GIZMO]) expect(g.rotate).toEqual({ snapKey: 'shift', snapStepDeg: 15 })
    expect(withGizmoOverrides(BAMBU_GIZMO, { rotate: { snapKey: 'alt' } }).rotate).toEqual({ snapKey: 'alt', snapStepDeg: 15 })
  })
})

describe('cut plane', () => {
  it('measures a box along the normal and keeps a moved plane inside it', () => {
    const m = new Matrix4().makeTranslation(50, 50, 0).toArray()
    const ext = extentAlong([-10, -10, 0], [10, 10, 30], m, [50, 50, 15], [0, 0, 1])
    close(ext, [-15, 15])
    close(movePlane([50, 50, 15], [0, 0, 1], 40, ext), [50, 50, 30])
    close(movePlane([50, 50, 15], [0, 0, 1], -4, ext), [50, 50, 11])
  })

  it('tilts about two axes square to the normal', () => {
    const { u, v } = tiltAxes([0, 0, 1])
    expect(Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2])).toBeLessThan(1e-9)
    expect(Math.abs(u[2])).toBeLessThan(1e-9)
    expect(Math.abs(v[2])).toBeLessThan(1e-9)
  })

  it('clips the model at the plane and gives the materials back when it ends', () => {
    const base = new MeshStandardMaterial()
    base.onBeforeCompile = () => {}
    const mesh = new Mesh(new BoxGeometry(10, 10, 10), base)
    const entry = { id: 'a', group: new Group(), parts: [{ mesh }] } as unknown as ObjectEntry
    const preview = new CutPreview()
    preview.attach(entry, 'below')
    expect(mesh.material).not.toBe(base)
    expect((mesh.material as MeshStandardMaterial).onBeforeCompile).toBe(base.onBeforeCompile)
    const upper = mesh.children[0] as Mesh
    expect(upper.geometry).toBe(mesh.geometry)
    // The dropped upper side draws faint.
    expect((upper.material as MeshStandardMaterial).opacity).toBeLessThan(0.5)
    preview.setPlane([0, 0, 2], [0, 0, 1], new Matrix4())
    const below = (mesh.material as MeshStandardMaterial).clippingPlanes![0]!
    const above = (upper.material as MeshStandardMaterial).clippingPlanes![0]!
    // three.js keeps the positive side: the lower part below z 2, the upper part above it.
    expect(below.distanceToPoint(new Vector3(0, 0, 0))).toBeGreaterThan(0)
    expect(above.distanceToPoint(new Vector3(0, 0, 5))).toBeGreaterThan(0)
    preview.detach()
    expect(mesh.material).toBe(base)
    expect(mesh.children).toHaveLength(0)
    expect(preview.entry).toBeNull()
  })
})
