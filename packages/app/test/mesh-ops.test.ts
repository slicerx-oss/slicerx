// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { MeshPart } from '@slicerx/contracts'
import { bake, boxMesh, components, cylinderMesh, invert, mergeParts, primitive, sphereMesh, splitToObjects } from '../src/plate/mesh-ops'
import { apply, bounds, compose, multiply, sizeOf } from '../src/plate/transform'

/** Signed volume; positive when triangles face outward. */
function volume(p: MeshPart): number {
  let v = 0
  const x = p.positions
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const [a, b, c] = [p.indices[t]! * 3, p.indices[t + 1]! * 3, p.indices[t + 2]! * 3]
    v += (x[a]! * (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!) - x[a + 1]! * (x[b]! * x[c + 2]! - x[b + 2]! * x[c]!) + x[a + 2]! * (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!)) / 6
  }
  return v
}

function shifted(p: MeshPart, dx: number): MeshPart {
  return bake(p, compose({ position: [dx, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }))
}

function joined(a: MeshPart, b: MeshPart): MeshPart {
  const off = a.positions.length / 3
  return { name: 'two', slot: 1, positions: new Float32Array([...a.positions, ...b.positions]), indices: new Uint32Array([...a.indices, ...[...b.indices].map((i) => i + off)]) }
}

describe('mesh operations', () => {
  it('primitives are closed, outward and stand on the bed', () => {
    expect(volume(boxMesh(10, 20, 30))).toBeCloseTo(6000)
    expect(volume(cylinderMesh(20, 10, 96))).toBeCloseTo(Math.PI * 100 * 10, -1)
    // Tessellation loses a little volume; within half a percent.
    expect(Math.abs(volume(sphereMesh(20, 48, 96)) / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.005)
    expect(volume(primitive('cone'))).toBeGreaterThan(0)
    for (const s of ['box', 'cylinder', 'sphere', 'cone'] as const) expect(bounds([primitive(s)], compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }))!.min[2]).toBeCloseTo(0)
  })

  it('finds connected pieces, biggest first', () => {
    const two = joined(boxMesh(10, 10, 10), shifted(boxMesh(4, 4, 4), 30))
    const parts = components(two)
    expect(parts).toHaveLength(2)
    expect(volume(parts[0]!)).toBeCloseTo(1000)
    expect(volume(parts[1]!)).toBeCloseTo(64)
    expect(components(boxMesh(5, 5, 5))).toHaveLength(1)
  })

  it('split to objects leaves each piece where it was', () => {
    const t = compose({ position: [100, 100, 0], rotation: [0, 0, 30], scale: [1, 1, 1] })
    const two = joined(boxMesh(10, 10, 10), shifted(boxMesh(4, 4, 4), 30))
    const pieces = splitToObjects([two], t)
    expect(pieces).toHaveLength(2)
    const before = bounds(components(two).slice(1), t)!
    const after = bounds(pieces[1]!.parts, pieces[1]!.transform)!
    before.min.forEach((v, i) => expect(after.min[i]).toBeCloseTo(v))
  })

  it('merge keeps every part where it was, in the first object frame', () => {
    const a = { parts: [boxMesh(10, 10, 10)], transform: compose({ position: [50, 50, 0], rotation: [0, 0, 45], scale: [1, 1, 1] }) }
    const b = { parts: [boxMesh(6, 6, 6)], transform: compose({ position: [90, 50, 0], rotation: [0, 0, 0], scale: [2, 1, 1] }) }
    const merged = mergeParts([a, b])
    expect(merged).toHaveLength(2)
    const want = bounds(b.parts, b.transform)!
    const got = bounds([merged[1]!], a.transform)!
    want.min.forEach((v, i) => expect(got.min[i]).toBeCloseTo(v, 3))
    expect(sizeOf(got)[0]).toBeCloseTo(12, 3)
  })

  it('inverts affine transforms and keeps mirrored parts outward', () => {
    const m = compose({ position: [5, -3, 2], rotation: [10, 20, 30], scale: [2, 0.5, 1.5] })
    const p = apply(multiply(invert(m), m), [1, 2, 3])
    p.forEach((v, i) => expect(v).toBeCloseTo([1, 2, 3][i]!))
    const mirrored = bake(boxMesh(10, 10, 10), compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [-1, 1, 1] }))
    expect(volume(mirrored)).toBeCloseTo(1000)
  })
})
