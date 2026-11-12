// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exact corner normals (MeshPart.normals) through the app's own mesh edits: a rigid move turns them with the triangles,
// a mirror also swaps the corners its winding swaps, a stretch drops them, a split keeps each piece's, and the engine
// mesh shape carries them both ways. Never a normal that no longer fits its triangle.
import { describe, expect, it } from 'vitest'
import { NO_NORMAL, packNormals, unpackNormal, type MeshPart } from '@slicerx/contracts'
import { bake, components, movedNormals } from '../src/plate/mesh-ops'
import { clonePartMesh } from '../src/plate/parts'
import { compose } from '../src/plate/transform'
import { fromGeom, toGeom } from '../src/geom/client'

/** A tetrahedron wound outward, with offset `o` along X. */
function tetra(o = 0): { positions: number[]; indices: number[] } {
  return { positions: [o, 0, 0, o + 10, 0, 0, o, 10, 0, o, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
}

function faceNormal(p: ArrayLike<number>, ix: ArrayLike<number>, t: number): [number, number, number] {
  const a = ix[3 * t]! * 3, b = ix[3 * t + 1]! * 3, c = ix[3 * t + 2]! * 3
  const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!]
  const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!]
  const n: [number, number, number] = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
  const l = Math.hypot(...n)
  return [n[0] / l, n[1] / l, n[2] / l]
}

/** A flat-faced part whose exact corner normals are its face normals. */
function part(m = tetra()): MeshPart {
  const corners: number[] = []
  for (let t = 0; t < m.indices.length / 3; t++) for (let j = 0; j < 3; j++) corners.push(...faceNormal(m.positions, m.indices, t))
  return { name: 'p', slot: 1, positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices), normals: packNormals(corners) }
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  return (Math.acos(Math.min(1, Math.max(-1, d / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!))))) * 180) / Math.PI
}

/** Every exact corner of the part agrees with its triangle's face normal, as it did before the edit. */
function fits(p: MeshPart): void {
  expect(p.normals).toBeDefined()
  expect(p.normals!.length).toBe(p.indices.length * 2)
  const n = [0, 0, 0]
  for (let t = 0; t < p.indices.length / 3; t++) {
    for (let j = 0; j < 3; j++) {
      if (!unpackNormal(p.normals!, 6 * t + 2 * j, n, 0)) continue
      expect(angleDeg(n, faceNormal(p.positions, p.indices, t))).toBeLessThan(0.02)
    }
  }
}

describe('exact normals through app mesh edits', () => {
  it('a plain move keeps the very buffer', () => {
    const p = part()
    const moved = bake(p, compose({ position: [5, -3, 2], rotation: [0, 0, 0], scale: [1, 1, 1] }))
    expect(moved.normals).toBe(p.normals)
  })

  it('a rotation turns them with the triangles', () => {
    const moved = bake(part(), compose({ position: [1, 2, 3], rotation: [30, 45, 70], scale: [1, 1, 1] }))
    fits(moved)
  })

  it('a mirror turns them and swaps the corners its winding swaps', () => {
    const p = part()
    // one corner left out, to see it move with its corner
    p.normals!.fill(NO_NORMAL, 2, 4)
    const moved = bake(p, compose({ position: [0, 0, 0], rotation: [0, 0, 20], scale: [-1, 1, 1] }))
    fits(moved)
    expect(Array.from(moved.normals!.slice(4, 6))).toEqual([NO_NORMAL, NO_NORMAL])
    expect(Array.from(moved.normals!.slice(2, 4))).not.toEqual([NO_NORMAL, NO_NORMAL])
  })

  it('a stretch, or a scale, drops them', () => {
    expect(bake(part(), compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] })).normals).toBeUndefined()
    expect(bake(part(), compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] })).normals).toBeUndefined()
  })

  it('drops a buffer that belongs to other triangles', () => {
    const p = part()
    expect(bake({ ...p, normals: p.normals!.slice(6) }, compose({ position: [0, 0, 0], rotation: [0, 0, 90], scale: [1, 1, 1] })).normals).toBeUndefined()
  })

  it('turns no-normal corners into no-normal corners', () => {
    const none = new Int16Array(12).fill(NO_NORMAL)
    expect(Array.from(movedNormals(none, compose({ position: [0, 0, 0], rotation: [10, 20, 30], scale: [1, 1, 1] }))!)).toEqual(Array.from(none))
  })

  it('a clone keeps them, moved beside the part', () => {
    const p = part()
    const c = clonePartMesh(p, 'copy')
    expect(c.normals).toBe(p.normals)
    fits(c)
  })

  it('split into pieces, each piece keeps its own triangles\' normals', () => {
    const a = tetra(), b = tetra(30)
    const both = { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + 4)] }
    const pieces = components(part(both))
    expect(pieces).toHaveLength(2)
    for (const piece of pieces) {
      expect(piece.normals).toHaveLength(piece.indices.length * 2)
      fits(piece)
    }
  })

  it('the engine mesh shape carries them both ways, and leaves out a buffer of the wrong length', () => {
    const p = part()
    const g = toGeom(p)
    expect(g.normals).toEqual(Array.from(p.normals!))
    const back = fromGeom(g, 'p', 1)
    expect(Array.from(back.normals!)).toEqual(Array.from(p.normals!))
    const typed = fromGeom({ positions: p.positions, indices: p.indices, normals: p.normals! }, 'p', 1)
    expect(typed.normals).toBe(p.normals)
    expect(fromGeom({ ...g, normals: g.normals!.slice(2) }, 'p', 1).normals).toBeUndefined()
    expect(toGeom({ ...p, normals: p.normals!.slice(6) }).normals).toBeUndefined()
    expect('normals' in toGeom({ positions: p.positions, indices: p.indices })).toBe(false)
  })
})
