// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two exact faces shade smooth or hard along each run of their join at once (creasedArrays with face ids): a run is
// smooth when the angle between them, averaged along it by length, is under CREASE_DEG, and a run ends where they part
// by more than twice that, a real fold. A join whose angle wanders about the crease angle then draws whole one way, not
// in dashes, and a fold is drawn wherever it is past twice the angle. Read on joins from real designs (the chine hull in
// exact-hull.json, the stem of a hull's bottom in stem-fold.json, a hull's keel in keel.json: the two faces' triangles
// along the join, as the kernel tessellated them) and on a join drawn to be smooth in one stretch and a fold in another.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packNormals } from '@slicerx/contracts'
import { CREASE_DEG, featureEdges, weldVertices } from '../src/mesh-math'

interface Recorded {
  positions: number[]
  indices: number[]
  normals: number[]
  faceIds: number[]
}

/** Each edge between two faces, by its welded ends: its faces and the x it spans; and whether the edge lines draw it. */
function joins(P: Float32Array, I: Uint32Array, faceIds: ArrayLike<number>, out: Float32Array): { faces: string; x0: number; x1: number; drawn: boolean }[] {
  const { map } = weldVertices(P, 1e4)
  const id = new Map<string, number>()
  for (let i = 0; i < P.length / 3; i++) id.set([P[3 * i], P[3 * i + 1], P[3 * i + 2]].join(','), map[i]!)
  const drawn = new Set<string>()
  for (let s = 0; s < out.length; s += 6) {
    const a = id.get(Array.from(out.subarray(s, s + 3)).join(','))!, b = id.get(Array.from(out.subarray(s + 3, s + 6)).join(','))!
    drawn.add(a < b ? `${a}-${b}` : `${b}-${a}`)
  }
  const at = new Map<string, number[]>()
  for (let k = 0; k < I.length; k++) {
    const a = map[I[k]!]!, b = map[I[3 * ((k / 3) | 0) + ((k % 3) + 1) % 3]!]!
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    at.set(key, [...(at.get(key) ?? []), k])
  }
  const res: { faces: string; x0: number; x1: number; drawn: boolean }[] = []
  for (const [key, c] of at) {
    if (c.length !== 2) continue
    const [fa, fb] = [faceIds[(c[0]! / 3) | 0]!, faceIds[(c[1]! / 3) | 0]!]
    if (fa === fb) continue
    const xa = P[3 * I[c[0]!]!]!, xb = P[3 * I[3 * ((c[0]! / 3) | 0) + ((c[0]! % 3) + 1) % 3]!]!
    res.push({ faces: fa < fb ? `${fa}-${fb}` : `${fb}-${fa}`, x0: Math.min(xa, xb), x1: Math.max(xa, xb), drawn: drawn.has(key) })
  }
  return res.sort((a, b) => a.x0 - b.x0)
}

function recorded(name: string): { P: Float32Array; I: Uint32Array; exact: { normals: Int16Array; faceIds: Uint32Array } } {
  const rec = JSON.parse(readFileSync(join(__dirname, name), 'utf8')) as Recorded
  return { P: new Float32Array(rec.positions), I: new Uint32Array(rec.indices), exact: { normals: new Int16Array(rec.normals), faceIds: Uint32Array.from(rec.faceIds) } }
}

/** The unit normal turned `deg` from +z toward -y, about the x axis. */
const tilt = (deg: number): number[] => [0, -Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)]

/**
 * A join along the x axis from 0 to `folds.length - 1`, mm, between a flat face on +y (face 0, facing +z) and a face on
 * -y (face 1) whose kernel normal at the join's vertex at x = i is turned `folds[i]` degrees from the first face's.
 */
function strip(folds: number[]): { P: Float32Array; I: Uint32Array; exact: { normals: Int16Array; faceIds: Uint32Array } } {
  const pos: number[] = []
  for (let i = 0; i < folds.length; i++) pos.push(i, 0, 0)
  const idx: number[] = []
  const nor: number[] = []
  const ids: number[] = []
  for (let i = 0; i + 1 < folds.length; i++) {
    const top = pos.length / 3
    pos.push(i + 0.5, 1, 0, i + 0.5, -1, 0)
    idx.push(i, i + 1, top, i + 1, i, top + 1)
    nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1, ...tilt(folds[i + 1]!), ...tilt(folds[i]!), ...tilt((folds[i]! + folds[i + 1]!) / 2))
    ids.push(0, 1)
  }
  return { P: new Float32Array(pos), I: new Uint32Array(idx), exact: { normals: packNormals(nor), faceIds: new Uint32Array(ids) } }
}

describe('a join between two exact faces', () => {
  it('on the chine hull: the bow, where the chine runs at about 40 degrees, draws no piece of line on its own', () => {
    const { P, I, exact } = recorded('exact-hull.json')
    const all = joins(P, I, exact.faceIds, featureEdges(P, I, 38, exact))
    // the two chines from x 200 to 208.5, at 39.5 to 40.7 degrees: the rest of each chine is under 40 and smooth
    const bow = all.filter((j) => (j.faces === '1-2' || j.faces === '4-5') && j.x1 > 200.3 && j.x0 < 208.5)
    expect(bow.length).toBe(14)
    expect(bow.filter((j) => j.drawn)).toEqual([])
    expect(all.filter((j) => (j.faces === '1-2' || j.faces === '4-5') && j.drawn)).toEqual([])
  })

  it('on the stem of a hull bottom: the fold is drawn where it is past twice the crease angle, out to the stem', () => {
    const { P, I, exact } = recorded('stem-fold.json')
    const all = joins(P, I, exact.faceIds, featureEdges(P, I, 38, exact))
    // the bottom's two halves meet flat along the keel and fold up to 175 degrees into the stem from x 184.6 (past 80)
    expect(2 * CREASE_DEG).toBe(80)
    const fold = all.filter((j) => j.x0 >= 184.5)
    expect(fold.length).toBe(10)
    expect(fold.filter((j) => !j.drawn)).toEqual([])
    expect(all.filter((j) => j.x1 <= 182).filter((j) => j.drawn)).toEqual([])
  })

  it('on a hull keel at 38.8 to 39.8 degrees, against the 40 of the crease angle: drawn whole one way, not in dashes', () => {
    const { P, I, exact } = recorded('keel.json')
    const all = joins(P, I, exact.faceIds, featureEdges(P, I, 38, exact))
        expect(all.length).toBe(69)
    expect(all.filter((j) => !j.drawn)).toEqual([])
  })

  it('smooth in one stretch and a fold in another: drawn along the fold only', () => {
    // 33 and 45 degrees in turn (39 on average, the 45s past the crease angle) from x 0 to 10, then 100 to x 20
    const folds = [...Array.from({ length: 11 }, (_, i) => (i % 2 ? 45 : 33)), ...Array.from({ length: 10 }, () => 100)]
    const { P, I, exact } = strip(folds)
    const all = joins(P, I, exact.faceIds, featureEdges(P, I, 38, exact))
    expect(all.length).toBe(20)
    expect(all.filter((j) => j.x1 <= 10 && j.drawn)).toEqual([])
    expect(all.filter((j) => j.x0 >= 10 && !j.drawn)).toEqual([])
  })
})
