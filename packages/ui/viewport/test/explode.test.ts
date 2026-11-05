// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exploded view: the offset math (one function for the view, the app link and the picture tools) and the scene side,
// which moves only the part meshes inside their object's group.
import { Matrix4, MeshBasicMaterial, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { explodeOffsets, type PartBox } from '@slicerx/contracts/explode'
import { applyExplode } from '../src/explode'
import { buildObject } from '../src/model'
import type { ViewportPart } from '../src/types'

const box = (min: [number, number, number], max: [number, number, number]): PartBox => ({ min, max })
const overlap = (a: PartBox, oa: number[], b: PartBox, ob: number[], k: number) => a.min[k]! + oa[k]! < b.max[k]! + ob[k]! && b.min[k]! + ob[k]! < a.max[k]! + oa[k]!

describe('explode offsets', () => {
  const pair = [box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10])]

  it('leaves every part home at 0 percent and for a single part', () => {
    expect(explodeOffsets(pair, 0, 'radial')).toEqual([[0, 0, 0], [0, 0, 0]])
    expect(explodeOffsets([pair[0]!], 80, 'x')).toEqual([[0, 0, 0]])
  })

  it('moves two side by side parts apart along their line, the same distance each, radially', () => {
    const [a, b] = explodeOffsets(pair, 60, 'radial')
    expect(a![0]).toBeLessThan(0)
    expect(b![0]).toBeCloseTo(-a![0])
    expect(a![1]).toBeCloseTo(0)
    expect(a![2]).toBeCloseTo(0)
  })

  it('grows with the spread and stops at 100 percent', () => {
    const at = (s: number) => explodeOffsets(pair, s, 'radial')[1]![0]
    expect(at(30)).toBeLessThan(at(60))
    expect(at(60)).toBeLessThan(at(100))
    expect(at(250)).toBeCloseTo(at(100))
    expect(at(Number.NaN)).toBe(0)
  })

  it('never takes a part below the lowest point radially', () => {
    const stack = [box([0, 0, 0], [10, 10, 4]), box([0, 0, 4], [10, 10, 8]), box([0, 0, 8], [10, 10, 12])]
    const o = explodeOffsets(stack, 100, 'radial')
    for (let i = 0; i < stack.length; i++) expect(stack[i]!.min[2] + o[i]![2]).toBeGreaterThanOrEqual(-1e-9)
    // and the stack is further apart than it was
    expect(o[2]![2] - o[0]![2]).toBeGreaterThan(0)
  })

  it('on z keeps the lowest part and lifts the rest in order, clear of each other at full spread', () => {
    const stack = [box([0, 0, 8], [10, 10, 12]), box([0, 0, 0], [10, 10, 4]), box([0, 0, 4], [10, 10, 8])]
    const o = explodeOffsets(stack, 100, 'z')
    expect(o[1]).toEqual([0, 0, 0])
    expect(o[2]![2]).toBeGreaterThan(0)
    expect(o[0]![2]).toBeGreaterThan(o[2]![2])
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) expect(overlap(stack[i]!, o[i]!, stack[j]!, o[j]!, 2)).toBe(false)
  })

  it('on x spreads from the middle part, only along x, with parts that overlapped now clear', () => {
    const nested = [box([0, 0, 0], [30, 10, 10]), box([5, 0, 0], [25, 10, 10]), box([10, 0, 0], [20, 10, 10])]
    const o = explodeOffsets(nested, 100, 'x')
    for (const v of o) expect([v[1], v[2]]).toEqual([0, 0])
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) expect(overlap(nested[i]!, o[i]!, nested[j]!, o[j]!, 0)).toBe(false)
    // the middle of three parts stays
    expect(o.filter((v) => v[0] === 0)).toHaveLength(1)
  })
})

const cube = (x: number): ViewportPart => ({
  name: `p${x}`,
  color: '#ff0000',
  positions: new Float32Array([x, 0, 0, x + 10, 0, 0, x + 10, 10, 0, x, 10, 0, x, 0, 10, x + 10, 0, 10, x + 10, 10, 10, x, 10, 10]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
})

describe('the exploded view in the scene', () => {
  const mat = new MeshBasicMaterial()

  it('moves the part meshes, not the object, and puts them back at 0', () => {
    const t = new Matrix4().makeTranslation(50, 50, 0)
    const e = buildObject({ id: 'a', name: 'a', parts: [cube(0), cube(10)], transform: t.toArray() }, () => mat, mat)
    const before = e.group.matrix.clone()
    const o = applyExplode(e, 60, 'x')
    expect(e.group.matrix.equals(before)).toBe(true)
    expect(e.parts[0]!.mesh.position.x).toBeCloseTo(o[0]![0])
    expect(e.parts[1]!.mesh.position.x).toBeGreaterThan(0)
    applyExplode(e, 0, 'x')
    for (const p of e.parts) expect(p.mesh.position.lengthSq()).toBe(0)
  })

  it('spreads a turned object along the bed axis', () => {
    // a quarter turn about Z: the object's own X runs along the bed's Y
    const t = new Matrix4().makeRotationZ(Math.PI / 2)
    const e = buildObject({ id: 'a', name: 'a', parts: [cube(0), cube(10)], transform: t.toArray() }, () => mat, mat)
    applyExplode(e, 100, 'z')
    e.group.updateMatrixWorld(true)
    const lifted = new Vector3().setFromMatrixPosition(e.parts[1]!.mesh.matrixWorld)
    const home = new Vector3().setFromMatrixPosition(e.parts[0]!.mesh.matrixWorld)
    expect(lifted.z - home.z).toBeGreaterThan(0)
    expect(lifted.x - home.x).toBeCloseTo(0)
    expect(lifted.y - home.y).toBeCloseTo(0)
  })
})
